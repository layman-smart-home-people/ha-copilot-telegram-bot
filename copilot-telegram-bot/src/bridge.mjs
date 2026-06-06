// ============================================================
// Bridge — Telegram ↔ Copilot ACP Orchestrator
// ============================================================
// Handles message routing, typing indicators, tool call bubbles,
// file attachments, and session lifecycle.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "./formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { normalizeModeId } from "./acp.mjs";
import { ButtonManager } from "./buttons.mjs";
import { ResponseComposer } from "./response-composer.mjs";
import { formatError } from "./errors.mjs";
import { MessageTransport, makeRef } from "./transport.mjs";
import { AgentMemory } from "./agent-memory.mjs";
import { createLogger } from "./logger.mjs";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { unlinkSync, chmodSync } from "node:fs";

const log = createLogger('bridge');

const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const TG_UX_SOCK = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const UNDO_ALLOWED_DOMAINS = new Set([
    "light", "switch", "fan", "cover", "lock", "climate",
    "media_player", "input_boolean", "automation", "script", "scene",
]);
const UNDO_ALLOWED_SERVICES = new Set([
    "turn_on", "turn_off", "toggle",
    "open_cover", "close_cover",
    "lock", "unlock",
    "set_temperature", "activate", "deactivate",
]);
const UNDO_ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const UNDO_REVERSE_MAP = Object.freeze({
    "turn_on": "turn_off",
    "turn_off": "turn_on",
    "open_cover": "close_cover",
    "close_cover": "open_cover",
    "lock": "unlock",
    "unlock": "lock",
    "activate": "deactivate",
});

export class Bridge {
    #telegram;
    #acp;        // primary ACP instance (shorthand)
    #acpMgr;     // ACPManager for multi-ACP support
    #config;
    #allowedChatIds;

    // Subsystems
    #transport;
    #pairing;
    #scopeMgr;
    #sessionMgr;

    // --- Primary ACP context ---
    // Active conversation ref — where primary ACP output is routed
    #activeRef = null;
    // Active scope — per-scope state for the current primary prompt
    #activeScope = null;
    // Session switch guard — true while loading a different ACP session
    #switching = false;

    // --- Overflow ACP context ---
    #overflowScope = null;
    #overflowRef = null;

    // Set when the active prompt was cancelled due to message edit
    #editCancelled = false;

    // Typing state
    #typingInterval = null;
    #typingDebounce = null;

    // Message flush interval (safety net timer length)
    #messageFlushMs = 2000;

    // Pinned instructions per chat (chatId → text)
    #pinnedInstructions = new Map();

    // Prompt lock (one prompt at a time on primary)
    #promptActive = false;
    #promptQueue = [];
    #lastProcessedScope = null;
    #lastProcessedAt = 0;
    #userMessageTimes = new Map(); // userId → [timestamps]


    // Login lock — prevents multiple concurrent login flows
    #loginPromise = null;

    // startCopilot lock — prevents overlapping start attempts
    #startPromise = null;

    // Button manager for inline keyboards
    #buttons;

    // Global session state (shared across all scopes)
    #models = [];
    #modes = [];
    #availableCommands = [];  // Copilot slash commands from ACP
    #knownTools = new Map();  // MCP tool names seen → description

    // Active status menu (singleton — only one at a time)
    #statusMsg = null; // { chatId, messageId, createdAt }
    #statusRefreshPaused = false; // true during intentional restart (skip exit event refresh)

    // UDS server for tg-ux MCP sidecar IPC
    #udsServer = null;

    // Question queue for MCP ask_user (FIFO)
    #questionQueue = [];
    #processingQuestion = false;
    static #MAX_QUESTION_QUEUE = 10;

    // Agent persistent memory
    #agentMemory;

    constructor({ telegram, acp, acpMgr, config, pairing, scopeMgr, sessionMgr }) {
        this.#telegram = telegram;
        this.#acpMgr = acpMgr || null;
        this.#acp = acpMgr ? acpMgr.primary : acp;
        this.#config = config;
        this.#allowedChatIds = (config.allowedChatIds || []).map(Number);
        this.#buttons = new ButtonManager(telegram);
        this.#transport = new MessageTransport(telegram);
        this.#pairing = pairing || null;
        this.#scopeMgr = scopeMgr || null;
        this.#sessionMgr = sessionMgr || null;
        this.#agentMemory = new AgentMemory({ agentDir: config.agentDir });
    }

    get allowedChatIds() { return this.#allowedChatIds; }
    get promptActive() { return this.#promptActive; }
    get acpMgr() { return this.#acpMgr; }
    standingOrchestrator = null;
    get allowAll() { return this.#activeScope?.allowAll ?? false; }
    set allowAll(v) {
        const val = !!v;
        if (this.#activeScope) this.#activeScope.allowAll = val;
        log.info(`Allow-all mode: ${val}`);
    }

    /** Resolve scope and ref for a given ACP tag. */
    #getCtxForTag(tag) {
        if (tag === "overflow") {
            return { scope: this.#overflowScope, ref: this.#overflowRef };
        }
        return { scope: this.#activeScope, ref: this.#activeRef };
    }

    /** Resolve scope/ref for whichever ACP tag a scope is using. */
    #getCtxForScope(scopeKey) {
        if (this.#overflowScope?.key === scopeKey) {
            return { scope: this.#overflowScope, ref: this.#overflowRef, tag: "overflow" };
        }
        if (this.#activeScope?.key === scopeKey) {
            return { scope: this.#activeScope, ref: this.#activeRef, tag: "primary" };
        }
        return { scope: null, ref: null, tag: null };
    }

    resetPreamble() {
        // Clear preambleSent on ALL scopes
        if (this.#scopeMgr) {
            for (const entry of this.#scopeMgr.list()) {
                const scope = this.#scopeMgr.get(entry.key);
                if (scope) scope.preambleSent = false;
            }
        }
    }

    #sanitizePinnedInstruction(text) {
        return String(text || "")
            .replace(/\[\/SYSTEM/gi, "/system")
            .replace(/\[SYSTEM/gi, "system")
            .replace(/\[\/INST/gi, "/instruction")
            .replace(/\[INST/gi, "instruction")
            .replace(/<\|system\|>/gi, "system")
            .replace(/<\|assistant\|>/gi, "assistant")
            .replace(/<\|user\|>/gi, "user")
            .replace(/<\/system>/gi, "/system")
            .replace(/<system>/gi, "system")
            .trim();
    }

    /** Best-effort notification before process exit. */
    async notifyShutdown() {
        const promises = [];
        const scope = this.#activeScope;

        // Cancel any queued MCP questions
        this.#cancelQuestionQueue("Bot shutting down");

        // If a response was in progress, notify the user
        if (scope?.composer?.active && this.#activeRef) {
            promises.push(
                this.#telegram.sendMessage(
                    this.#activeRef.chatId,
                    "⚠️ Add-on is shutting down — current operation was interrupted. Send a message to resume when it's back."
                ).catch(() => {})
            );
        }

        // Update status menu if one exists
        if (this.#statusMsg) {
            promises.push(
                this.#telegram.call("editMessageText", {
                    chat_id: this.#statusMsg.chatId,
                    message_id: this.#statusMsg.messageId,
                    text: "⏹️ Copilot Stopped\n\nAdd-on was shut down.",
                    reply_markup: { inline_keyboard: [] },
                }).catch(() => {})
            );
            this.#statusMsg = null;
        }

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
        this.#stopUdsServer();
        this.#buttons.destroy();
    }

    /** Re-submit a message as if the user sent it (for /retry) */
    submitRetry(ref, text) {
        this.#queuePrompt(this.#getPrefix(ref) + text, {}, ref);
    }

    /** Send an ACP slash command without the [Via Telegram] prefix. */
    submitSlashCommand(ref, text) {
        this.#queuePrompt(text, {}, ref);
    }

    /**
     * Inject a system-generated prompt into the agent (for standing instructions,
     * event-triggered wake-ups, scheduled tasks, etc.).
     * Routes output to the specified chatId (defaults to owner DM).
     */
    async injectSystemPrompt(text, chatId) {
        const targetChatId = chatId || this.#allowedChatIds[0];
        if (!targetChatId) {
            log.warn("Cannot inject prompt — no target chatId");
            return;
        }
        const ref = makeRef(targetChatId, null, null, "private");
        ref.scopeKey = `standing:${targetChatId}`;
        const prefix = this.#getPrefix(ref);
        log.info(`Injecting system prompt to chat=${targetChatId}`);

        // Ensure copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                log.error(`Failed to start copilot for injection: ${err.message}`);
                // Notify owner about the failure
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(targetChatId,
                        `⚠️ Standing instruction triggered but Copilot couldn't start: ${err.message}`)
                );
                return;
            }
        }

        this.#queuePrompt(prefix + text, {}, ref);
    }

    #resolveScopeKey(scope, ref = null) {
        if (scope?.key) return scope.key;
        if (ref?.scopeKey) return ref.scopeKey;
        if (this.#scopeMgr && ref) return this.#scopeMgr.resolveKey(ref);
        return null;
    }

    isPromptActiveForScope(scope, ref = null) {
        const requestedKey = this.#resolveScopeKey(scope, ref);
        if (!this.#promptActive) return false;
        if (!requestedKey) return true;
        return this.#activeScope?.key === requestedKey;
    }

    async cancelActivePromptForScope(scope, ref = null, opts = {}) {
        const { notifyIfMissing = true } = opts;
        const requestedKey = this.#resolveScopeKey(scope, ref);

        // Cancel any queued questions for this scope
        this.#cancelQuestionQueue("User cancelled");

        if (this.#promptActive && (!requestedKey || this.#activeScope?.key === requestedKey)) {
            await this.#acp.cancel();
            return true;
        }

        if (notifyIfMissing && ref) {
            this.#transport.enqueueSend(ref, "ℹ️ No active request in this conversation to cancel.");
        }
        return false;
    }

    // --- Status menu (singleton with auto-refresh) ---

    static #STATUS_TTL_MS = 5 * 60 * 1000; // 5 min expiry

    /** Send or refresh the status menu. Dismisses any previous one. */
    async showStatusMenu(chatId, scope = null) {
        // Dismiss old status message if exists
        await this.#dismissOldStatus(chatId);

        const requestedScope = scope || this.#activeScope || this.#scopeMgr?.activeScope || null;
        const { text, buttons } = this.#buildStatusContent(requestedScope);
        const sent = await this.#telegram.sendMessage(chatId, text, undefined, buttons);
        if (sent?.message_id) {
            this.#statusMsg = {
                chatId,
                messageId: sent.message_id,
                createdAt: Date.now(),
                scopeKey: requestedScope?.key || null,
            };
        }
    }

    /** Edit the existing status menu if it's still fresh. Called on state changes. */
    async #refreshStatusIfAlive() {
        if (!this.#statusMsg) {
            log.debug("Status refresh: no active status message");
            return;
        }
        if (this.#statusRefreshPaused) {
            log.debug("Status refresh: paused (restart in progress)");
            return;
        }
        if (Date.now() - this.#statusMsg.createdAt > Bridge.#STATUS_TTL_MS) {
            log.debug("Status refresh: expired");
            this.#statusMsg = null;
            return;
        }
        const scope = this.#statusMsg.scopeKey ? this.#scopeMgr?.get(this.#statusMsg.scopeKey) : null;
        const { text, buttons } = this.#buildStatusContent(scope);
        const firstLine = text.split("\n")[0];
        log.debug(`Status refresh: updating to "${firstLine}" (msgId=${this.#statusMsg.messageId})`);
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: this.#statusMsg.chatId,
                message_id: this.#statusMsg.messageId,
                text,
                reply_markup: buttons,
            });
            log.debug("Status refresh: edit succeeded");
        } catch (err) {
            if (/message is not modified/i.test(err?.message)) {
                log.debug("Status refresh: no change needed");
                return;
            }
            log.warn(`Status refresh: edit failed — ${err.message}`);
            this.#statusMsg = null; // message gone
        }
    }

