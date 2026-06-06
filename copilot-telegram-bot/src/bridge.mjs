// ============================================================
// Bridge — Telegram ↔ Copilot ACP Orchestrator
// ============================================================
// Handles message routing, typing indicators, tool call bubbles,
// file attachments, and session lifecycle.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "./transport/telegram/formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { normalizeModeId } from "./ai/copilot/acp-client.mjs";
import { ButtonManager } from "./transport/telegram/buttons.mjs";
import { ResponseComposer } from "./transport/telegram/response-composer.mjs";
import { formatError } from "./core/errors.mjs";
import { MessageTransport, makeRef } from "./transport/telegram/transport-ref.mjs";
import { AgentMemory } from "./core/agent-memory.mjs";
import { PromptBuilder, sanitizePinnedInstruction } from "./ai/copilot/prompt-builder.mjs";
import { CopilotLifecycle } from "./ai/copilot/lifecycle.mjs";
import { PermissionHandler, extractCallbackTargetUserId } from "./ai/copilot/permissions.mjs";
import { InteractiveFlows } from "./ai/copilot/interactive-flows.mjs";
import { StatusMenu } from "./core/status.mjs";
import { ToolNotifications } from "./core/tool-notifications.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger('bridge');

const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Prompt watchdog: auto-cancel hung prompts
const SI_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes for SI-triggered prompts
const USER_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes for user-interactive prompts
const CANCEL_GRACE_MS = 15_000;                  // 15s after cancel before force-kill
const HEARTBEAT_INTERVAL_MS = 60_000;            // log heartbeat every 60s during active prompt

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

    // Prompt watchdog (auto-cancel hung prompts)
    #watchdogTimer = null;
    #heartbeatTimer = null;
    #promptStartedAt = 0;
    #promptGeneration = 0;  // incremented on each prompt; prevents stale force-cancel
    #intentionalKill = false; // set true before force-killing ACP to preserve queue


    // Prompt builder (extracted module)
    #promptBuilder;

    // Copilot lifecycle manager (extracted module)
    #lifecycle;

    // Button manager for inline keyboards
    #buttons;

    // Global session state (shared across all scopes)
    #models = [];
    #modes = [];
    #availableCommands = [];  // Copilot slash commands from ACP
    #knownTools = new Map();  // MCP tool names seen → description

    // Active status menu — managed by StatusMenu module
    #statusMenu;

    // Permission handler (extracted module)
    #permissionHandler;

    // Interactive flows — elicitation + MCP ask_user (extracted module)
    #interactiveFlows;

    // Tool notifications (extracted module)
    #toolNotify;

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

        // Extracted modules
        this.#promptBuilder = new PromptBuilder({
            config,
            agentMemory: this.#agentMemory,
            scopeMgr: this.#scopeMgr,
            pinnedInstructions: this.#pinnedInstructions,
            getActiveScope: () => this.#activeScope,
            getActiveRef: () => this.#activeRef,
        });

        this.#statusMenu = new StatusMenu({
            telegram,
            acp: this.#acp,
            config,
            scopeMgr: this.#scopeMgr,
            getActiveScope: () => this.#activeScope,
            getModels: () => this.#models,
            getModes: () => this.#modes,
            getAllowedChatIds: () => this.#allowedChatIds,
            getPairing: () => this.#pairing,
            getStandingOrchestrator: () => this.standingOrchestrator,
        });

        this.#lifecycle = new CopilotLifecycle({
            acp: this.#acp,
            config,
            scopeMgr: this.#scopeMgr,
            resetPreamble: () => this.resetPreamble(),
            refreshStatus: () => this.#statusMenu.refreshIfAlive(),
            clearKnownTools: () => this.#knownTools.clear(),
            broadcastAdmin: (text) => this.#broadcastAdmin(text),
        });

        this.#permissionHandler = new PermissionHandler({
            buttons: this.#buttons,
            getAllowedChatIds: () => this.#allowedChatIds,
        });

        this.#interactiveFlows = new InteractiveFlows({
            buttons: this.#buttons,
            telegram,
            acp: this.#acp,
            scopeMgr: this.#scopeMgr,
            getActiveScope: () => this.#activeScope,
            getOverflowScope: () => this.#overflowScope,
            getActiveRef: () => this.#activeRef,
            getAllowedChatIds: () => this.#allowedChatIds,
        });

        this.#toolNotify = new ToolNotifications({
            buttons: this.#buttons,
            telegram,
            getAllowedChatIds: () => this.#allowedChatIds,
            getActiveScope: () => this.#activeScope,
            getActiveRef: () => this.#activeRef,
            queuePrompt: (text, opts, ref, messageId) => this.#queuePrompt(text, opts, ref, messageId),
        });
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
        this.#promptBuilder.resetPreamble();
    }

    /** Best-effort notification before process exit. */
    async notifyShutdown() {
        const promises = [];
        const scope = this.#activeScope;

        // Cancel any queued MCP questions
        this.#interactiveFlows.cancelQuestionQueue("Bot shutting down");

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
        promises.push(this.#statusMenu.handleShutdown());

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
        this.#interactiveFlows.stopUdsServer();
        this.#buttons.destroy();
    }

    /** Re-submit a message as if the user sent it (for /retry) */
    submitRetry(ref, text) {
        this.#queuePrompt(this.#promptBuilder.getPrefix(ref) + text, {}, ref);
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
        const prefix = this.#promptBuilder.getPrefix(ref);
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

        // Fire-and-forget but handle promise rejection properly
        this.#queuePrompt(prefix + text, {}, ref).catch(err => {
            log.error(`Injected prompt failed: ${err.message}`);
        });
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
        const { notifyIfMissing = true, force = false } = opts;
        const requestedKey = this.#resolveScopeKey(scope, ref);

        // Cancel any queued questions for this scope
        this.#interactiveFlows.cancelQuestionQueue("User cancelled");

        if (this.#promptActive && (force || !requestedKey || this.#activeScope?.key === requestedKey)) {
            await this.#acp.cancel();
            return true;
        }

        if (notifyIfMissing && ref) {
            this.#transport.enqueueSend(ref, "ℹ️ No active request in this conversation to cancel.");
        }
        return false;
    }

    /**
     * Force-cancel the active prompt. Attempts graceful cancel first,
     * then kills the ACP process if it doesn't respond within CANCEL_GRACE_MS.
     * @param {string} reason - why we're cancelling
     * @param {number} generation - the prompt generation that triggered this cancel
     */
    async #forceCancel(reason, generation) {
        if (!this.#promptActive) return;
        log.warn(`Force cancel: ${reason} (generation=${generation})`);

        // Attempt graceful cancel
        try {
            await this.#acp.cancel();
        } catch (err) {
            log.warn(`Cancel RPC failed: ${err.message}`);
        }

        // Check if the original prompt already ended (cancel worked or prompt completed)
        if (this.#promptGeneration !== generation) {
            log.info("Force cancel: prompt generation changed — cancel was effective, skipping kill");
            return;
        }

        // Wait for the prompt to finish gracefully
        if (this.#promptActive && this.#acp.alive) {
            log.info(`Waiting ${CANCEL_GRACE_MS / 1000}s for graceful cancellation...`);
            await new Promise(r => setTimeout(r, CANCEL_GRACE_MS));
        }

        // Re-check generation — a new prompt may have started during grace period
        if (this.#promptGeneration !== generation) {
            log.info("Force cancel: prompt generation changed during grace period — aborting kill");
            return;
        }

        // If still stuck, kill the ACP process
        if (this.#promptActive && this.#acp.alive) {
            log.error("Prompt still active after cancel grace period — killing ACP process");
            this.#intentionalKill = true;
            try {
                await this.#acp.stop();
            } catch (err) {
                log.error(`ACP force-kill error: ${err.message}`);
            }
        }
    }

    /** Start watchdog and heartbeat timers for the active prompt. */
    #startPromptWatchdog(scopeKey) {
        this.#promptStartedAt = Date.now();
        const generation = this.#promptGeneration;
        const isStanding = scopeKey?.startsWith("standing:");
        const timeoutMs = isStanding ? SI_PROMPT_TIMEOUT_MS : USER_PROMPT_TIMEOUT_MS;

        // Watchdog: force-cancel after timeout
        this.#watchdogTimer = setTimeout(() => {
            const elapsed = ((Date.now() - this.#promptStartedAt) / 60000).toFixed(1);
            const lastSeen = this.#acp.lastMessageAt
                ? `${((Date.now() - this.#acp.lastMessageAt) / 1000).toFixed(0)}s ago (${this.#acp.lastMessageType})`
                : "never";
            const msg = `Prompt timeout after ${elapsed}min — scope=${scopeKey}, ACP last seen: ${lastSeen}, pending RPCs: ${this.#acp.pendingCount}`;
            log.error(`⏰ ${msg}`);

            // Notify user
            this.#broadcastAdmin(`⏰ Prompt watchdog triggered\n${msg}\nForce-cancelling...`);

            this.#forceCancel(`watchdog timeout (${elapsed}min)`, generation).catch(err => {
                log.error(`Force cancel from watchdog failed: ${err.message}`);
            });
        }, timeoutMs);
        this.#watchdogTimer.unref?.();

        // Heartbeat: periodic health logging during active prompts
        this.#heartbeatTimer = setInterval(() => {
            const elapsed = ((Date.now() - this.#promptStartedAt) / 1000).toFixed(0);
            const lastSeen = this.#acp.lastMessageAt
                ? `${((Date.now() - this.#acp.lastMessageAt) / 1000).toFixed(0)}s ago (${this.#acp.lastMessageType})`
                : "never";
            const tools = this.#activeScope?.activeTools?.size || 0;
            log.info(`💓 Prompt heartbeat: scope=${scopeKey}, elapsed=${elapsed}s, ACP last msg: ${lastSeen}, active tools: ${tools}, pending RPCs: ${this.#acp.pendingCount}, queue: ${this.#promptQueue.length}`);
        }, HEARTBEAT_INTERVAL_MS);
        this.#heartbeatTimer.unref?.();
    }

    /** Clear watchdog and heartbeat timers. */
    #clearPromptWatchdog() {
        if (this.#watchdogTimer) {
            clearTimeout(this.#watchdogTimer);
            this.#watchdogTimer = null;
        }
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
    }

    // --- Status menu (delegated to StatusMenu module) ---

    async showStatusMenu(chatId, scope = null) {
        await this.#statusMenu.show(chatId, scope);
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
        this.#interactiveFlows.startUdsServer();
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
                this.#toolNotify.showToolNotification(completed.name, result, getScope, getRef);
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
                this.#statusMenu.refreshIfAlive();
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
            await this.#permissionHandler.handlePermissionRequest(req, acp, scope, getRef, tag);
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
            this.#statusMenu.refreshIfAlive();
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
            await this.#interactiveFlows.handleElicitationRequest(req, acp, scope, getRef, tag);
        });
    }  // end of #wireACPEvents

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
            this.#interactiveFlows.cancelQuestionQueue("Session ended");
        }

        if (tag === "primary") {
            // Clear watchdog timers — ACP is gone
            this.#clearPromptWatchdog();

            if (this.#promptActive) {
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                this.#scopeMgr?.clearActive();

                if (this.#intentionalKill) {
                    // Intentional kill (watchdog/force-cancel) — preserve queue for restart
                    this.#intentionalKill = false;
                    const preserved = this.#promptQueue.length;
                    if (preserved > 0) {
                        log.info(`Preserved ${preserved} queued message(s) after intentional ACP kill`);
                    }
                } else {
                    // Unexpected crash — drop queue (session state lost)
                    const dropped = this.#promptQueue.length;
                    this.#promptQueue = [];
                    if (dropped > 0) {
                        this.#broadcastAdmin(`⚠️ ${dropped} queued message(s) dropped due to Copilot crash.`);
                    }
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
        this.#statusMenu.refreshIfAlive().catch(() => {});
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
            promptElapsed: this.#promptActive && this.#promptStartedAt ? Math.round((Date.now() - this.#promptStartedAt) / 1000) : null,
            acpLastMessageAge: this.#acp?.lastMessageAt ? Math.round((Date.now() - this.#acp.lastMessageAt) / 1000) : null,
            acpLastMessageType: this.#acp?.lastMessageType || null,
            queueDepth: this.#promptQueue.length,
        };
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

        const targetUserId = extractCallbackTargetUserId(data);
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
            if (this.#statusMenu.statusMsg?.messageId === query.message.message_id) {
                this.#statusMenu.statusMsg = null;
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
            const { text, buttons } = this.#statusMenu.buildContent(scope);
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text,
                    reply_markup: buttons,
                });
                this.#statusMenu.statusMsg = {
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
        const isFromStatusMenu = this.#statusMenu.statusMsg?.messageId === query.message?.message_id;
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
                this.#statusMenu.refreshPaused = true;
                const pauseGuard = setTimeout(() => { this.#statusMenu.refreshPaused = false; }, 60000);
                try {
                    await handleSlashCommand(this.#buildCommandContext(ref), "session", data === "/session new" ? "new" : "stop");
                } finally {
                    clearTimeout(pauseGuard);
                    this.#statusMenu.refreshPaused = false;
                }
            } catch (err) {
                this.#statusMenu.refreshPaused = false;
                log.error(`Status menu action failed: ${err.message}`);
            }
            // Explicitly refresh to final state (don't rely on fire-and-forget hooks)
            await this.#statusMenu.refreshIfAlive();
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
            const prefix = this.#promptBuilder.getPrefix(ref);
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
            const editPrefix = this.#promptBuilder.getPrefix(editRef);
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

        const prefix = this.#promptBuilder.getPrefix(ref);
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
                const sanitizedPinnedText = sanitizePinnedInstruction(pinnedText);
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
        ref.username = message.from?.username || null;
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
        const prefix = this.#promptBuilder.getPrefix(ref);
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

        // Increment prompt generation (prevents stale force-cancel from killing subsequent prompts)
        this.#promptGeneration++;

        // Start prompt watchdog and heartbeat
        this.#startPromptWatchdog(scopeKey);

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
            // Clear watchdog and heartbeat timers
            this.#clearPromptWatchdog();

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
                // If ACP was killed (watchdog/force-cancel), restart before processing queue
                if (!this.#acp.alive) {
                    try {
                        log.info("Restarting ACP to process preserved queue...");
                        await this.startCopilot();
                    } catch (err) {
                        log.error(`ACP restart failed — dropping ${this.#promptQueue.length} queued message(s): ${err.message}`);
                        this.#broadcastAdmin(`⚠️ ACP restart failed. ${this.#promptQueue.length} queued message(s) dropped.`);
                        this.#promptQueue = [];
                        return;
                    }
                }
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

    // --- Copilot lifecycle (delegated to CopilotLifecycle module) ---

    async startCopilot() {
        await this.#lifecycle.start();
    }

    async stopCopilot() {
        await this.#lifecycle.stop();
    }

    async restartCopilot() {
        await this.#lifecycle.restart();
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
        this.#clearPromptWatchdog();
        const scope = this.#activeScope;
        if (scope) scope.activeTools.clear();
        if (scope?.messageFlushTimer) clearTimeout(scope.messageFlushTimer);
        if (this.#scopeMgr) this.#scopeMgr.shutdown();
    }
}