    async #dismissOldStatus(newChatId) {
        if (!this.#statusMsg) return;
        try {
            await this.#telegram.call("deleteMessage", {
                chat_id: this.#statusMsg.chatId,
                message_id: this.#statusMsg.messageId,
            });
        } catch {}
        this.#statusMsg = null;
    }

    #buildStatusContent(requestedScope = null) {
        const alive = this.#acp?.alive;
        const hasSession = !!this.#acp?.sessionId;
        const ready = alive && hasSession;
        const scope = requestedScope || this.#activeScope || this.#scopeMgr?.activeScope;
        const scopeType = scope?.key?.startsWith("forum:") ? "Forum"
            : scope?.key?.startsWith("group:") ? "Group"
            : "DM";
        const scopeSessionId = scope?.sessionId || this.#acp?.sessionId || null;

        const lines = [];
        lines.push(ready ? "✅ Copilot Ready" : alive ? "⏳ Copilot Starting..." : "⏹️ Copilot Stopped");
        if (this.#config?.version) lines.push(`📦 Version: ${this.#config.version}`);
        lines.push("");

        if (scope) {
            lines.push(`🗂️ Scope: ${scopeType}`);
            lines.push(`🔑 Scope key: ${scope.key}`);
        }

        if (ready) {
            const currentModel = scope?.model || "";
            const currentMode = scope?.mode || "";
            const modelName = this.#models?.find(m => m.modelId === currentModel)?.name || currentModel || "unknown";
            const modeName = this.#modes?.find(m => normalizeModeId(m.id) === currentMode)?.name || currentMode || "unknown";
            const modeIcon = currentMode === "autopilot" ? "🟢" : currentMode === "plan" ? "📝" : "💬";
            lines.push(`🤖 Model: ${modelName}`);
            lines.push(`${modeIcon} Mode: ${modeName}`);
            lines.push(`🔗 Session: ${scopeSessionId ? `${scopeSessionId.slice(0, 8)}…` : "none"}`);
            lines.push(`📊 Models available: ${this.#models?.length || 0}`);
        }

        const scopeAllowAll = scope?.allowAll ?? false;
        if (scopeAllowAll) {
            lines.push(`🔓 Permissions: allow-all`);
        } else {
            lines.push(`🔐 Permissions: interactive`);
        }

        // HA integration status
        if (this.#config?.haConnected) {
            lines.push(`🏠 HA API: ✅ ${this.#config.haVersion || "connected"}`);
        } else {
            lines.push(`🏠 HA API: ❌ unavailable`);
        }
        if (this.#config?.mcpServers?.length > 0) {
            lines.push(`🔌 MCP: ${this.#config.mcpServers.length} server(s)`);
        }

        // Standing instructions status
        if (this.standingOrchestrator) {
            const orch = this.standingOrchestrator;
            const mgr = orch.manager;
            const instructions = mgr.list();
            const enabled = instructions.filter(i => i.enabled).length;
            const haWs = orch.eventListener.connected ? "🟢" : "🔴";
            lines.push(`📡 HA Events: ${haWs} | Standing: ${enabled}/${instructions.length} active`);
        }

        lines.push(`📱 Telegram: connected`);
        lines.push(`👥 Chats: ${this.#allowedChatIds.length}`);
        if (this.#pairing) {
            lines.push(`🔐 Paired users: ${this.#pairing.getPairedUsers().length}`);
        }
        if (this.#scopeMgr) {
            const stats = this.#scopeMgr.stats();
            lines.push(`🗂️ Scopes: ${stats.total} (${stats.dm} DM, ${stats.group} group, ${stats.forum} forum)`);
        }
        if (scope?.history) lines.push(`📜 History: ${scope.history.length} messages`);

        const currentMode = scope?.mode || "";
        const modeButtonIcon = currentMode === "autopilot" ? "🟢" : currentMode === "plan" ? "📝" : "💬";
        const modeButtonLabel = currentMode && currentMode !== "interactive"
            ? `${modeButtonIcon} ${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}`
            : `${modeButtonIcon} Mode`;

        const statusButtons = {
            inline_keyboard: ready ? [
                [
                    { text: "🤖 Model", callback_data: "/model" },
                    { text: modeButtonLabel, callback_data: "/mode" },
                ],
                [
                    { text: "📊 Usage", callback_data: "/usage" },
                    { text: "🗜️ Compact", callback_data: "/compact" },
                ],
                [
                    { text: scopeAllowAll ? "\u{1F512} Allow-all OFF" : "\u{1F513} Allow-all ON",
                      callback_data: scopeAllowAll ? "/allowall off" : "/allowall on" },
                    { text: "📡 Standing", callback_data: "/standing" },
                ],
                [
                    { text: "🔄 Restart", callback_data: "/session new" },
                    { text: "⏹️ Stop", callback_data: "/session stop" },
                ],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ] : alive ? [
                [{ text: "🔄 Refresh", callback_data: "/status" }],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ] : [
                [{ text: "🚀 Start Copilot", callback_data: "/session new" }],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ],
        };

        return { text: lines.join("\n"), buttons: statusButtons };
    }

    // --- Setup event handlers ---

    setupACPHandlers() {
        // Wire primary ACP event handlers
        this.#wireACPEvents(this.#acp, {
            getScope: () => this.#activeScope,
            getRef: () => this.#activeRef,
            getSwitching: () => this.#switching,
            tag: "primary",
        });

        // Start UDS server for tg-ux MCP sidecar IPC
        this.#startUdsServer();
    }

    /** Wire overflow ACP event handlers (called when overflow spawns). */
    #wireOverflowHandlers(overflowAcp) {
        this.#wireACPEvents(overflowAcp, {
            getScope: () => this.#overflowScope,
            getRef: () => this.#overflowRef,
            getSwitching: () => false,
            tag: "overflow",
        });
    }

    /**
     * Wire ACP event handlers parametrized by scope/ref resolvers.
     * This allows the same handler logic for both primary and overflow ACP.
     */
    #wireACPEvents(acp, { getScope, getRef, getSwitching, tag }) {

        // Text chunks → feed to composer for progressive display
        acp.on("text_chunk", (text) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            this.#resetTypingDebounce();

            // Add newline separator when text resumes after tool calls
            if (scope._toolJustEnded && scope.messageBuffer && !scope.messageBuffer.endsWith("\n")) {
                scope.messageBuffer += "\n";
                if (scope.composer?.active) scope.composer.appendText("\n");
            }
            scope._toolJustEnded = false;

            scope.messageBuffer += text;
            if (scope.composer?.active) {
                scope.composer.appendText(text);
            } else {
                // Legacy path: no composer, flush as separate messages
                if (scope.messageFlushTimer) clearTimeout(scope.messageFlushTimer);
                scope.messageFlushTimer = setTimeout(() => this.#flushMessageBuffer(getScope, getRef), this.#messageFlushMs);
            }
        });

        // Thought chunks → feed to composer for live reasoning display
        acp.on("thought_chunk", (text) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            this.#resetTypingDebounce();

            // Add newline separator when thoughts resume after tool calls
            if (scope._toolJustEndedThought && scope.composer?.active) {
                scope.composer.appendThought("\n");
            }
            scope._toolJustEndedThought = false;

            if (scope.composer?.active) {
                scope.composer.appendThought(text);
            }
        });

        // Message boundaries
        acp.on("message_start", () => {
            log.info(`Agent message_start [${tag}]`);
            if (getSwitching()) return;
            const scope = getScope();
            if (scope) {
                scope.messageBuffer = "";
                scope._toolJustEnded = false;
                scope._toolJustEndedThought = false;
            }
        });

        acp.on("message_end", () => {
            log.info(`Agent message_end [${tag}]`);
            if (getSwitching()) return;
            this.#finalizeComposer(getScope, getRef);
            this.#stopTyping();
        });

        // Tool calls → composer progress updates
        acp.on("tool_start", ({ toolCallId, toolName, arguments: args }) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            log.debug(`Tool start [${tag}]: ${toolName} (${toolCallId})`);
            scope.turnToolCount++;
            this.#resetTypingDebounce();
            const desc = describeToolCall(toolName, args);
            if (desc) {
                scope.activeTools.set(toolCallId, { name: toolName, description: desc });
                if (scope.composer?.active) {
                    scope.composer.addToolStep(toolCallId, desc, "running");
                }
            }
            // Track tool for /skills discovery
            if (toolName && !this.#knownTools.has(toolName) && this.#knownTools.size < 200) {
                this.#knownTools.set(toolName, desc || toolName);
            }
        });

        acp.on("tool_end", ({ toolCallId, status, result }) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            const completed = scope.activeTools.get(toolCallId);
            const resultSummary = result ? JSON.stringify(result).substring(0, 100) : "null";
            log.debug(`Tool end [${tag}]: ${completed?.name || toolCallId} [${status}] (${resultSummary.length > 99 ? 'truncated' : 'full'})`);
            if (status === "failed") {
                scope.turnToolErrors++;
                log.warn(`Tool failed: ${completed?.name || toolCallId}`);
            } else {
                const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
                if (result?.isError || result?.error || /\"isError\"\s*:\s*true/i.test(resultStr)) {
                    scope.turnToolErrors++;
                    log.warn(`Tool error detected: ${completed?.name || toolCallId}`);
                }
            }
            this.#resetTypingDebounce();
            scope.activeTools.delete(toolCallId);
            scope._toolJustEnded = true;  // signal next text_chunk to add newline
            scope._toolJustEndedThought = true;  // signal next thought_chunk to add newline
            if (scope.composer?.active && completed?.description) {
                scope.composer.addToolStep(toolCallId, completed.description, status === "failed" ? "failed" : "completed");
            }

            // Interactive mode: show notification + undo for HA write tools
            if (!scope.allowAll && status === "completed" && completed?.name) {
                this.#showToolNotification(completed.name, result, getScope, getRef);
            }

            // Relay images from tool results
            this.#relayToolImages(result, getRef);
        });

        // Tool progress updates (in_progress status)
        acp.on("tool_update", ({ toolCallId, status }) => {
            if (getSwitching()) return;
            if (status === "in_progress") {
                this.#resetTypingDebounce();
            }
        });

        // Plan entries — display in composer
        acp.on("plan", (entries) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            log.debug(`Plan update [${tag}]: ${entries.length} entries`);
            if (scope.composer?.active) {
                scope.composer.setPlan(entries);
            }
        });

        // Mode change notification
        acp.on("mode_update", (modeId) => {
            const scope = getScope();
            if (scope && modeId) {
                scope.mode = normalizeModeId(modeId);
                log.debug(`Mode updated [${tag}]: ${scope.mode}`);
                this.#refreshStatusIfAlive();
            }
        });

        // Process exit — handle crash recovery
        acp.on("exit", ({ code, signal }) => {
            this.#handleACPExit(code, signal, acp, getScope, getRef, tag);
        });

        acp.on("error", (err) => {
            log.error(`ACP [${tag}] error: ${err.message}`);
        });

        acp.on("log", (text) => {
            log.debug(`ACP[${tag}]: ${text}`);
        });

        acp.on("permission_request", async (req) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            await this.#handlePermissionRequest(req, acp, scope, getRef, tag);
        });

        // Capture session data (models, modes) from session events
        acp.on("session", (result) => {
            if (result.models?.availableModels) {
                this.#models = result.models.availableModels;
                log.info(`Models available: ${this.#models.length}`);
            }
            const scope = getScope();
            if (scope) {
                if (result.models?.currentModelId) {
                    scope.model = result.models.currentModelId;
                }
                if (result.modes?.currentModeId) {
                    scope.mode = normalizeModeId(result.modes.currentModeId);
                }
            }
            if (result.modes?.availableModes) {
                this.#modes = result.modes.availableModes;
            }
        });

        // config_option_update can update models/modes mid-session
        acp.on("config_options", (options) => {
            const scope = getScope();
            const modelOpt = options?.find(o => o.id === "model");
            if (modelOpt?.options) {
                this.#models = modelOpt.options.map(o => ({
                    modelId: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modelOpt?.currentValue && scope) {
                scope.model = modelOpt.currentValue;
            }
            const modeOpt = options?.find(o => o.id === "mode");
            if (modeOpt?.options) {
                this.#modes = modeOpt.options.map(o => ({
                    id: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modeOpt?.currentValue && scope) {
                scope.mode = normalizeModeId(modeOpt.currentValue);
            }
            this.#refreshStatusIfAlive();
        });

        // Capture available commands (copilot slash commands)
        acp.on("commands", (commands) => {
            if (Array.isArray(commands)) {
                this.#availableCommands = commands;
                log.info(`Copilot commands available: ${commands.length}`);
            }
        });

        // Elicitation — agent asks structured questions
        acp.on("elicitation_request", async (req) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) {
                acp.respondElicitation(req.requestId, "cancel");
                return;
            }
            await this.#handleElicitationRequest(req, acp, scope, getRef, tag);
        });
    }  // end of #wireACPEvents

    // --- Extracted ACP event handlers ---

    /** Handle permission_request events from ACP. */
    async #handlePermissionRequest(req, acp, scope, getRef, tag) {
        log.info(`Permission request [${tag}]: ${req.toolCall?.name || req.tool || 'unknown'}`);
        const { requestId } = req;

        // Extract tool identification from the new session/request_permission format
        const toolCall = req.toolCall || {};
        const rawInput = toolCall.rawInput || {};
        const toolTitle = toolCall.title || "";
        const domain = rawInput.domain || "";
        const service = rawInput.service || "";
        const entityId = rawInput.entity_id || "";
        const tool = domain && service ? `ha_${domain}_${service}` :
                     toolTitle.toLowerCase().includes("call service") ? "ha_call_service" :
                     req.toolName || req.tool || req.name || "unknown_tool";
        const desc = entityId ? `${domain}.${service} → ${entityId}` :
                     toolTitle || "";

        // Plan approval / mode switch — special UX with dynamic option buttons
        if (toolCall.kind === "switch_mode") {
            await this.#handlePlanApproval(req, acp, scope, getRef, tag);
            return;
        }

        // Allow-all mode: skip all permission prompts
        if (scope.allowAll) {
            const options = req.options || [];
            const allowId = options.find(o => o.kind === "allow_always")?.optionId || "allow_always";
            acp.respondPermission(requestId, allowId);
            log.info(`Permission auto-approved (allow-all mode): ${tool} (${desc})`);
            return;
        }

        // Policy: auto-approve read-only HA tools + standard copilot tools
        const readOnlyTools = new Set([
            "ha_search_entities", "ha_get_state", "ha_get_history",
            "ha_deep_search", "ha_get_overview", "ha_get_entity_state",
            "ha_search_automations", "ha_get_automation",
        ]);
        const isReadOnly = readOnlyTools.has(tool) || !tool.startsWith("ha_");

        const options = req.options || [];
        const findOption = (kind) => options.find(o => o.kind === kind)?.optionId;
        const allowOnceId = findOption("allow_once") || "allow_once";
        const allowAlwaysId = findOption("allow_always") || "allow_always";
        const rejectOnceId = findOption("reject_once") || "reject_once";

        // Per-user per-scope grants
        const ref = getRef();
        const userId = ref?.userId;
        if (isReadOnly || (userId && scope.isToolGranted(userId, tool))) {
            acp.respondPermission(requestId, allowAlwaysId);
            log.info(`Permission auto-approved: ${tool} (${desc})`);
            return;
        }

        // Ask user via inline buttons
        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#allowedChatIds?.[0];
        if (!chatId || !this.#buttons) {
            acp.respondPermission(requestId, rejectOnceId);
            log.info(`Permission denied (no chat): ${tool}`);
            return;
        }

        const label = desc ? `${tool}\n${desc}` : tool;
        const encodedUserId = this.#encodeCallbackUserId(targetRef?.userId);
        const allowOnceValue = encodedUserId ? `perm:${encodedUserId}:${allowOnceId}` : allowOnceId;
        const allowAlwaysValue = encodedUserId ? `perm:${encodedUserId}:${allowAlwaysId}` : allowAlwaysId;
        const rejectOnceValue = encodedUserId ? `perm:${encodedUserId}:${rejectOnceId}` : rejectOnceId;
        const rows = [
            [
                { text: "✅ Allow once", value: allowOnceValue },
                { text: "✅ Always allow", value: allowAlwaysValue },
                { text: "❌ Deny", value: rejectOnceValue },
            ],
        ];
        if (scope.composer) scope.composer.setInteractionPending("permission");
        let selected, permMsgId;
        try {
            ({ value: selected, messageId: permMsgId } = await this.#buttons.prompt(
                chatId,
                `🔐 Permission request:\n${label}`,
                rows,
                { timeoutMs: 0 }
            ));
        } finally {
            if (scope.composer) scope.composer.setInteractionPending(null);
        }

        const selectedOption = this.#unwrapPermissionSelection(selected);
        if (selectedOption === allowOnceId || selectedOption === allowAlwaysId) {
            if (selectedOption === allowAlwaysId && userId) {
                scope.grantTool(userId, tool);
            }
            acp.respondPermission(requestId, selectedOption);
            log.info(`Permission granted (${selectedOption}): ${tool}`);
            if (permMsgId) {
                try {
                    await this.#buttons.finalize(chatId, permMsgId, `✅ Allowed: ${desc || tool}`);
                } catch (err) {
                    log.warn(`Error finalizing allow message: ${err.message}`);
                }
            }
        } else {
            acp.respondPermission(requestId, rejectOnceId);
            log.info(`Permission denied: ${tool} (permMsgId=${permMsgId})`);
            try {
                if (permMsgId) {
                    log.debug(`Finalizing deny message: chat=${chatId} msg=${permMsgId}`);
                    await this.#buttons.finalize(chatId, permMsgId, `❌ Denied: ${desc || tool}`);
                } else {
                    log.warn(`No permMsgId for deny feedback`);
                }
            } catch (err) {
                log.warn(`Error finalizing deny message: ${err.message}`);
            }
        }
    }

    /** Handle plan approval (switch_mode permission requests). */
    async #handlePlanApproval(req, acp, scope, getRef, tag) {
        const { requestId } = req;
        const toolCall = req.toolCall || {};
        const toolTitle = toolCall.title || "";
        const options = req.options || [];

        if (options.length === 0) {
            log.warn('Plan approval: no options provided');
            acp.respondPermission(requestId, "reject_once");
            return;
        }
        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#allowedChatIds?.[0];
        if (!chatId || !this.#buttons) {
            const fallbackId = options.find(o => o.kind === "allow_once")?.optionId || options[0]?.optionId;
            if (fallbackId) acp.respondPermission(requestId, fallbackId);
            return;
        }

        // Extract plan content from toolCall.content
        let planSummary = "";
        if (Array.isArray(toolCall.content)) {
            for (const c of toolCall.content) {
                const text = c?.content?.text || c?.text || "";
                if (text) planSummary += (planSummary ? "\n" : "") + text;
            }
        }

        const header = toolTitle || "📋 Ready for implementation";
        const maxSummary = 3800 - header.length;
        if (planSummary.length > maxSummary) planSummary = planSummary.slice(0, maxSummary) + "…";
        const label = planSummary
            ? `📋 ${header}\n\n${planSummary}`
            : `📋 ${header}`;

        // Build buttons from dynamic options — one per row for clarity
        const encodedUserId = this.#encodeCallbackUserId(targetRef?.userId);
        const rows = options.map(opt => {
            const icon = opt.kind === "reject_once" || opt.kind === "reject_always" ? "❌"
                       : opt.kind === "allow_always" ? "🚀"
                       : "✅";
            const val = encodedUserId ? `perm:${encodedUserId}:${opt.optionId}` : opt.optionId;
            return [{ text: `${icon} ${opt.name}`, value: val }];
        });

        if (scope.composer) scope.composer.setInteractionPending("plan");
        let selected, permMsgId;
        try {
            ({ value: selected, messageId: permMsgId } = await this.#buttons.prompt(
                chatId, label, rows,
                { timeoutMs: 0, timeoutText: "📋 Plan approval cancelled" }
            ));
        } finally {
            if (scope.composer) scope.composer.setInteractionPending(null);
        }

        const selectedOption = this.#unwrapPermissionSelection(selected);
        if (selectedOption) {
            acp.respondPermission(requestId, selectedOption);
            const chosenName = options.find(o => o.optionId === selectedOption)?.name || selectedOption;
            log.info(`Plan approval: ${chosenName}`);
            if (permMsgId) {
                try {
                    await this.#buttons.finalize(chatId, permMsgId, `📋 ${chosenName}`);
                } catch {}
            }
        } else {
            const rejectId = options.find(o => o.kind === "reject_once")?.optionId || "reject_once";
            acp.respondPermission(requestId, rejectId);
            log.info(`Plan approval cancelled/timed out`);
        }
    }

    /** Handle ACP process exit — crash recovery and state cleanup. */
    #handleACPExit(code, signal, acp, getScope, getRef, tag) {
        this.#stopTyping();
        const scope = getScope();
        const ref = getRef();
        if (scope) {
            if (scope.composer?.active) {
                scope.composer.abort("Copilot process exited unexpectedly").catch(() => {});
                scope.composer = null;
            }
            scope.activeTools.clear();
            this.#flushMessageBuffer(() => scope, () => ref);

            // Cancel any pending elicitation
            if (scope.pendingElicitation) {
                const { requestId, resolve } = scope.pendingElicitation;
                if (requestId) {
                    try { acp.respondElicitation(requestId, "cancel"); } catch {}
                }
                if (typeof resolve === "function") resolve(undefined);
                scope.pendingElicitation = null;
            }
            // Cancel any pending button menus for this chat
            const chatId = ref?.chatId;
            if (chatId && this.#buttons) {
                this.#buttons.cancelForChat(chatId, "🛑 Session ended");
            }

            // Cancel any queued MCP questions
            this.#cancelQuestionQueue("Session ended");
        }

        if (tag === "primary") {
            // Crash recovery: reject any active prompt so the queue doesn't wedge
            if (this.#promptActive) {
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                this.#scopeMgr?.clearActive();
                const dropped = this.#promptQueue.length;
                this.#promptQueue = [];
                if (dropped > 0) {
                    this.#broadcastAdmin(`⚠️ ${dropped} queued message(s) dropped due to Copilot exit.`);
                }
            }

            if (code !== 0 && code !== null) {
                this.#broadcastAdmin(`⚠️ Copilot process exited (code: ${code}). Send a message to restart.`);
            }
        } else {
            // Overflow exit — clean up overflow state
            this.#overflowScope = null;
            this.#overflowRef = null;
            if (this.#acpMgr) this.#acpMgr.release("overflow");
            if (code !== 0 && code !== null) {
                log.warn(`Overflow ACP crashed (code: ${code}). Will respawn on next demand.`);
            }
        }

        // Clear stale mode/model from scope
        const exitScope = getScope();
        if (exitScope) {
            exitScope.mode = "";
            exitScope.model = "";
            exitScope.promptRunning = false;
            exitScope.acpTag = null;
        }
        this.#refreshStatusIfAlive().catch(() => {});
    }

    /** Handle elicitation_request events from ACP (structured questions). */
    async #handleElicitationRequest(req, acp, scope, getRef, tag) {
        if (scope.pendingElicitation) {
            acp.respondElicitation(req.requestId, "cancel");
            log.warn(`Rejected concurrent elicitation (another pending)`);
            return;
        }
        log.info(`Elicitation [${tag}]: ${req.message}`);

        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#allowedChatIds?.[0];
        if (!chatId) {
            acp.respondElicitation(req.requestId, "cancel");
            return;
        }

        const schema = req.requestedSchema;
        const props = schema?.properties || {};
        const propNames = Object.keys(props);

        // Single-property shortcut (most common case)
        if (propNames.length === 1) {
            const propName = propNames[0];
            const propSchema = props[propName];
            const result = await this.#elicitSingleField(
                chatId, req.requestId, req.message, propName, propSchema, scope
            );
            if (result !== undefined) {
                acp.respondElicitation(req.requestId, "accept", { [propName]: result });
            }
            return;
        }

        // Multi-field: collect answers sequentially
        if (propNames.length > 1) {
            const content = {};
            for (const propName of propNames) {
                const propSchema = props[propName];
                const fieldMsg = propSchema.title
                    ? `${req.message}\n\n${propSchema.title}${propSchema.description ? `\n${propSchema.description}` : ""}`
                    : req.message;
                const result = await this.#elicitSingleField(
                    chatId, req.requestId, fieldMsg, propName, propSchema, scope
                );
                if (result === undefined) return; // cancelled
                content[propName] = result;
            }
            acp.respondElicitation(req.requestId, "accept", content);
            return;
        }

        // Empty schema — just show message with OK button
        if (this.#buttons) {
            const { value } = await this.#buttons.prompt(chatId, `❓ ${req.message}`, [
                [{ text: "✅ OK", value: "ok" }, { text: "❌ Cancel", value: "cancel" }]
            ]);
            acp.respondElicitation(req.requestId, value === "ok" ? "accept" : "decline", {});
        } else {
            acp.respondElicitation(req.requestId, "accept", {});
        }
    }

    // --- UDS IPC server for tg-ux MCP ask_user tool ---

    #startUdsServer() {
        try { unlinkSync(TG_UX_SOCK); } catch {}
        this.#udsServer = createNetServer({ allowHalfOpen: true }, (conn) => {
            let buf = "";
            conn.on("data", (c) => {
                buf += c.toString();
                // Request is a single JSON line; parse once we have a complete line
                const nlIdx = buf.indexOf("\n");
                if (nlIdx === -1) return;
                const line = buf.slice(0, nlIdx);
                buf = "";
                let req;
                try {
                    req = JSON.parse(line);
                } catch (e) {
                    log.debug(`UDS: JSON parse error: ${e.message}`);
                    try { conn.end(JSON.stringify({ error: "Invalid JSON" })); } catch {}
                    return;
                }
                const scopeKey = req.scopeKey;
                log.debug(`UDS: ask_user received (scope=${scopeKey || "unknown"})`);
                this.#handleMcpAskUser(req.params || {}, scopeKey)
                    .then((result) => {
                        log.debug(`UDS: ask_user result (scope=${scopeKey || "unknown"}): ${result.error ? "error: " + result.error : "ok"}`);
                        try { conn.end(JSON.stringify(result)); } catch {}
                    })
                    .catch((err) => {
                        log.debug(`UDS: ask_user error: ${err.message}`);
                        try { conn.end(JSON.stringify({ error: err.message })); } catch {}
                    });
            });
            conn.on("error", (err) => {
                log.debug(`UDS: connection error: ${err.message}`);
            });
        });
        this.#udsServer.on("error", (err) => {
            log.debug(`UDS server error: ${err.message}`);
        });
        this.#udsServer.listen(TG_UX_SOCK, () => {
            try { chmodSync(TG_UX_SOCK, 0o600); } catch {}
            log.info(`UDS server listening on ${TG_UX_SOCK}`);
        });
    }

    #stopUdsServer() {
        if (this.#udsServer) {
            this.#udsServer.close();
            this.#udsServer = null;
            try { unlinkSync(TG_UX_SOCK); } catch {}
        }
    }

    async #handleMcpAskUser({ message, options }, scopeKey) {
        // Resolve scope from scopeKey (UDS payload) or fall back to activeScope
        let scope, ref;
        if (scopeKey && this.#scopeMgr) {
            scope = this.#scopeMgr.get(scopeKey);
            ref = scope?.activeRef || this.#activeRef;
        }
        if (!scope) {
            scope = this.#activeScope;
            ref = this.#activeRef;
        }
        const chatId = ref?.chatId;
        if (!chatId || !scope) return { error: "No active session" };
        if (!message) return { error: "No message provided" };

        // Queue overflow protection
        if (this.#questionQueue.length >= Bridge.#MAX_QUESTION_QUEUE) {
            log.warn(`Question queue full (${this.#questionQueue.length}), rejecting`);
            return { error: "Too many pending questions" };
        }

        // Enqueue and return a Promise that resolves when this question is answered
        return new Promise((resolve) => {
            this.#questionQueue.push({
                message, options, resolve, scope, chatId, ref,
                queuedAt: Date.now(),
            });
            log.debug(`Question queued (queue=${this.#questionQueue.length})`);
            this.#drainQuestionQueue();
        });
    }

    /** Process questions FIFO — one at a time. */
    async #drainQuestionQueue() {
        if (this.#processingQuestion) return;
        if (this.#questionQueue.length === 0) return;

        this.#processingQuestion = true;
        try {
            while (this.#questionQueue.length > 0) {
                const item = this.#questionQueue[0];
                const total = this.#questionQueue.length;
                const prefix = total > 1 ? `(1/${total}) ` : "";

                // Stale scope check
                if (item.scope !== this.#activeScope && item.scope !== this.#overflowScope) {
                    log.warn(`Question skipped: scope no longer active`);
                    item.resolve({ error: "Session ended" });
                    this.#questionQueue.shift();
                    continue;
                }

                try {
                    const result = await this.#doAskUser(item, prefix);
                    item.resolve(result);
                } catch (err) {
                    log.warn(`Question error: ${err.message}`);
                    item.resolve({ error: err.message });
                }
                this.#questionQueue.shift();

                // Brief delay between questions for smooth UX
                if (this.#questionQueue.length > 0) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        } finally {
            this.#processingQuestion = false;
        }
    }

    /** Cancel all queued questions (e.g., on /stop or ACP exit). */
    #cancelQuestionQueue(reason) {
        const count = this.#questionQueue.length;
        if (count === 0) return;
        log.debug(`Cancelling ${count} queued questions: ${reason}`);
        for (const item of this.#questionQueue) {
            item.resolve({ error: reason });
        }
        this.#questionQueue.length = 0;
    }

    /**
     * Show a single question to the user and wait for answer.
     * Extracted from the old #handleMcpAskUser logic.
     */
    async #doAskUser(item, prefix) {
        const { message, options, scope, chatId } = item;

        const composerRef = scope?.composer;
        const replyToMsg = composerRef?.messageId;
        const sendOpts = replyToMsg ? { reply_to_message_id: replyToMsg } : {};
        const displayMsg = `${prefix}${message}`;

        // Reserve pendingElicitation slot
        if (scope) scope.pendingElicitation = { reserved: true };

        if (options && Array.isArray(options) && options.length > 0) {
            if (options.length <= 8) {
                // Inline buttons — one per row + cancel
                const rows = options.map((opt, i) => [
                    { text: opt.label || opt.value, value: `mcpq:${i}` },
                ]);
                rows.push([{ text: "❌ Cancel", value: "mcpq:cancel" }]);

                if (composerRef) composerRef.setInteractionPending("question");
                try {
                    const { value, messageId: btnMsgId } = await this.#buttons.prompt(
                        chatId, `❓ ${displayMsg}`, rows,
                        { timeoutMs: 0, ...sendOpts }
                    );
                    if (!value || value === "mcpq:cancel") {
                        if (btnMsgId) {
                            this.#buttons.finalize(chatId, btnMsgId, `❌ Cancelled: ${message}`).catch(() => {});
                        }
                        return { error: "User cancelled" };
                    }
                    const idx = parseInt(value.replace("mcpq:", ""), 10);
                    const answer = options[idx]?.value ?? value;
                    const label = options[idx]?.label || answer;
                    if (btnMsgId) {
                        this.#buttons.finalize(chatId, btnMsgId, `✅ ${label}`).catch(() => {});
                    }
                    return { answer };
                } finally {
                    if (scope) scope.pendingElicitation = null;
                    if (composerRef) composerRef.setInteractionPending(null);
                }
            } else {
                // Too many options — numbered list + text reply
                const numbered = options.map((opt, i) => `${i + 1}. ${opt.label || opt.value}`).join("\n");
                const prompt = `❓ ${displayMsg}\n\n${numbered}\n\nReply with the number of your choice, or "cancel".`;
                const sendParams = { chat_id: chatId, text: prompt, link_preview_options: { is_disabled: true } };
                if (sendOpts.reply_to_message_id) sendParams.reply_to_message_id = sendOpts.reply_to_message_id;
                await this.#telegram.call("sendMessage", sendParams);

                if (composerRef) composerRef.setInteractionPending("question");
                try {
                    const answer = await new Promise((resolve) => {
                        if (scope) {
                            scope.pendingElicitation = {
                                resolve, schema: { type: "string" }, propName: "answer",
                            };
                        }
                    });
                    if (!answer || answer.toLowerCase() === "cancel") {
                        return { error: "User cancelled" };
                    }
                    const num = parseInt(answer, 10);
                    if (num >= 1 && num <= options.length) {
                        return { answer: options[num - 1].value };
                    }
                    return { answer };
                } finally {
                    if (scope) scope.pendingElicitation = null;
                    if (composerRef) composerRef.setInteractionPending(null);
                }
            }
        } else {
            // Free text — prompt and wait for next message
            const cancelRows = [[{ text: "❌ Cancel", value: "mcpq:cancel" }]];

            if (composerRef) composerRef.setInteractionPending("question");
            try {
                const btnPromise = this.#buttons.prompt(
                    chatId, `❓ ${displayMsg}\n\nType your answer below:`, cancelRows,
                    { timeoutMs: 0, ...sendOpts }
                );

                const textPromise = new Promise((resolve) => {
                    if (scope) {
                        scope.pendingElicitation = {
                            resolve, schema: { type: "string" }, propName: "answer",
                        };
                    }
                });

                const result = await Promise.race([
                    btnPromise.then(r => ({ type: "button", value: r.value })),
                    textPromise.then(v => ({ type: "text", value: v })),
                ]);

                if (result.type === "button") {
                    if (scope) scope.pendingElicitation = null;
                    return { error: "User cancelled" };
                } else {
                    this.#buttons.cancelForChat(chatId, `✅ Answered`);
                    return { answer: result.value ?? "" };
                }
            } finally {
                if (scope) scope.pendingElicitation = null;
                if (composerRef) composerRef.setInteractionPending(null);
            }
        }
    }

    setupTelegramHandlers() {
        this.#telegram.on("update", (update) => this.#processUpdate(update));

        this.#telegram.on("conflict", () => {
            log.warn("Telegram 409 conflict — another process is polling this bot");
        });

        this.#telegram.on("poll_error", (err) => {
            log.warn(`Telegram poll error: ${err.message}`);
        });
    }

    // --- Build command context ---

    #buildCommandContext(ref) {
        const scopeKey = ref.scopeKey || (this.#scopeMgr ? this.#scopeMgr.resolveKey(ref) : null);
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : this.#activeScope;
        return {
            acp: this.#acp,
            telegram: this.#telegram,
            transport: this.#transport,
            chatId: ref.chatId,
            chatIds: this.#allowedChatIds,
            ref,
            scope,
            startCopilot: () => this.startCopilot(),
            stopCopilot: () => this.stopCopilot(),
            restartCopilot: () => this.restartCopilot(),
            buttons: this.#buttons,
            models: this.#models,
            modes: this.#modes,
            history: scope?.history || null,
            currentModel: scope?.model || "",
            currentMode: scope?.mode || "",
            availableCommands: this.#availableCommands,
            knownTools: this.#knownTools,
            pairing: this.#pairing,
            sessionMgr: this.#sessionMgr,
            scopeMgr: this.#scopeMgr,
            bridge: this,
            config: this.#config,
            promptActive: this.#promptActive,
        };
    }

    #encodeCallbackUserId(userId) {
        const numericUserId = Number(userId);
        return Number.isSafeInteger(numericUserId) ? numericUserId.toString(36) : null;
    }

    #extractCallbackTargetUserId(data) {
        if (!data?.startsWith("btn:")) return null;
        const value = data.split(":").slice(2).join(":");
        const [kind, encodedUserId] = value.split(":");
        if ((kind !== "perm" && kind !== "undo") || !encodedUserId) return null;
        const numericUserId = Number.parseInt(encodedUserId, 36);
        return Number.isSafeInteger(numericUserId) ? numericUserId : null;
    }

    #unwrapPermissionSelection(value) {
        if (!value?.startsWith("perm:")) return value;
        const parts = value.split(":");
        return parts.length >= 3 ? parts.slice(2).join(":") : value;
    }

    /**
     * Elicit a single field from the user via Telegram UI.
     * Returns the value on accept, or undefined if cancelled/declined
     * (in which case the elicitation response is already sent).
     */
    async #elicitSingleField(chatId, requestId, message, propName, schema, scope) {
        const acp = this.#acp;
        const title = schema.title || propName;

        // Enum with titles (oneOf) → inline keyboard
        if (Array.isArray(schema.oneOf)) {
            const optionValues = schema.oneOf.map(opt => opt.const);
            const rows = schema.oneOf.map((opt, i) => [{
                text: opt.title || opt.const,
                value: `elicit:${i}`,
            }]);
            rows.push([{ text: "❌ Skip", value: "elicit:__cancel__" }]);
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, rows
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return optionValues[Number.parseInt(val, 10)];
        }

        // Enum without titles → inline keyboard
        if (Array.isArray(schema.enum)) {
            const optionValues = [...schema.enum];
            const rows = schema.enum.map((v, i) => [{
                text: String(v),
                value: `elicit:${i}`,
            }]);
            rows.push([{ text: "❌ Skip", value: "elicit:__cancel__" }]);
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, rows
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return optionValues[Number.parseInt(val, 10)];
        }

        // Boolean → Yes/No buttons
        if (schema.type === "boolean") {
            const defaultVal = schema.default;
            const yesLabel = defaultVal === true ? "✅ Yes (default)" : "✅ Yes";
            const noLabel = defaultVal === false ? "❌ No (default)" : "❌ No";
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, [
                        [{ text: yesLabel, value: "elicit:true" }, { text: noLabel, value: "elicit:false" }],
                        [{ text: "⏭️ Skip", value: "elicit:__cancel__" }],
                    ]
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return val === "true";
        }

        // Multi-select array → sequential toggle buttons
        if (schema.type === "array" && schema.items) {
            const itemOptions = schema.items.enum || schema.items.anyOf?.map(o => o.const) || [];
            const itemLabels = schema.items.anyOf?.map(o => o.title) || itemOptions.map(String);
            if (itemOptions.length > 0) {
                const rows = itemOptions.map((v, i) => [{
                    text: itemLabels[i] || String(v),
                    value: `elicit:${i}`,
                }]);
                rows.push([{ text: "✅ Done", value: "elicit:__done__" },
                           { text: "❌ Cancel", value: "elicit:__cancel__" }]);

                const selected = [];
                // For simplicity, present as single-select repeated
                // (full multi-select toggle would require re-rendering buttons)
                if (scope.composer) scope.composer.setInteractionPending("question");
                try {
                    const { value } = await this.#buttons.prompt(
                        chatId,
                        `❓ ${message}\n\nSelect one option:`,
                        rows
                    );
                    const val = value?.replace(/^elicit:/, "");
                    if (!val || val === "__cancel__") {
                        acp.respondElicitation(requestId, "decline");
                        return undefined;
                    }
                    if (val !== "__done__") selected.push(itemOptions[Number.parseInt(val, 10)]);
                } finally {
                    if (scope.composer) scope.composer.setInteractionPending(null);
                }
                return selected;
            }
        }

        // String/number/integer → text input via pending elicitation
        const defaultHint = schema.default !== undefined ? `\n(Default: ${schema.default})` : "";
        const constraintHints = [];
        if (schema.minLength) constraintHints.push(`min ${schema.minLength} chars`);
        if (schema.maxLength) constraintHints.push(`max ${schema.maxLength} chars`);
        if ((schema.type === "number" || schema.type === "integer") && schema.minimum !== undefined) {
            constraintHints.push(`min: ${schema.minimum}`);
        }
        if ((schema.type === "number" || schema.type === "integer") && schema.maximum !== undefined) {
            constraintHints.push(`max: ${schema.maximum}`);
        }
        const constraintText = constraintHints.length > 0 ? `\n(${constraintHints.join(", ")})` : "";

        const promptText = `❓ ${message}${defaultHint}${constraintText}\n\nReply with your answer, or tap Skip.`;

        // Send message with Skip button AND set up text reply intercept
        return new Promise((resolve) => {
            // Store pending elicitation on scope for text intercept
            scope.pendingElicitation = {
                requestId,
                propName,
                schema,
                resolve: (val) => {
                    scope.pendingElicitation = null;
                    resolve(val);
                },
            };

            // Send the prompt with a skip button
            this.#buttons.prompt(chatId, promptText, [
                [{ text: "⏭️ Skip", value: "elicit:__cancel__" }],
            ]).then(({ value }) => {
                if (scope.pendingElicitation?.requestId === requestId) {
                    // User tapped Skip
                    scope.pendingElicitation = null;
                    acp.respondElicitation(requestId, "decline");
                    resolve(undefined);
                }
            }).catch(() => {
                if (scope.pendingElicitation?.requestId === requestId) {
                    scope.pendingElicitation = null;
                    acp.respondElicitation(requestId, "cancel");
                    resolve(undefined);
                }
            });
        });
    }

    #checkRateLimit(userId) {
        const now = Date.now();
        const times = this.#userMessageTimes.get(userId) || [];
        const recent = times.filter((t) => now - t < 60000);
        if (recent.length >= 10) {
            this.#userMessageTimes.set(userId, recent);
            return false;
        }
        recent.push(now);
        this.#userMessageTimes.set(userId, recent);
        return true;
    }

    // --- Inbound message processing ---

    async #handleCallbackQuery(query) {
        const chatId = query.message?.chat?.id;
        const userId = query.from?.id;
        const data = query.data;
        if (!chatId || !data) return;

        // Auth check for callbacks
        const isAuthorized = this.#pairing
            ? this.#pairing.isPaired(userId)
            : this.#allowedChatIds.includes(userId);
        if (!isAuthorized) return;

        const targetUserId = this.#extractCallbackTargetUserId(data);
        if (targetUserId != null && targetUserId !== Number(userId)) {
            try {
                await this.#telegram.call("answerCallbackQuery", {
                    callback_query_id: query.id,
                    text: "⚠️ This button is for another user",
                    show_alert: false,
                });
            } catch {}
            return;
        }

        // Try ButtonManager first (handles btn: prefix callbacks)
        if (await this.#buttons.handleCallback(query)) return;

        // Legacy callback handling — acknowledge the button press
        try {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id });
        } catch {}

        // Handle dismiss — delete the message entirely
        if (data === "dismiss") {
            try {
                await this.#telegram.call("deleteMessage", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
            } catch {}
            // Also clear status tracking if this was the active status
            if (this.#statusMsg?.messageId === query.message.message_id) {
                this.#statusMsg = null;
            }
            return;
        }

        // Handle changelog viewer
        if (data === "changelog" || data.startsWith("changelog:")) {
            const entries = this.#config?.changelog || [];
            if (entries.length === 0) {
                try {
                    await this.#telegram.call("answerCallbackQuery", {
                        callback_query_id: query.id,
                        text: "No changelog available",
                        show_alert: true,
                    });
                } catch {}
                return;
            }
            const page = data === "changelog" ? 0 : parseInt(data.split(":")[1]) || 0;
            const entry = entries[page];
            if (!entry) return;

            // Format changelog entry as plain text
            let text = `📋 Changelog — v${entry.version}\n\n`;
            // Convert markdown to readable plain text
            let body = entry.body
                .replace(/^### (.+)/gm, "⸻ $1 ⸻")
                .replace(/^- \*\*(.+?)\*\*:?\s*/gm, "• $1: ")
                .replace(/^- /gm, "• ")
                .replace(/\*\*(.+?)\*\*/g, "$1");
            // Truncate to fit Telegram limit (leave room for nav)
            if (text.length + body.length > 3800) {
                body = body.slice(0, 3800 - text.length) + "\n\n…(truncated)";
            }
            text += body;

            const navButtons = [];
            if (page > 0) {
                navButtons.push({ text: "⬅️ Newer", callback_data: `changelog:${page - 1}` });
            }
            if (page < entries.length - 1) {
                navButtons.push({ text: "Older ➡️", callback_data: `changelog:${page + 1}` });
            }
            const buttons = {
                inline_keyboard: [
                    ...(navButtons.length > 0 ? [navButtons] : []),
                    [
                        { text: "⬅️ Back", callback_data: "status:back" },
                        { text: "✕ Dismiss", callback_data: "dismiss" },
                    ],
                ],
            };
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text,
                    reply_markup: buttons,
                });
            } catch (err) {
                log.error(`Changelog display failed: ${err.message}`);
            }
            return;
        }

        if (data === "status:back") {
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            const scope = this.#buildCommandContext(ref).scope;
            const { text, buttons } = this.#buildStatusContent(scope);
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text,
                    reply_markup: buttons,
                });
                this.#statusMsg = {
                    chatId,
                    messageId: query.message.message_id,
                    createdAt: Date.now(),
                    scopeKey: scope?.key || null,
                };
            } catch (err) {
                log.error(`Status back failed: ${err.message}`);
            }
            return;
        }

        // Handle /status refresh — edit in place instead of sending new
        if (data === "/status") {
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            await this.showStatusMenu(chatId, this.#buildCommandContext(ref).scope);
            return;
        }

        // If a state-changing command is triggered from the active status menu,
        // immediately show transitional state, execute command, then refresh
        const isFromStatusMenu = this.#statusMsg?.messageId === query.message?.message_id;
        if (isFromStatusMenu && (data === "/session new" || data === "/session stop")) {
            const label = data === "/session new" ? "⏳ Starting a new scope session..." : "⏳ Stopping Copilot...";
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text: label,
                    reply_markup: { inline_keyboard: [[{ text: "✕ Dismiss", callback_data: "dismiss" }]] },
                });
            } catch {}
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            try {
                this.#statusRefreshPaused = true;
                const pauseGuard = setTimeout(() => { this.#statusRefreshPaused = false; }, 60000);
                try {
                    await handleSlashCommand(this.#buildCommandContext(ref), "session", data === "/session new" ? "new" : "stop");
                } finally {
                    clearTimeout(pauseGuard);
                    this.#statusRefreshPaused = false;
                }
            } catch (err) {
                this.#statusRefreshPaused = false;
                log.error(`Status menu action failed: ${err.message}`);
            }
            // Explicitly refresh to final state (don't rely on fire-and-forget hooks)
            await this.#refreshStatusIfAlive();
            return;
        }

        // Clean up the button message after selection
        try {
            await this.#telegram.call("editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [] },
            });
        } catch {}

        // Build ref from callback context
        const threadId = query.message?.message_thread_id || null;
        const ref = makeRef(chatId, threadId);
        ref.userId = userId;

        // Route callback data as slash commands
        const parts = data.split(" ");
        const command = parts[0].replace("/", "");
        const args = parts.slice(1).join(" ");

        await handleSlashCommand(this.#buildCommandContext(ref), command, args);
    }

    async #handleMembershipChange(memberUpdate) {
        const chat = memberUpdate.chat;
        if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

        const newStatus = memberUpdate.new_chat_member?.status;
        const oldStatus = memberUpdate.old_chat_member?.status;
        const chatId = chat.id;

        // Bot added to group
        if ((newStatus === "member" || newStatus === "administrator") &&
            (oldStatus === "left" || oldStatus === "kicked" || !oldStatus)) {

            // Whitelist check
            const allowedGroups = this.#config.allowedGroups || [];
            if (allowedGroups.length > 0 && !allowedGroups.includes(String(chatId))) {
                log.info(`Group ${chatId} not in allowed_groups, leaving`);
                await this.#telegram.call("leaveChat", { chat_id: chatId }).catch(() => {});
                return;
            }

            // Size check
            try {
                const count = await this.#telegram.call("getChatMemberCount", { chat_id: chatId });
                const maxMembers = this.#config.maxGroupMembers || 50;
                if (count > maxMembers) {
                    await this.#telegram.sendMessage(
                        chatId,
                        `⚠️ This group has ${count} members (max ${maxMembers}). I can't operate in large groups.`
                    );
                    await this.#telegram.call("leaveChat", { chat_id: chatId }).catch(() => {});
                    return;
                }
            } catch {
                // Ignore count errors.
            }

            // Welcome message
            const isForum = chat.is_forum === true;
            if (isForum) {
                this.#scopeMgr?.setForumChat(chatId);
                await this.#telegram.sendMessage(
                    chatId,
                    "👋 Forum mode activated!\n\n" +
                    "📝 Use /new [title] to create a topic with its own AI session\n" +
                    "📋 Use /sessions to see active topics\n" +
                    "ℹ️ This General topic is for management commands only"
                );
            } else {
                const botUsername = this.#telegram.botInfo?.username || "bot";
                const groupMode = this.#config.groupMode || "mention";
                const promptLine = groupMode === "all"
                    ? "💬 I can respond to messages in this group\n"
                    : `📌 @${botUsername} — mention me to ask a question\n`;
                await this.#telegram.sendMessage(
                    chatId,
                    "👋 Hi! I'm your AI assistant.\n\n" +
                    promptLine +
                    "↩️ Reply to my messages to continue a conversation\n" +
                    "🔐 Only authorized users can interact\n\n" +
                    "⚠️ Responses are visible to all group members."
                );
            }

            log.info(`Bot added to ${isForum ? "forum" : "group"} ${chatId} (${chat.title || "untitled"})`);
        }

        // Bot removed from group
        if ((newStatus === "left" || newStatus === "kicked") &&
            (oldStatus === "member" || oldStatus === "administrator")) {
            log.info(`Bot removed from group ${chatId}`);
            this.#scopeMgr?.deleteByChat(chatId);
            // Clean up pinned instructions for this chat
            this.#pinnedInstructions?.delete(chatId);
        }
    }

    /** Handle an edited Telegram message — update queue, cancel+resubmit, or send correction. */
    async #handleEditedMessage(edited) {
        const editedText = edited.text || edited.caption || "";
        const messageId = edited.message_id;
        const chatId = edited.chat.id;

        if (!editedText.trim()) return;

        log.info(`Edited message: chat=${chatId} msg=${messageId} len=${editedText.length}`);

        // Check if this message is still in the prompt queue (not yet processing)
        const queueIdx = this.#promptQueue.findIndex(p => p.messageId === messageId);
        if (queueIdx !== -1) {
            const entry = this.#promptQueue[queueIdx];
            const ref = entry.ref;
            const prefix = this.#getPrefix(ref);
            entry.text = prefix + editedText;
            log.debug(`Updated queued prompt with edited text for msg=${messageId}`);
            this.#telegram.enqueue(() =>
                this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
            );
            return;
        }

        // Check if currently being processed (same message) — cancel and resubmit
        if (this.#activeRef && messageId === this.#activeRef.triggerMessageId) {
            log.info(`Edit to active message msg=${messageId} — cancelling current prompt`);
            this.#editCancelled = true;
            try {
                if (this.#acp?.alive) await this.#acp.cancel();
            } catch (err) {
                log.warn(`Cancel during edit failed: ${err.message}`);
            }
            const scope = this.#activeScope;
            if (scope?.composer?.active) {
                await scope.composer.abort("✏️ Message edited — reprocessing...");
                scope.composer = null;
            }
            const editRef = makeRef(chatId, edited.message_thread_id || null, null, edited.chat.type);
            editRef.userId = edited.from?.id;
            editRef.username = edited.from?.username || edited.from?.first_name;
            editRef.firstName = edited.from?.first_name || null;
            editRef.triggerMessageId = messageId;
            if (this.#scopeMgr) editRef.scopeKey = this.#scopeMgr.resolveKey(editRef);
            const editPrefix = this.#getPrefix(editRef);
            this.#promptQueue.unshift({
                text: editPrefix + editedText,
                opts: {},
                ref: editRef,
                messageId,
                scopeKey: editRef.scopeKey,
            });
            this.#telegram.enqueue(() =>
                this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
            );
            return;
        }

        // Message was already processed — send correction as new prompt
        const userId = edited.from?.id;
        const threadId = edited.message_thread_id || null;
        if (userId == null) return;

        // Auth check
        if (this.#pairing) {
            if (!this.#pairing.isPaired(userId)) {
                log.warn(`Ignoring edit from unpaired user: ${userId}`);
                return;
            }
        } else {
            if (!this.#allowedChatIds.includes(userId)) {
                log.warn(`Ignoring edit from unauthorized user: ${userId}`);
                return;
            }
        }

        const ref = makeRef(chatId, threadId, null, edited.chat.type);
        ref.userId = userId;
        ref.username = edited.from?.username || edited.from?.first_name;

        if (this.#scopeMgr) {
            ref.scopeKey = this.#scopeMgr.resolveKey(ref);
        }

        const prefix = this.#getPrefix(ref);
        const correctionPrompt = prefix + `[CORRECTION — The user edited their previous message. This is NOT a new request. Do NOT re-execute any actions already taken. Just acknowledge the correction or adjust your previous response if needed.]\nCorrected message: ${editedText}`;

        this.#telegram.enqueue(() =>
            this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
        );
        await this.#queuePrompt(correctionPrompt, {}, ref, messageId);
    }

    async #processUpdate(update) {
        // Handle callback queries (inline keyboard buttons)
        if (update.callback_query) {
            await this.#handleCallbackQuery(update.callback_query);
            return;
        }

        // Handle bot membership changes (added/removed from groups)
        if (update.my_chat_member) {
            await this.#handleMembershipChange(update.my_chat_member);
            return;
        }

        // Handle edited messages
        if (update.edited_message) {
            await this.#handleEditedMessage(update.edited_message);
            return;
        }

        const message = update.message;
        if (!message) return;

        const chatId = message.chat.id;
        const userId = message.from?.id;
        const username = message.from?.username || message.from?.first_name || null;
        if (userId == null) return;

        log.info(`Incoming message: chatId=${chatId} userId=${userId} chatType=${message.chat.type} len=${(message.text || "").length}`);

        const threadId = message.message_thread_id || null;
        const isForum = message.chat.is_forum === true;
        let text = message.text || message.caption || "";

        // --- Auth check: pairing-based or legacy allowed_chat_ids ---
        if (this.#pairing) {
            // Update username for known users
            if (this.#pairing.isPaired(userId)) {
                this.#pairing.updateUsername(userId, username);
            } else {
                // Check if user has a pending code — they might be entering it
                if (this.#pairing.hasPendingCode(userId)) {
                    const verified = this.#pairing.verifyCode(userId, text);
                    if (verified) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "✅ Paired successfully! You can now use the bot.")
                        );
                        // Notify admin
                        this.#notifyAdminPairing(userId, username, chatId);
                    } else {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "❌ Invalid or expired code. Check HA logs for a fresh code.")
                        );
                    }
                    return;
                }

                // Not paired — start pairing flow (works in DMs and groups)
                const code = this.#pairing.generateCode(userId, username);
                const isGroup = message.chat.type !== "private";
                const prompt = isGroup
                    ? `🔐 Hi ${username || "there"}! Pairing required.\n\nA code has been generated — check HA add-on logs or ask the admin.\nReply here or DM me with the code.\n\n⏳ Expires in 15 minutes.`
                    : `🔐 Pairing required\n\nA pairing code has been generated.\nCheck your Home Assistant add-on logs and enter the code here.\n\n⏳ Code expires in 15 minutes.`;
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, prompt)
                );
                // Notify admin about new pairing request
                this.#notifyAdminPairingRequest(userId, username, isGroup, chatId);
                return;
            }
        } else {
            // Legacy mode: check allowed_chat_ids
            if (!this.#allowedChatIds.includes(userId)) {
                log.warn(`Ignoring message from unauthorized user: ${userId}`);
                return;
            }
        }

        // --- Group mention filter (non-forum groups only) ---
        const chatType = message.chat.type;
        const groupMode = this.#config.groupMode || "mention";
        if ((chatType === "group" || chatType === "supergroup") && !isForum && groupMode !== "all") {
            const botUsername = this.#telegram.botInfo?.username;
            const botId = this.#telegram.botInfo?.id;

            // Check 1: @mention via Telegram entities
            const entities = message.text ? (message.entities || []) : (message.caption_entities || []);
            const mentioned = entities.some((e) =>
                e.type === "mention" &&
                text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername?.toLowerCase()}`
            );

            // Check 2: Reply to bot message
            const repliedToBot = message.reply_to_message?.from?.id === botId;

            // Check 3: Slash command with @botname
            const commandForBot = text.startsWith("/") &&
                text.toLowerCase().includes(`@${botUsername?.toLowerCase()}`);

            log.debug(`Group filter: mentioned=${mentioned} repliedToBot=${repliedToBot} commandForBot=${commandForBot} entities=${entities?.length || 0}`);

            if (!mentioned && !repliedToBot && !commandForBot) {
                log.debug(`Group message ignored — not addressed to bot`);
                return; // Not addressed to us — silently ignore
            }

            // Strip @botname from the text
            if (botUsername) {
                text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
            }
        }

        if (!this.#checkRateLimit(userId)) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, "⏳ Rate limit reached (10 messages/minute). Please wait.")
            );
            return;
        }

        // Handle pinned messages as agent instructions (after auth check)
        if (message.pinned_message) {
            const chatType = message.chat.type;
            if (chatType === "group" || chatType === "supergroup") {
                const pairingAdmin = this.#pairing?.isAdmin(userId) === true;
                if (!pairingAdmin) {
                    try {
                        const member = await this.#telegram.call("getChatMember", {
                            chat_id: chatId,
                            user_id: userId,
                        });
                        if (!["administrator", "creator"].includes(member?.status)) {
                            log.warn(`Non-admin ${userId} tried to pin instructions in group ${chatId}`);
                            return;
                        }
                    } catch (err) {
                        log.warn(`Rejecting pinned instructions for ${userId} in group ${chatId}: ${err.message}`);
                        return;
                    }
                }
            }

            const pinned = message.pinned_message;
            const pinnedText = (pinned.text || pinned.caption || "").trim().slice(0, 2000);
            if (pinnedText) {
                // Cap to 20 chats to prevent unbounded growth
                if (this.#pinnedInstructions.size >= 20 && !this.#pinnedInstructions.has(chatId)) {
                    const oldest = this.#pinnedInstructions.keys().next().value;
                    this.#pinnedInstructions.delete(oldest);
                }
                const sanitizedPinnedText = this.#sanitizePinnedInstruction(pinnedText);
                this.#pinnedInstructions.set(chatId, sanitizedPinnedText);
                this.resetPreamble(); // force preamble refresh across all scopes
                log.info(`Pinned instruction set for chat=${chatId}: ${sanitizedPinnedText.substring(0, 100)}`);
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, "📌 Noted! This pinned message will be included as context for all future messages in this chat.")
                );
            }
            return;
        }

        // Build ConversationRef with scope resolution
        const ref = makeRef(chatId, threadId, null, message.chat.type);
        ref.userId = userId;
        ref.firstName = message.from?.first_name || null;
        ref.triggerMessageId = message.message_id;

        // Resolve scope
        const scopeKey = this.#scopeMgr ? this.#scopeMgr.resolveKey(ref) : `dm:${userId}`;
        const scope = this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : null;
        ref.scopeKey = scopeKey;
        if (scope?.sessionId) ref.sessionId = scope.sessionId;

        // --- Forum routing ---
        if (isForum && this.#scopeMgr) {
            // Auto-detect forum chat on first message
            if (!this.#scopeMgr.isForumChat(chatId)) {
                this.#scopeMgr.setForumChat(chatId);
                log.info(`Forum chat detected: ${chatId}`);
            }

            // Management topic: commands only, no ACP routing
            if (this.#scopeMgr.isManagementTopic(ref)) {
                if (scope) scope.history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });

                if (message.text?.startsWith("/")) {
                    const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
                    if (parsed) {
                        await handleSlashCommand(this.#buildCommandContext(ref), parsed.command, parsed.args);
                        return;
                    }
                }

                // Non-command in management topic
                this.#telegram.enqueue(() =>
                    this.#transport.send(ref, "💡 This is the management topic. Use commands like /new, /status, /sessions, /help.")
                );
                return;
            }
        }

        // Track incoming user message in history
        if (scope) scope.history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });

        // Check if scope has a pending elicitation or MCP question (text input)
        // Only intercept if the pendingElicitation has a resolve function
        // (not just { reserved: true } from the atomic TOCTOU guard)
        if (scope?.pendingElicitation && typeof scope.pendingElicitation.resolve === "function") {
            // Let /stop and /cancel through to the slash command handler
            if (text.startsWith("/")) {
                const parsed = parseSlashCommand(text, this.#telegram.botInfo?.username);
                if (parsed && (parsed.command === "stop" || parsed.command === "cancel")) {
                    scope.pendingElicitation.resolve(undefined);
                    scope.pendingElicitation = null;
                    // Fall through to slash command handler below
                } else {
                    // Other slash commands: treat as the answer text
                    scope.pendingElicitation.resolve(text);
                    return;
                }
            } else {
                const { resolve, schema } = scope.pendingElicitation;
                let value = text;
                // Type coercion for number/integer schemas
                if (schema?.type === "number" || schema?.type === "integer") {
                    if (!text || !text.trim()) {
                        await this.#telegram.sendMessage(chatId, "⚠️ Please enter a valid number.");
                        return;
                    }
                    const num = Number(text.trim());
                    if (isNaN(num)) {
                        await this.#telegram.sendMessage(chatId, "⚠️ Please enter a valid number.");
                        return;
                    }
                    value = schema.type === "integer" ? Math.round(num) : num;
                }
                resolve(value);
                return;
            }
        }

        // Handle slash commands BEFORE typing
        if (message.text?.startsWith("/")) {
            const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
            if (parsed) {
                const handled = await handleSlashCommand(this.#buildCommandContext(ref), parsed.command, parsed.args);
                if (handled) return;
            }
            // Unknown command — fall through to prompt
        }

        // Start typing
        this.#startTyping(ref);

        // Ensure Copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                this.#stopTyping();
                if (scope?.composer) {
                    await scope.composer.abort(formatError(err));
                    scope.composer = null;
                }
                if (scope) scope.activeTools.clear();
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                return;
            }
        }

        // Build prompt
        const prefix = this.#getPrefix(ref);
        const replyContext = this.#extractReplyContext(message);
        let promptText = prefix + (replyContext ? replyContext + "\n" : "") + (text || "");

        // Handle file attachments
        if (message.photo || message.document) {
            try {
                const attachment = await this.#handleFileAttachment(message);
                if (attachment) {
                    if (attachment.isImage) {
                        await this.#queuePrompt(promptText || prefix + "User sent a file.", {
                            images: [{
                                data: attachment.buffer.toString("base64"),
                                mimeType: attachment.mimeType || "image/png",
                            }],
                        }, ref, message.message_id);
                        return;
                    }
                    if (attachment.textContent) {
                        const fileContext = `User attached file '${attachment.displayName}':\n\`\`\`\n${attachment.textContent}\n\`\`\``;
                        promptText = promptText ? `${fileContext}\n\n${promptText}` : prefix + fileContext;
                        await this.#queuePrompt(promptText, {}, ref, message.message_id);
                        return;
                    }
                    // Non-image, non-text file — let the model know
                    const sizeKB = Math.round(attachment.buffer.length / 1024);
                    const notice = `User attached a file '${attachment.displayName}' (${attachment.mimeType || 'unknown type'}, ${sizeKB}KB) but it's too large or not a text format I can read.`;
                    promptText = promptText ? `${notice}\n\n${promptText}` : prefix + notice;
                    await this.#queuePrompt(promptText, {}, ref, message.message_id);
                    return;
                }
            } catch (err) {
                this.#transport.enqueueSend(ref, formatError(err));
                return;
            }
        }

        // Handle stickers — extract emoji and send as context
        if (message.sticker) {
            const emoji = message.sticker.emoji || "🎭";
            const stickerText = `User sent a sticker: ${emoji}`;
            await this.#queuePrompt(prefix + stickerText, {}, ref, message.message_id);
            return;
        }

        // Handle location — valuable for Home Assistant context
        if (message.location) {
            const { latitude, longitude } = message.location;
            const locationText = `User shared their location: ${latitude}°, ${longitude}°`;
            await this.#queuePrompt(prefix + locationText, {}, ref, message.message_id);
            return;
        }

        // Handle voice messages — friendly rejection with suggestion
        if (message.voice || message.audio) {
            this.#transport.enqueueSend(ref, "🎤 Voice/audio messages aren't supported yet. Please type your message or use your keyboard's speech-to-text button.");
            return;
        }

        // Handle video — friendly rejection with suggestion
        if (message.video || message.video_note) {
            this.#transport.enqueueSend(ref, "🎬 I can't process videos yet. Try sending a screenshot or photo instead!");
            return;
        }

        // Handle animations/GIFs — friendly rejection
        if (message.animation) {
            this.#transport.enqueueSend(ref, "🎞️ I can't process GIFs. Try sending a photo instead!");
            return;
        }

        // Handle contact — friendly rejection
        if (message.contact) {
            this.#transport.enqueueSend(ref, "👤 I can't process contact cards. How can I help you?");
            return;
        }

        // Silently ignore polls (not directed at bot)
        if (message.poll) {
            return;
        }

        if (promptText.trim()) {
            await this.#queuePrompt(promptText, {}, ref, message.message_id);
            return;
        }

        this.#transport.enqueueSend(ref, "Unsupported message type.");
    }

    // --- Session management ---

    /**
     * Ensure the scope has a valid ACP session (switch or create).
     * Returns true if ready, false if failed (caller should return early).
     */
    async #ensureScopeSession(scope, scopeKey, ref) {
        if (scope.sessionId) {
            // Check if we need to switch sessions
            if (this.#scopeMgr && this.#scopeMgr.needsSwitch(scopeKey)) {
                this.#switching = true;
                try {
                    log.debug(`Switching session to ${scope.sessionId} for ${scopeKey}`);
                    await this.#acp.loadSession(scope.sessionId);
                    this.#scopeMgr.setActive(scopeKey);
                } catch (err) {
                    log.warn(`Session load failed for ${scope.sessionId}: ${err.message} — creating new session`);
                    try {
                        const result = await this.#acp.newSession({
                            cwd: this.#config.workingDirectory || "/config",
                        });
                        scope.sessionId = result.sessionId;
                        if (ref) ref.sessionId = result.sessionId;
                        scope.preambleSent = false;
                        if (this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);
                    } catch (createErr) {
                        log.warn(`Fallback session create failed: ${createErr.message}`);
                        const msg = `⚠️ Could not create session: ${createErr.message}`;
                        if (scope.composer?.active) {
                            await scope.composer.abort(msg);
                            scope.composer = null;
                        } else if (ref) {
                            this.#transport.enqueueSend(ref, msg);
                        }
                        this.#promptActive = false;
                        this.#activeRef = null;
                        this.#activeScope = null;
                        this.#scopeMgr?.clearActive();
                        return false;
                    }
                } finally {
                    this.#switching = false;
                }
            }
        } else {
            // New scope — create session
            try {
                log.debug(`Auto-creating session for scope ${scopeKey}`);
                const result = await this.#acp.newSession({
                    cwd: this.#config.workingDirectory || "/config",
                });
                scope.sessionId = result.sessionId;
                if (ref) ref.sessionId = result.sessionId;
                scope.preambleSent = false;
                if (this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);
            } catch (err) {
                log.warn(`Auto-create session failed: ${err.message}`);
                const msg = `⚠️ Failed to create session: ${err.message}`;
                if (scope.composer?.active) {
                    await scope.composer.abort(msg);
                    scope.composer = null;
                } else if (ref) {
                    this.#transport.enqueueSend(ref, msg);
                }
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                this.#scopeMgr?.clearActive();
                return false;
            }
        }
        return true;
    }

    // --- Prompt queue (one at a time) ---

    async #queuePrompt(text, opts = {}, ref = null, messageId = null) {
        const scopeKey = ref?.scopeKey || (this.#scopeMgr && ref ? this.#scopeMgr.resolveKey(ref) : null);

        if (this.#promptActive) {
            const existing = this.#promptQueue.find((p) => p.scopeKey === scopeKey);
            if (existing) {
                existing.text += `

[Follow-up]: ${text}`;
                existing.messageId = messageId;
                existing.ref = ref;
                if (opts?.images?.length) {
                    existing.opts = {
                        ...existing.opts,
                        ...opts,
                        images: [...(existing.opts?.images || []), ...opts.images],
                    };
                } else {
                    existing.opts = { ...existing.opts, ...opts };
                }
                log.debug(`Appended to queued prompt for ${scopeKey}`);
                return;
            }
            if (this.#promptQueue.length >= 10) {
                log.warn("Prompt queue full (10), rejecting new message");
                if (ref) {
                    this.#telegram.enqueue(() =>
                        this.#transport.send(ref, "❌ Queue is full — your message couldn't be processed. Please try again in a minute.")
                    );
                }
                return;
            }
            this.#promptQueue.push({ text, opts, ref, messageId, scopeKey });
            log.debug(`Queue depth: ${this.#promptQueue.length} (added scope=${scopeKey})`);
            // Set ⏳ on the user's message to indicate it's queued
            if (ref && messageId) {
                this.#telegram.setMessageReaction(ref.chatId, messageId, "⏳").catch(() => {});
            }
            // Notify the waiting user
            const pos = this.#promptQueue.length;
            if (ref && pos > 0) {
                const activeScopeKey = this.#activeScope?.key;
                const isSameScope = activeScopeKey === scopeKey;
                if (!isSameScope) {
                    this.#telegram.enqueue(() =>
                        this.#transport.send(ref, `⏳ Queued (#${pos}) — another conversation is in progress. You'll get a response shortly.`)
                    );
                }
            }
            return;
        }
        this.#promptActive = true;

        // Resolve scope for this prompt
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : null;

        // Reset turn-level tracking on scope
        if (scope) {
            scope.turnToolCount = 0;
            scope.turnToolErrors = 0;
            scope.lastBotMessageId = null;
            scope.touch();
        }

        // Set active ref and scope for ACP output routing
        this.#activeRef = ref;
        this.#activeScope = scope;
        if (scopeKey && this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);

        // Create composer for progressive message display
        if (ref && scope) {
            log.debug(`Creating ResponseComposer for chat=${ref.chatId}`);
            scope.composer = new ResponseComposer(this.#telegram);
            try {
                await scope.composer.start(ref);
                log.debug(`Composer started, messageId=${scope.composer.messageId}`);
            } catch (err) {
                log.warn(`Composer start failed: ${err.message}`);
            }
        }

        // Set reaction: ⚡ (now being processed)
        if (ref && messageId) {
            this.#telegram.setMessageReaction(ref.chatId, messageId, "⚡").catch(() => {});
        }

        try {
            // Session switching for scope-based sessions
            if (scope && this.#acp.alive) {
                const sessionOk = await this.#ensureScopeSession(scope, scopeKey, ref);
                if (!sessionOk) return;
            }

            if (scopeKey?.startsWith("group:")) {
                const name = ref?.firstName || `User ${ref?.userId}`;
                text = `[${name}]: ${text}`;
            }

            const promptStartMs = Date.now();
            const result = await this.#acp.prompt(text, opts);
            const elapsed = ((Date.now() - promptStartMs) / 1000).toFixed(1);
            log.info(`Prompt completed: ${scopeKey || 'unknown'} in ${elapsed}s (${scope?.turnToolCount || 0} tool calls${scope?.turnToolErrors ? `, ${scope.turnToolErrors} errors` : ''})`);
        } catch (err) {
            // Skip error handling if this prompt was cancelled due to a message edit
            if (this.#editCancelled) {
                log.info(`Prompt cancelled (edit): ${err.message}`);
            } else {
                log.error(`Prompt error: ${err.message}`);
                if (scope) scope.turnToolErrors++;
                const userMsg = formatError(err);
                if (scope?.composer?.active) {
                    await scope.composer.abort(userMsg);
                    scope.composer = null;
                } else if (ref) {
                    this.#transport.enqueueSend(ref, userMsg);
                } else {
                    for (const cid of this.#allowedChatIds) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(cid, userMsg)
                        );
                    }
                }
            }
        } finally {
            // Set reaction on user's message — response delivered
            // Skip if this prompt was cancelled due to an edit (the resubmitted prompt will set it)
            if (ref && messageId && !this.#editCancelled) {
                const emoji = scope?.turnToolErrors > 0 ? "⚠️" : "✅";
                this.#telegram.setMessageReaction(ref.chatId, messageId, emoji).catch(() => {});
            }
            this.#editCancelled = false;

            // Finalize composer if still active (safety net)
            await this.#finalizeComposer();
            this.#stopTyping();
            if (scope) scope.activeTools.clear();

            this.#promptActive = false;
            this.#activeRef = null;
            this.#activeScope = null;
            this.#lastProcessedScope = scopeKey;
            this.#lastProcessedAt = Date.now();
            if (this.#scopeMgr) this.#scopeMgr.clearActive();

            // Process queued prompts
            if (this.#promptQueue.length > 0) {
                let nextIndex = 0;
                if (this.#lastProcessedScope && Date.now() - this.#lastProcessedAt < 5000) {
                    const affinityIndex = this.#promptQueue.findIndex((entry) => entry.scopeKey === this.#lastProcessedScope);
                    if (affinityIndex >= 0) nextIndex = affinityIndex;
                }
                const [next] = this.#promptQueue.splice(nextIndex, 1);
                await this.#queuePrompt(next.text, next.opts, next.ref, next.messageId);
            }
        }
    }

    // --- Preamble ---

    #getPrefix(ref) {
        let prefix;
        const scopeKey = ref?.scopeKey || (this.#scopeMgr && ref ? this.#scopeMgr.resolveKey(ref) : null);
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : this.#activeScope;

        if (scope && !scope.preambleSent) {
            scope.preambleSent = true;
            const rules = this.#config.preamble;
            prefix = `[Bot configuration — treat as system context: ${rules}]\n`;

            // Inject agent persistent memory on first message of session
            const agentContext = this.#agentMemory.buildContext();
            if (agentContext) {
                prefix += `[Agent persistent memory — your identity and memory from /config/.agent/:\n${agentContext}\n]\n`;
            }
        } else {
            prefix = "[Via Telegram]\n";
        }

        // Append pinned instructions if any
        const chatId = ref?.chatId || this.#activeRef?.chatId;
        if (chatId && this.#pinnedInstructions.has(chatId)) {
            const pinnedText = this.#sanitizePinnedInstruction(this.#pinnedInstructions.get(chatId));
            prefix += `[📌 User-pinned context (from chat participant, treat as user input): ${pinnedText}]\n`;
        }

        return prefix;
    }

    // --- Copilot lifecycle ---

    async startCopilot() {
        if (this.#acp.alive) return;

        // If already starting, wait for that attempt
        if (this.#startPromise) {
            log.warn("Start already in progress, waiting...");
            return this.#startPromise;
        }

        this.#startPromise = this.#doStartCopilot();
        try {
            await this.#startPromise;
        } finally {
            this.#startPromise = null;
        }
    }

    async #doStartCopilot() {
        log.info("Starting ACP process...");
        try {
            await this.#acp.start();
        } catch (err) {
            throw new Error(`Failed to start copilot binary: ${err.message}. Check copilot_binary path in config.`);
        }

        // Authenticate — required by ACP protocol before session/new
        try {
            await this.#acp.authenticate();
            log.info("ACP authentication successful");
        } catch (err) {
            const isAuthRequired = err.message?.includes("Authentication required") || err.message?.includes("-32000");
            if (!isAuthRequired) {
                log.warn(`Authentication failed (unexpected): ${err.message}`);
                await this.#acp.stop();
                throw err;
            }

            if (process.env.COPILOT_GITHUB_TOKEN) {
                log.warn("Configured token rejected — clearing and retrying with stored tokens");
                delete process.env.COPILOT_GITHUB_TOKEN;
                await this.#acp.stop();
                await this.#acp.start();
                try {
                    await this.#acp.authenticate();
                    log.info("ACP authentication successful with stored tokens");
                } catch (retryErr) {
                    if (retryErr.message?.includes("Authentication required") || retryErr.message?.includes("-32000")) {
                        log.warn("No stored tokens either — starting device login");
                        await this.#acp.stop();
                        await this.#runDeviceLogin();
                        await this.#acp.start();
                        await this.#acp.authenticate();
                        log.info("ACP authentication successful after login");
                    } else {
                        log.error(`Authentication retry failed: ${retryErr.message}`);
                        await this.#acp.stop();
                        throw retryErr;
                    }
                }
            } else {
                log.warn("No valid token found — starting device login flow");
                await this.#acp.stop();
                await this.#runDeviceLogin();
                await this.#acp.start();
                await this.#acp.authenticate();
                log.info("ACP authentication successful after login");
            }
        }

        // Create session (small delay to let auth propagate in the ACP process)
        await new Promise(r => setTimeout(r, 500));
        log.info("Creating new ACP session...");
        try {
            await this.#acp.newSession({
                cwd: this.#config.workingDirectory || "/config",
            });
        } catch (err) {
            if (err.message?.includes("-32000")) {
                throw new Error(`Session creation failed: ${err.message}. This usually means the copilot token is expired or COPILOT_HOME is misconfigured.`);
            }
            throw new Error(`Session creation failed: ${err.message}`);
        }

        // Clear stale scope sessionIds — old ACP sessions don't survive restart
        if (this.#scopeMgr) {
            this.#scopeMgr.clearAllSessions();
            log.info("Cleared stale scope sessions after ACP restart");
        }
        this.resetPreamble();
        log.info(`Copilot started, session: ${this.#acp.sessionId}`);
        this.#refreshStatusIfAlive().catch(() => {});
    }

    async #runDeviceLogin() {
        // If PAT token is configured, no login needed
        if (process.env.COPILOT_GITHUB_TOKEN) {
            log.info("GitHub token configured — skipping device login");
            return;
        }

        // If login is already in progress, wait for that one
        if (this.#loginPromise) {
            log.warn("Login already in progress, waiting...");
            return this.#loginPromise;
        }

        log.info("Authentication required — starting device login flow...");
        const binary = this.#config.copilotBinary || "/share/copilot-tools/copilot";

        this.#loginPromise = new Promise((resolve, reject) => {
            // Spawn the configured binary directly so it is never interpreted by a shell.
            log.info(`[login] Spawning: ${binary} login`);
            const proc = spawn(binary, ["login"], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env },
            });
            const sendAutoConfirm = () => {
                if (proc.stdin && !proc.stdin.destroyed && proc.exitCode === null) {
                    proc.stdin.write("y\n");
                }
            };
            sendAutoConfirm();
            const yesInterval = setInterval(sendAutoConfirm, 100);
            const clearAutoConfirm = () => clearInterval(yesInterval);
            proc.stdin?.on("error", () => {});

            let stdout = "";
            let stderr = "";
            let codeSent = false;
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    clearAutoConfirm();
                    log.error("[login] Timed out after 10 minutes");
                    proc.kill();
                    this.#broadcastAdmin("⏰ Login timed out. Send any message to get a fresh code.");
                    reject(new Error("Login timed out"));
                }
            }, 10 * 60 * 1000);

            proc.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                stdout += text;
                log.debug(`[login] stdout: ${text.trim()}`);
                if (!codeSent) {
                    const match = stdout.match(/enter code ([A-Z0-9]{4}-[A-Z0-9]{4})/);
                    if (match) {
                        codeSent = true;
                        const code = match[1];
                        log.info(`[login] Device code: ${code}`);
                        this.#broadcastAdmin(
                            `🔐 GitHub authentication required\n\n` +
                            `1️⃣ Visit: https://github.com/login/device\n` +
                            `2️⃣ Enter code: ${code}\n\n` +
                            `⏳ Waiting for you to authorize...\n` +
                            `(One-time setup — takes 30 seconds)`
                        );
                    }
                }
            });

            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString().trim();
                if (text) {
                    stderr += text + "\n";
                    log.debug(`[login] stderr: ${text}`);
                }
            });

            proc.on("close", (exitCode) => {
                clearTimeout(timeout);
                clearAutoConfirm();
                this.#loginPromise = null;
                if (resolved) return;
                resolved = true;
                log.info(`[login] Process exited with code ${exitCode}`);
                if (stderr) log.debug(`[login] stderr: ${stderr.trim()}`);

                // Always resolve — the caller will verify auth via acp.authenticate()
                // Login may exit non-zero due to browser/clipboard warnings in containers
                this.#broadcastAdmin("✅ Login flow completed — verifying token...");
                resolve();
            });

            proc.on("error", (err) => {
                clearTimeout(timeout);
                clearAutoConfirm();
                this.#loginPromise = null;
                if (!resolved) {
                    resolved = true;
                    log.error(`[login] Spawn error: ${err.message}`);
                    reject(err);
                }
            });
        });

        return this.#loginPromise;
    }

    async stopCopilot() {
        await this.#acp.stop();
        this.resetPreamble();
    }

    async restartCopilot() {
        await this.stopCopilot();
        this.#knownTools.clear();
        await this.startCopilot();
    }

    // --- Reply-to context extraction ---

    #extractReplyContext(message) {
        const reply = message.reply_to_message;
        log.debug(`Reply chain: reply_to_message=${reply ? `msgId=${reply.message_id} from=${reply.from?.username || reply.from?.id}` : "none"}`);
        if (!reply) return "";

        const replyMsgId = reply.message_id;
        const scope = this.#activeScope;
        const history = scope?.history;

        // Try to walk the chain using scope's history (which tracks replyToMessageId)
        const historyChain = history ? history.getReplyChain(replyMsgId, 5, 2000) : [];

        if (historyChain.length > 0) {
            log.debug(`Reply chain from history: ${historyChain.length} messages`);

            if (historyChain.length === 1) {
                const c = historyChain[0];
                const source = c.role === "bot" ? "Replying to bot" : "Replying to user";
                return `[${source}: "${c.text}"]`;
            }

            const formatted = historyChain.map(c => {
                const who = c.role === "bot" ? "🤖" : "👤";
                return `${who} ${c.text}`;
            }).join("\n");
            return `[Reply thread (${historyChain.length} messages):\n${formatted}]`;
        }

        // Fallback: use the immediate reply_to_message from Telegram
        const isBotMsg = reply.from?.is_bot;
        let text = reply.text || reply.caption || "";
        if (!text) {
            if (reply.photo) text = "<photo>";
            else if (reply.sticker) text = `<sticker: ${reply.sticker.emoji || "🎴"}>`;
            else if (reply.voice) text = "<voice message>";
            else if (reply.video) text = "<video>";
            else if (reply.document) text = `<file: ${reply.document.file_name || "document"}>`;
            else text = "<message>";
        }
        if (text.length > 500) text = text.substring(0, 500) + "…";

        const source = isBotMsg ? "Replying to bot" : "Replying to user";
        log.debug(`Reply chain fallback (Telegram only): 1 message`);
        return `[${source}: "${text}"]`;
    }

    // --- File handling ---

    static #TEXT_MIMES = new Set([
        'text/plain', 'text/csv', 'text/html', 'text/xml', 'text/yaml', 'text/markdown',
        'application/json', 'application/yaml', 'application/x-yaml', 'application/xml',
        'application/javascript', 'application/typescript', 'application/toml', 'application/x-sh',
    ]);
    static #TEXT_EXTENSIONS = new Set([
        '.yaml', '.yml', '.json', '.txt', '.csv', '.log', '.md', '.py', '.js', '.ts',
        '.sh', '.xml', '.toml', '.cfg', '.ini', '.conf', '.env', '.html', '.css',
    ]);
    static #TEXT_FILE_MAX_BYTES = 50 * 1024;

    async #handleFileAttachment(message) {
        let fileId, displayName, isImage = false;
        if (message.photo?.length > 0) {
            const photo = message.photo[message.photo.length - 1];
            fileId = photo.file_id;
            displayName = `photo_${message.message_id}.jpg`;
            isImage = true;
        } else if (message.document) {
            fileId = message.document.file_id;
            displayName = message.document.file_name || `document_${message.message_id}`;
            isImage = PHOTO_MIMES.has(message.document.mime_type);
        }
        if (!fileId) return null;

        const fileInfo = await this.#telegram.getFile(fileId);
        const buffer = await this.#telegram.downloadFile(fileInfo.file_path);
        const mimeType = message.document?.mime_type || '';

        let textContent = null;
        if (!isImage && buffer.length <= Bridge.#TEXT_FILE_MAX_BYTES) {
            const ext = displayName ? '.' + displayName.split('.').pop().toLowerCase() : '';
            if (Bridge.#TEXT_MIMES.has(mimeType) || Bridge.#TEXT_EXTENSIONS.has(ext)) {
                textContent = buffer.toString('utf-8');
            }
        }

        return { buffer, displayName, isImage, mimeType, textContent };
    }

    // --- Response Composer lifecycle ---

    async #finalizeComposer(getScope, getRef) {
        const scope = getScope ? getScope() : this.#activeScope;
        if (!scope?.composer) {
            this.#flushMessageBuffer(getScope, getRef);
            return;
        }

        const composer = scope.composer;
        scope.composer = null;

        if (scope.messageFlushTimer) {
            clearTimeout(scope.messageFlushTimer);
            scope.messageFlushTimer = null;
        }

        const fullText = scope.messageBuffer.trim();
        scope.messageBuffer = "";

        if (!fullText && !composer.active) {
            await composer.cleanup();
            return;
        }

        let botHistoryEntry = null;
        if (fullText && scope.history) {
            botHistoryEntry = { role: "bot", text: fullText, messageId: null };
            scope.history.push(botHistoryEntry);
        }

        try {
            const overflow = await composer.finalize(fullText);

            if (composer.messageId) {
                scope.lastBotMessageId = composer.messageId;
            }

            if (overflow?.length > 0) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    for (let i = 0; i < overflow.length; i++) {
                        const chunk = overflow[i];
                        const chunkIndex = i;
                        this.#telegram.enqueue(async () => {
                            const html = markdownToTelegramHtml(chunk);
                            let sent;
                            try {
                                sent = await this.#transport.send(ref, html, "HTML");
                            } catch (err) {
                                if (err.message && /can.t parse|entit/i.test(err.message)) {
                                    sent = await this.#transport.send(ref, chunk);
                                } else { throw err; }
                            }
                            if (sent?.message_id) {
                                scope.lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0 && scope.history) {
                                    scope.history.push({
                                        role: "bot", text: `(continued)`, messageId: sent.message_id,
                                        replyToMessageId: botHistoryEntry?.messageId,
                                    });
                                }
                            }
                        });
                    }
                }
            } else if (botHistoryEntry && composer.messageId) {
                botHistoryEntry.messageId = composer.messageId;
            }

            // Send collapsible details (reasoning + steps) as trailing message
            if (composer.trailingHtml) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    const detailsHtml = composer.trailingHtml;
                    this.#telegram.enqueue(async () => {
                        try {
                            await this.#transport.send(ref, detailsHtml, "HTML");
                        } catch (err) {
                            log.error(`Trailing details send failed: ${err.message}`);
                        }
                    });
                }
            }
        } catch (err) {
            log.error(`Composer finalize error: ${err.message}`);
            if (fullText) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    const chunks = chunkMessage(fullText);
                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkIndex = i;
                        this.#telegram.enqueue(async () => {
                            const html = markdownToTelegramHtml(chunk);
                            let sent;
                            try {
                                sent = await this.#transport.send(ref, html, "HTML");
                            } catch (sendErr) {
                                if (sendErr.message && /can.t parse|entit/i.test(sendErr.message)) {
                                    sent = await this.#transport.send(ref, chunk);
                                } else { throw sendErr; }
                            }
                            if (sent?.message_id) {
                                scope.lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0 && scope.history) {
                                    scope.history.push({
                                        role: "bot", text: `(continued)`, messageId: sent.message_id,
                                        replyToMessageId: botHistoryEntry?.messageId,
                                    });
                                }
                            }
                        });
                    }
                }
            }
        }
    }

    // --- Message buffer (accumulate chunks → send) ---

    #flushMessageBuffer(getScope, getRef) {
        const scope = getScope ? getScope() : this.#activeScope;
        if (scope?.messageFlushTimer) {
            clearTimeout(scope.messageFlushTimer);
            scope.messageFlushTimer = null;
        }
        if (!scope?.messageBuffer?.trim()) return;

        const content = scope.messageBuffer;
        scope.messageBuffer = "";

        const chunks = chunkMessage(content);
        const ref = getRef ? getRef() : this.#activeRef;

        if (ref) {
            for (const chunk of chunks) {
                this.#telegram.enqueue(() => this.#sendFormatted(ref, chunk));
            }
        } else {
            for (const chatId of this.#allowedChatIds) {
                const fallbackRef = makeRef(chatId);
                for (const chunk of chunks) {
                    this.#telegram.enqueue(() => this.#sendFormatted(fallbackRef, chunk));
                }
            }
        }
    }

    async #sendFormatted(ref, markdown, scope) {
        const html = markdownToTelegramHtml(markdown);
        const resolvedScope = scope || this.#activeScope;
        let sent;
        try {
            sent = await this.#transport.send(ref, html, "HTML");
        } catch (err) {
            if (err.message && /can.t parse|entit/i.test(err.message)) {
                sent = await this.#transport.send(ref, markdown);
            } else {
                throw err;
            }
        }
        if (sent?.message_id) {
            if (resolvedScope) resolvedScope.lastBotMessageId = sent.message_id;
            if (resolvedScope?.history) resolvedScope.history.push({ role: "bot", text: markdown, messageId: sent.message_id });
        }
        return sent;
    }

    #isSafeUndoAction(domain, service, entityId) {
        return typeof domain === "string"
            && typeof service === "string"
            && typeof entityId === "string"
            && UNDO_ALLOWED_DOMAINS.has(domain)
            && UNDO_ALLOWED_SERVICES.has(service)
            && UNDO_ENTITY_ID_RE.test(entityId);
    }

    // --- Tool notifications for interactive mode ---

    #showToolNotification(toolName, result, getScope, getRef) {
        const scope = getScope ? getScope() : this.#activeScope;
        log.debug(`Tool notification check: ${toolName}, allowAll=${scope?.allowAll}`);

        // Only notify for HA write tools
        const writeTools = new Set([
            "ha-mcp-ha_call_service", "ha-mcp-ha_call_event",
            "ha-mcp-ha_bulk_control", "ha-mcp-ha_backup_create",
            "ha-mcp-ha_backup_restore", "ha-mcp-ha_remove_entity",
            "ha-mcp-ha_config_set_automation",
        ]);
        if (!writeTools.has(toolName)) {
            log.debug(`Tool notification skipped: ${toolName} not a write tool`);
            return;
        }

        // Parse result to build notification — handle multiple formats
        let content;
        try {
            let raw;
            if (typeof result === "string") {
                raw = result;
            } else if (typeof result?.content === "string") {
                raw = result.content;
            } else if (Array.isArray(result)) {
                // ACP content blocks array: [{type:"content", content:{type:"text", text:"..."}}]
                const textBlock = result.find(b => b?.content?.type === "text");
                raw = textBlock?.content?.text || JSON.stringify(result);
            } else {
                raw = JSON.stringify(result);
            }
            content = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {
            log.debug(`Tool notification parse error: ${e.message}`);
            content = {};
        }

        const domain = content?.domain || "";
        const service = content?.service || "";
        const entityId = content?.entity_id || "";
        const success = content?.success !== false;

        log.debug(`Tool notification parsed: ${domain}.${service} → ${entityId} success=${success}`);

        if (!domain && !service) return;

        const emoji = success ? "⚡" : "❌";
        const action = `${domain}.${service}`;
        const target = entityId ? ` → ${entityId}` : "";
        const text = `${emoji} ${action}${target}`;

        // Determine undo action (reversible services)
        const reverseService = UNDO_REVERSE_MAP[service];

        const ref = getRef ? getRef() : this.#activeRef;
        const undoRef = ref ? {
            ...ref,
            scopeKey: ref.scopeKey || (getScope ? getScope() : this.#activeScope)?.key || null,
        } : null;
        const chatId = undoRef?.chatId || this.#allowedChatIds?.[0];
        if (!chatId) return;

        if (success && this.#isSafeUndoAction(domain, reverseService, entityId)) {
            // Show with undo button
            const encodedUserId = this.#encodeCallbackUserId(undoRef?.userId);
            const undoValue = encodedUserId ? `undo:${encodedUserId}` : "undo";
            const rows = [[
                { text: "↩️ Undo", value: undoValue },
                { text: "✅ OK", value: "dismiss" },
            ]];
            log.info(`Sending undo notification to chat ${chatId}: ${text}`);
            this.#buttons.prompt(chatId, text, rows, {
                timeoutMs: 30000,
                timeoutText: null, // silently expire
            }).then(({ value: selected }) => {
                if (selected !== undoValue || !undoRef) return;

                log.info(`Undo: ${domain}.${reverseService} → ${entityId}`);
                // Send undo command via the original scope, even if another scope is active now.
                this.#queuePrompt(
                    `Please call service ${domain}.${reverseService} on entity ${entityId} to undo the previous action. Do it immediately without asking.`,
                    {}, undoRef, null
                );
            }).catch(err => {
                log.error(`Tool notification error: ${err.message}`);
            });
        } else {
            // Just show notification (no undo available)
            const extra = ref?.threadId ? { message_thread_id: ref.threadId } : {};
            this.#telegram.enqueue(() =>
                this.#telegram.call("sendMessage", { chat_id: chatId, text, disable_notification: true, ...extra })
            );
        }
    }

    // --- Relay images from tool results ---

    #relayToolImages(result, getRef) {
        const contents = result?.contents;
        if (!contents || !Array.isArray(contents)) return;

        for (const block of contents) {
            if (block.type === "image" && block.data && block.mimeType) {
                const bytes = Math.ceil(block.data.length * 3 / 4);
                const ref = getRef ? getRef() : this.#activeRef;
                const targets = ref ? [ref] : this.#allowedChatIds.map(id => makeRef(id));

                for (const targetRef of targets) {
                    if (bytes > MAX_PHOTO_BYTES) {
                        this.#telegram.enqueue(() =>
                            this.#transport.send(targetRef, "(Image too large for Telegram, >10MB)")
                        );
                        continue;
                    }
                    const buf = Buffer.from(block.data, "base64");
                    if (PHOTO_MIMES.has(block.mimeType)) {
                        this.#telegram.enqueue(() => this.#transport.sendPhoto(targetRef, buf, block.mimeType));
                    } else {
                        const ext = block.mimeType.split("/")[1] || "bin";
                        this.#telegram.enqueue(() =>
                            this.#transport.sendDocument(targetRef, buf, block.mimeType, `image.${ext}`)
                        );
                    }
                }
            }
        }
    }

    // --- Typing indicators ---

    #startTyping(ref) {
        this.#stopTyping();
        const doType = () => {
            const targetRef = ref || this.#activeRef;
            if (targetRef) {
                this.#telegram.enqueue(() => this.#transport.sendChatAction(targetRef).catch(() => {}));
            } else {
                for (const chatId of this.#allowedChatIds) {
                    this.#telegram.enqueue(() => this.#telegram.sendChatAction(chatId).catch(() => {}));
                }
            }
        };
        doType();
        this.#typingInterval = setInterval(doType, TYPING_INTERVAL_MS);
        this.#resetTypingDebounce();
    }

    #resetTypingDebounce() {
        if (this.#typingDebounce) clearTimeout(this.#typingDebounce);
        this.#typingDebounce = setTimeout(() => this.#stopTyping(), TYPING_DEBOUNCE_MS);
    }

    #stopTyping() {
        if (this.#typingInterval) { clearInterval(this.#typingInterval); this.#typingInterval = null; }
        if (this.#typingDebounce) { clearTimeout(this.#typingDebounce); this.#typingDebounce = null; }
    }

    // --- Broadcast to admin chats ---

    #broadcastAdmin(text) {
        for (const chatId of this.#allowedChatIds) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, text)
            );
        }
    }

    /** Notify first admin that someone is requesting to pair. */
    #notifyAdminPairingRequest(userId, username, isGroup, sourceChatId) {
        const adminChatId = this.#allowedChatIds[0];
        if (!adminChatId || adminChatId === userId) return; // don't notify yourself
        const who = username ? `@${username}` : `User ${userId}`;
        const where = isGroup ? ` (from a group)` : ``;
        this.#telegram.enqueue(() =>
            this.#telegram.sendMessage(adminChatId,
                `🔐 Pairing request${where}\n\n` +
                `👤 ${who} (ID: ${userId})\n` +
                `📋 Code is in the add-on logs`
            )
        );
    }

    /** Notify first admin that someone paired successfully. */
    #notifyAdminPairing(userId, username, sourceChatId) {
        const adminChatId = this.#allowedChatIds[0];
        if (!adminChatId || adminChatId === userId) return;
        const who = username ? `@${username}` : `User ${userId}`;
        this.#telegram.enqueue(() =>
            this.#telegram.sendMessage(adminChatId, `✅ ${who} (ID: ${userId}) paired successfully!`)
        );
    }

    // --- Cleanup ---

    cleanup() {
        this.#stopTyping();
        const scope = this.#activeScope;
        if (scope) scope.activeTools.clear();
        if (scope?.messageFlushTimer) clearTimeout(scope.messageFlushTimer);
        if (this.#scopeMgr) this.#scopeMgr.shutdown();
    }
}
