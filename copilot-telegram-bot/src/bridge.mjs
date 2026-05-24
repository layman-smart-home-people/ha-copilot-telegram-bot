// ============================================================
// Bridge — Telegram ↔ Copilot ACP Orchestrator
// ============================================================
// Handles message routing, typing indicators, tool call bubbles,
// file attachments, and session lifecycle.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "./formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { ButtonManager } from "./buttons.mjs";
import { ResponseComposer } from "./response-composer.mjs";
import { ChatHistory } from "./history.mjs";
import { formatError } from "./errors.mjs";
import { MessageTransport, makeRef, refKey } from "./transport.mjs";
import { basename } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export class Bridge {
    #telegram;
    #acp;
    #config;
    #log;
    #allowedChatIds;

    // New v0.6 subsystems
    #transport;
    #pairing;
    #sessionMgr;

    // Active conversation ref — where ACP output is routed
    #activeRef = null;

    // Typing state
    #typingInterval = null;
    #typingDebounce = null;

    // Active tool tracking (for tool_end name lookups)
    #activeTools = new Map();

    // Message accumulator (collect chunks → send as complete message)
    // Use a longer flush timer as a safety net — primary flush happens on message_end
    #messageBuffer = "";
    #messageFlushTimer = null;
    #messageFlushMs = 2000;

    // Preamble
    #preambleSent = false;

    // Pinned instructions per chat (chatId → text)
    #pinnedInstructions = new Map();

    // Prompt lock (one prompt at a time)
    #promptActive = false;
    #promptQueue = [];

    // Ask-user state
    #awaitingInput = null;

    // Login lock — prevents multiple concurrent login flows
    #loginPromise = null;

    // startCopilot lock — prevents overlapping start attempts
    #startPromise = null;

    // Temp dir
    #tmpDir;

    // Button manager for inline keyboards
    #buttons;

    // Chat history ring buffer
    #history;

    // Session state
    #models = [];
    #modes = [];
    #currentModel = "";
    #currentMode = "";
    #sessionGrantedTools = new Set();
    #availableCommands = [];  // Copilot slash commands from ACP
    #knownTools = new Map();  // MCP tool names seen → description

    // Allow-all mode toggle (runtime, toggled via /allowall command)
    #allowAll = false;

    // Active status menu (singleton — only one at a time)
    #statusMsg = null; // { chatId, messageId, createdAt }
    #statusRefreshPaused = false; // true during intentional restart (skip exit event refresh)

    // Turn-level tracking for tool call reactions
    #turnToolCount = 0;
    #turnToolErrors = 0;
    #lastBotMessageId = null;  // Message ID of last bot message sent during this turn

    // Response composer — unified progressive message
    #composer = null;

    constructor({ telegram, acp, config, log, pairing, sessionMgr }) {
        this.#telegram = telegram;
        this.#acp = acp;
        this.#config = config;
        this.#log = log;
        this.#allowedChatIds = (config.allowedChatIds || []).map(Number);
        this.#tmpDir = join("/tmp", `copilot-tg-${process.pid}`);
        this.#buttons = new ButtonManager(telegram);
        this.#history = new ChatHistory(50);
        this.#transport = new MessageTransport(telegram);
        this.#pairing = pairing || null;
        this.#sessionMgr = sessionMgr || null;
    }

    get allowedChatIds() { return this.#allowedChatIds; }
    get promptActive() { return this.#promptActive; }
    get allowAll() { return this.#allowAll; }
    set allowAll(v) { this.#allowAll = !!v; this.#log(`Allow-all mode: ${this.#allowAll}`); }
    resetPreamble() { this.#preambleSent = false; }

    /** Best-effort notification before process exit. */
    async notifyShutdown() {
        const promises = [];

        // If a response was in progress, notify the user
        if (this.#composer?.active && this.#activeRef) {
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
    }

    /** Re-submit a message as if the user sent it (for /retry) */
    submitRetry(ref, text) {
        this.#queuePrompt(this.#getPrefix(ref) + text, {}, ref);
    }

    // --- Status menu (singleton with auto-refresh) ---

    static #STATUS_TTL_MS = 5 * 60 * 1000; // 5 min expiry

    /** Send or refresh the status menu. Dismisses any previous one. */
    async showStatusMenu(chatId) {
        // Dismiss old status message if exists
        await this.#dismissOldStatus(chatId);

        const { text, buttons } = this.#buildStatusContent();
        const sent = await this.#telegram.sendMessage(chatId, text, undefined, buttons);
        if (sent?.message_id) {
            this.#statusMsg = { chatId, messageId: sent.message_id, createdAt: Date.now() };
        }
    }

    /** Edit the existing status menu if it's still fresh. Called on state changes. */
    async #refreshStatusIfAlive() {
        if (!this.#statusMsg) {
            this.#log("Status refresh: no active status message");
            return;
        }
        if (this.#statusRefreshPaused) {
            this.#log("Status refresh: paused (restart in progress)");
            return;
        }
        if (Date.now() - this.#statusMsg.createdAt > CopilotBridge.#STATUS_TTL_MS) {
            this.#log("Status refresh: expired");
            this.#statusMsg = null;
            return;
        }
        const { text, buttons } = this.#buildStatusContent();
        const firstLine = text.split("\n")[0];
        this.#log(`Status refresh: updating to "${firstLine}" (msgId=${this.#statusMsg.messageId})`);
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: this.#statusMsg.chatId,
                message_id: this.#statusMsg.messageId,
                text,
                reply_markup: buttons,
            });
            this.#log("Status refresh: edit succeeded");
        } catch (err) {
            if (/message is not modified/i.test(err?.message)) {
                this.#log("Status refresh: no change needed");
                return;
            }
            this.#log(`Status refresh: edit failed — ${err.message}`);
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

    #buildStatusContent() {
        const alive = this.#acp?.alive;
        const hasSession = !!this.#acp?.sessionId;
        const ready = alive && hasSession;

        const lines = [];
        lines.push(ready ? "✅ Copilot Ready" : alive ? "⏳ Copilot Starting..." : "⏹️ Copilot Stopped");
        if (this.#config?.version) lines.push(`📦 Version: ${this.#config.version}`);
        lines.push("");

        if (ready) {
            const modelName = this.#models?.find(m => m.modelId === this.#currentModel)?.name || this.#currentModel || "unknown";
            const modeName = this.#modes?.find(m => m.id === this.#currentMode)?.name || this.#currentMode || "unknown";
            lines.push(`🤖 Model: ${modelName}`);
            lines.push(`📋 Mode: ${modeName}`);
            lines.push(`🔗 Session: ${this.#acp.sessionId.slice(0, 8)}…`);
            lines.push(`📊 Models available: ${this.#models?.length || 0}`);
        }

        if (this.#allowAll) {
            lines.push(`🔓 Permissions: allow-all`);
        } else {
            lines.push(`🔐 Permissions: interactive`);
        }
        lines.push(`📱 Telegram: connected`);
        lines.push(`👥 Chats: ${this.#allowedChatIds.length}`);
        if (this.#pairing) {
            lines.push(`🔐 Paired users: ${this.#pairing.getPairedUsers().length}`);
        }
        if (this.#sessionMgr?.forumChatId) {
            lines.push(`🗂️ Active sessions: ${this.#sessionMgr.listActiveSessions().length}`);
        }
        if (this.#history) lines.push(`📜 History: ${this.#history.length} messages`);

        const statusButtons = {
            inline_keyboard: ready ? [
                [
                    { text: "🤖 Model", callback_data: "/model" },
                    { text: "📋 Mode", callback_data: "/mode" },
                ],
                [
                    { text: "📊 Usage", callback_data: "/usage" },
                    { text: "🗜️ Compact", callback_data: "/compact" },
                ],
                [
                    { text: this.#allowAll ? "\u{1F512} Allow-all OFF" : "\u{1F513} Allow-all ON",
                      callback_data: this.#allowAll ? "/allowall off" : "/allowall on" },
                ],
                [
                    { text: "🔄 Restart", callback_data: "/session new" },
                    { text: "⏹️ Stop", callback_data: "/session stop" },
                ],
                [{ text: "✕ Dismiss", callback_data: "dismiss" }],
            ] : alive ? [
                [{ text: "🔄 Refresh", callback_data: "/status" }],
                [{ text: "✕ Dismiss", callback_data: "dismiss" }],
            ] : [
                [{ text: "🚀 Start Copilot", callback_data: "/session new" }],
                [{ text: "✕ Dismiss", callback_data: "dismiss" }],
            ],
        };

        return { text: lines.join("\n"), buttons: statusButtons };
    }

    // --- Setup event handlers ---

    setupACPHandlers() {
        const acp = this.#acp;

        // Text chunks → feed to composer for progressive display
        acp.on("text_chunk", (text) => {
            this.#resetTypingDebounce();
            this.#messageBuffer += text;
            if (this.#composer?.active) {
                this.#composer.appendText(text);
                // Don't flush buffer separately — composer handles display
            } else {
                // Legacy path: no composer, flush as separate messages
                if (this.#messageFlushTimer) clearTimeout(this.#messageFlushTimer);
                this.#messageFlushTimer = setTimeout(() => this.#flushMessageBuffer(), this.#messageFlushMs);
            }
        });

        // Message boundaries
        acp.on("message_start", () => {
            this.#log("Agent message_start");
            this.#messageBuffer = "";
        });

        acp.on("message_end", () => {
            this.#log("Agent message_end");
            this.#finalizeComposer();
            this.#stopTyping();
        });

        // Tool calls → composer progress updates
        acp.on("tool_start", ({ toolCallId, toolName, arguments: args }) => {
            this.#log(`Tool start: ${toolName} (${toolCallId})`);
            this.#turnToolCount++;
            this.#resetTypingDebounce();
            const desc = describeToolCall(toolName, args);
            if (desc) {
                this.#activeTools.set(toolCallId, { name: toolName, description: desc });
                // Update composer with tool step
                if (this.#composer?.active) {
                    this.#composer.addToolStep(toolCallId, desc, "running");
                }
            }
            // Track tool for /skills discovery
            if (toolName && !this.#knownTools.has(toolName)) {
                this.#knownTools.set(toolName, desc || toolName);
            }
        });

        acp.on("tool_end", ({ toolCallId, status, result }) => {
            const completed = this.#activeTools.get(toolCallId);
            const resultSummary = result ? JSON.stringify(result).substring(0, 200) : "null";
            this.#log(`Tool end: ${completed?.name || toolCallId} [${status}] → ${resultSummary}`);
            // Detect tool errors from status or MCP result
            if (status === "failed") {
                this.#turnToolErrors++;
                this.#log(`Tool failed: ${completed?.name || toolCallId}`);
            } else {
                const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
                if (result?.isError || result?.error || /\"isError\"\s*:\s*true/i.test(resultStr)) {
                    this.#turnToolErrors++;
                    this.#log(`Tool error detected: ${completed?.name || toolCallId}`);
                }
            }
            this.#resetTypingDebounce();
            this.#activeTools.delete(toolCallId);
            // Update composer with tool completion
            if (this.#composer?.active && completed?.description) {
                this.#composer.addToolStep(toolCallId, completed.description, status === "failed" ? "failed" : "completed");
            }

            // Interactive mode: show notification + undo for HA write tools
            if (!this.#allowAll && status === "completed" && completed?.name) {
                this.#showToolNotification(completed.name, result);
            }

            // Relay images from tool results
            this.#relayToolImages(result);
        });

        // Tool progress updates (in_progress status)
        acp.on("tool_update", ({ toolCallId, status }) => {
            if (status === "in_progress") {
                this.#resetTypingDebounce();
            }
        });

        // Process exit — handle crash recovery
        acp.on("exit", ({ code, signal }) => {
            this.#stopTyping();
            if (this.#composer?.active) {
                this.#composer.abort("Copilot process exited unexpectedly").catch(() => {});
                this.#composer = null;
            }
            this.#activeTools.clear();
            this.#flushMessageBuffer();

            // Crash recovery: reject any active prompt so the queue doesn't wedge
            if (this.#promptActive) {
                this.#promptActive = false;
                this.#activeRef = null;
                // Drain the queue — notify users that queued messages were lost
                const dropped = this.#promptQueue.length;
                this.#promptQueue = [];
                if (dropped > 0) {
                    this.#broadcastAdmin(`⚠️ ${dropped} queued message(s) dropped due to Copilot exit.`);
                }
            }

            // Don't broadcast exit if it was intentional (code 0 or null = SIGTERM)
            if (code !== 0 && code !== null) {
                this.#broadcastAdmin(`⚠️ Copilot process exited (code: ${code}). Send a message to restart.`);
            }
            this.#refreshStatusIfAlive().catch(() => {});
        });

        acp.on("error", (err) => {
            this.#log(`ACP error: ${err.message}`);
        });

        acp.on("log", (text) => {
            this.#log(`ACP: ${text}`);
        });

        acp.on("permission_request", async (req) => {
            this.#log(`Permission request: ${JSON.stringify(req)}`);
            const { requestId } = req;

            // Extract tool identification from the new session/request_permission format
            const toolCall = req.toolCall || {};
            const rawInput = toolCall.rawInput || {};
            // Build a meaningful tool name from the request
            const toolTitle = toolCall.title || "";
            const domain = rawInput.domain || "";
            const service = rawInput.service || "";
            const entityId = rawInput.entity_id || "";
            // Derive a tool-like name for policy matching
            const tool = domain && service ? `ha_${domain}_${service}` :
                         toolTitle.toLowerCase().includes("call service") ? "ha_call_service" :
                         req.toolName || req.tool || req.name || "unknown_tool";
            const desc = entityId ? `${domain}.${service} → ${entityId}` :
                         toolTitle || "";

            // Allow-all mode: skip all permission prompts
            if (this.#allowAll) {
                const options = req.options || [];
                const allowId = options.find(o => o.kind === "allow_always")?.optionId || "allow_always";
                acp.respondPermission(requestId, allowId);
                this.#log(`Permission auto-approved (allow-all mode): ${tool} (${desc})`);
                return;
            }

            // Policy: auto-approve read-only HA tools + standard copilot tools
            const readOnlyTools = new Set([
                "ha_search_entities", "ha_get_state", "ha_get_history",
                "ha_deep_search", "ha_get_overview", "ha_get_entity_state",
                "ha_search_automations", "ha_get_automation",
            ]);
            const isReadOnly = readOnlyTools.has(tool) || !tool.startsWith("ha_");

            // Extract the actual optionIds from the request's options array
            const options = req.options || [];
            const findOption = (kind) => options.find(o => o.kind === kind)?.optionId;
            const allowOnceId = findOption("allow_once") || "allow_once";
            const allowAlwaysId = findOption("allow_always") || "allow_always";
            const rejectOnceId = findOption("reject_once") || "reject_once";

            // Session grants: user previously allowed this tool for the session
            if (isReadOnly || this.#sessionGrantedTools.has(tool)) {
                acp.respondPermission(requestId, allowAlwaysId);
                this.#log(`Permission auto-approved: ${tool} (${desc})`);
                return;
            }

            // Ask user via inline buttons
            const targetRef = this.#activeRef;
            const chatId = targetRef?.chatId || this.#allowedChatIds?.[0];
            if (!chatId || !this.#buttons) {
                // No chat to ask — deny by default
                acp.respondPermission(requestId, rejectOnceId);
                this.#log(`Permission denied (no chat): ${tool}`);
                return;
            }

            const label = desc ? `${tool}\n${desc}` : tool;
            const rows = [
                [
                    { text: "✅ Allow once", value: allowOnceId },
                    { text: "✅ Always allow", value: allowAlwaysId },
                    { text: "❌ Deny", value: rejectOnceId },
                ],
            ];
            if (this.#composer) this.#composer.setPermissionPending(true);
            let selected, permMsgId;
            try {
                ({ value: selected, messageId: permMsgId } = await this.#buttons.prompt(
                    chatId,
                    `🔐 Permission request:\n${label}`,
                    rows,
                    { timeoutMs: 60000, timeoutText: "🔐 Permission denied (timeout)" }
                ));
            } finally {
                if (this.#composer) this.#composer.setPermissionPending(false);
            }

            if (selected === allowOnceId || selected === allowAlwaysId) {
                if (selected === allowAlwaysId) {
                    this.#sessionGrantedTools.add(tool);
                }
                acp.respondPermission(requestId, selected);
                this.#log(`Permission granted (${selected}): ${tool}`);
                if (permMsgId) {
                    try {
                        await this.#buttons.finalize(chatId, permMsgId, `✅ Allowed: ${desc || tool}`);
                    } catch (err) {
                        this.#log(`Error finalizing allow message: ${err.message}`);
                    }
                }
            } else {
                acp.respondPermission(requestId, rejectOnceId);
                this.#log(`Permission denied: ${tool} (permMsgId=${permMsgId})`);
                try {
                    if (permMsgId) {
                        this.#log(`Finalizing deny message: chat=${chatId} msg=${permMsgId}`);
                        await this.#buttons.finalize(chatId, permMsgId, `❌ Denied: ${desc || tool}`);
                    } else {
                        this.#log(`No permMsgId for deny feedback`);
                    }
                } catch (err) {
                    this.#log(`Error finalizing deny message: ${err.message}`);
                }
            }
        });

        // Capture session data (models, modes) from session events
        acp.on("session", (result) => {
            if (result.models?.availableModels) {
                this.#models = result.models.availableModels;
                this.#log(`Models available: ${this.#models.length}`);
            }
            if (result.models?.currentModelId) {
                this.#currentModel = result.models.currentModelId;
            }
            if (result.modes?.availableModes) {
                this.#modes = result.modes.availableModes;
            }
            if (result.modes?.currentModeId) {
                this.#currentMode = result.modes.currentModeId;
            }
        });

        // config_option_update can update models/modes mid-session
        acp.on("config_options", (options) => {
            const modelOpt = options?.find(o => o.id === "model");
            if (modelOpt?.options) {
                this.#models = modelOpt.options.map(o => ({
                    modelId: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modelOpt?.currentValue) {
                this.#currentModel = modelOpt.currentValue;
            }
            const modeOpt = options?.find(o => o.id === "mode");
            if (modeOpt?.options) {
                this.#modes = modeOpt.options.map(o => ({
                    id: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modeOpt?.currentValue) {
                this.#currentMode = modeOpt.currentValue;
            }
        });

        // Capture available commands (copilot slash commands)
        acp.on("commands", (commands) => {
            if (Array.isArray(commands)) {
                this.#availableCommands = commands;
                this.#log(`Copilot commands available: ${commands.length}`);
            }
        });
    }

    setupTelegramHandlers() {
        this.#telegram.on("update", (update) => this.#processUpdate(update));

        this.#telegram.on("conflict", () => {
            this.#log("Telegram 409 conflict — another process is polling this bot");
        });

        this.#telegram.on("poll_error", (err) => {
            this.#log(`Telegram poll error: ${err.message}`);
        });
    }

    // --- Build command context ---

    #buildCommandContext(ref) {
        return {
            acp: this.#acp,
            telegram: this.#telegram,
            transport: this.#transport,
            chatId: ref.chatId,
            chatIds: this.#allowedChatIds,
            ref,
            log: this.#log,
            startCopilot: () => this.startCopilot(),
            stopCopilot: () => this.stopCopilot(),
            restartCopilot: () => this.restartCopilot(),
            buttons: this.#buttons,
            models: this.#models,
            modes: this.#modes,
            history: this.#history,
            currentModel: this.#currentModel,
            currentMode: this.#currentMode,
            availableCommands: this.#availableCommands,
            knownTools: this.#knownTools,
            pairing: this.#pairing,
            sessionMgr: this.#sessionMgr,
            bridge: this,
            config: this.#config,
        };
    }

    // --- Inbound message processing ---

    async #handleCallbackQuery(query) {
        const chatId = query.message?.chat?.id;
        const userId = query.from?.id;
        if (!chatId) return;

        // Auth check for callbacks
        const isAuthorized = this.#pairing
            ? this.#pairing.isPaired(userId)
            : this.#allowedChatIds.includes(userId);
        if (!isAuthorized) return;

        // Try ButtonManager first (handles btn: prefix callbacks)
        if (await this.#buttons.handleCallback(query)) return;

        // Legacy callback handling — acknowledge the button press
        try {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id });
        } catch {}

        const data = query.data;
        if (!data) return;

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

        // Handle /status refresh — edit in place instead of sending new
        if (data === "/status") {
            await this.showStatusMenu(chatId);
            return;
        }

        // If a state-changing command is triggered from the active status menu,
        // immediately show transitional state, execute command, then refresh
        const isFromStatusMenu = this.#statusMsg?.messageId === query.message?.message_id;
        if (isFromStatusMenu && (data === "/session new" || data === "/session stop")) {
            const label = data === "/session new" ? "⏳ Restarting Copilot..." : "⏳ Stopping Copilot...";
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text: label,
                    reply_markup: { inline_keyboard: [[{ text: "✕ Dismiss", callback_data: "dismiss" }]] },
                });
            } catch {}
            // Execute the command (suppress the broadcast — status menu shows state)
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId);
            try {
                if (data === "/session new") {
                    this.#statusRefreshPaused = true; // prevent exit event from showing "Stopped"
                    await this.restartCopilot();
                    this.#statusRefreshPaused = false;
                } else {
                    await this.stopCopilot();
                }
            } catch (err) {
                this.#statusRefreshPaused = false;
                this.#log(`Status menu action failed: ${err.message}`);
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

        // Route callback data as slash commands
        const parts = data.split(" ");
        const command = parts[0].replace("/", "");
        const args = parts.slice(1).join(" ");

        await handleSlashCommand(this.#buildCommandContext(ref), command, args);
    }

    async #processUpdate(update) {
        // Handle callback queries (inline keyboard buttons)
        if (update.callback_query) {
            await this.#handleCallbackQuery(update.callback_query);
            return;
        }

        const message = update.message;
        if (!message) return;

        // Handle pinned messages as agent instructions
        if (message.pinned_message) {
            const pinned = message.pinned_message;
            const pinnedText = pinned.text || pinned.caption || "";
            const chatId = message.chat.id;
            if (pinnedText.trim()) {
                this.#pinnedInstructions.set(chatId, pinnedText.trim());
                this.#preambleSent = false; // force preamble refresh
                this.#log(`Pinned instruction set for chat=${chatId}: ${pinnedText.substring(0, 100)}`);
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, "📌 Noted! This pinned message will be included as context for all future messages in this chat.")
                );
            }
            return;
        }

        const chatId = message.chat.id;
        const userId = message.from?.id;
        const username = message.from?.username || message.from?.first_name || null;
        if (userId == null) return;

        const threadId = message.message_thread_id || null;
        const isForum = message.chat.is_forum === true;
        const text = message.text || message.caption || "";

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
                    } else {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "❌ Invalid or expired code. Check HA logs for a fresh code.")
                        );
                    }
                    return;
                }

                // Not paired — start pairing flow
                // In groups/supergroups: tell them to DM
                if (message.chat.type !== "private") {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(chatId, "👋 DM me to get started!", undefined, undefined)
                    );
                    return;
                }

                // In DM: generate pairing code
                const code = this.#pairing.generateCode(userId, username);
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(
                        chatId,
                        `🔐 Pairing required\n\n` +
                        `A pairing code has been generated.\n` +
                        `Check your Home Assistant add-on logs and enter the code here.\n\n` +
                        `⏳ Code expires in 15 minutes.`
                    )
                );
                return;
            }
        } else {
            // Legacy mode: check allowed_chat_ids
            if (!this.#allowedChatIds.includes(userId)) {
                this.#log(`Ignoring message from unauthorized user: ${userId}`);
                return;
            }
        }

        // Build ConversationRef
        const ref = makeRef(chatId, threadId);

        // --- Forum routing ---
        if (isForum && this.#sessionMgr) {
            // Auto-detect forum chat on first message
            if (!this.#sessionMgr.isForumChat(chatId)) {
                this.#sessionMgr.setForumChat(chatId);
                this.#log(`Forum chat detected: ${chatId}`);
            }

            // Management topic: commands only, no ACP routing
            if (this.#sessionMgr.isManagementTopic(ref)) {
                this.#history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });
                this.#telegram.enqueue(() =>
                    this.#telegram.setMessageReaction(chatId, message.message_id, "⏳").catch(() => {})
                );

                if (message.text?.startsWith("/")) {
                    const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
                    if (parsed) {
                        await handleSlashCommand(this.#buildCommandContext(ref), parsed.command, parsed.args);
                        this.#telegram.setMessageReaction(chatId, message.message_id, null).catch(() => {});
                        return;
                    }
                }

                // Non-command in management topic
                this.#telegram.enqueue(() =>
                    this.#transport.send(ref, "💡 This is the management topic. Use commands like /new, /status, /sessions, /help.")
                );
                this.#telegram.setMessageReaction(chatId, message.message_id, null).catch(() => {});
                return;
            }

            // Session topic: look up or create session
            const session = this.#sessionMgr.getSession(ref);
            if (session) {
                ref.sessionId = session.sessionId;
            }
            // If no session exists for this topic, it will be created when prompt is queued
        }

        // Track incoming user message in history
        this.#history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });
        if (this.#awaitingInput) {
            const { resolve } = this.#awaitingInput;
            clearTimeout(this.#awaitingInput.timer);
            this.#awaitingInput = null;
            resolve(text);
            return;
        }

        // Ack reaction — ⏳ means queued/waiting
        this.#telegram.enqueue(() =>
            this.#telegram.setMessageReaction(chatId, message.message_id, "⏳").catch(() => {})
        );

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
                if (this.#composer) {
                    await this.#composer.abort(formatError(err));
                    this.#composer = null;
                }
                this.#activeTools.clear();
                this.#promptActive = false;
                this.#activeRef = null;
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
                    await this.#queuePrompt(promptText || prefix + "User sent a file.", {
                        images: attachment.isImage ? [{
                            data: attachment.buffer.toString("base64"),
                            mimeType: attachment.mimeType || "image/png",
                        }] : undefined,
                    }, ref, message.message_id);
                    return;
                }
            } catch (err) {
                this.#transport.enqueueSend(ref, formatError(err));
                return;
            }
        }

        if (promptText.trim()) {
            await this.#queuePrompt(promptText, {}, ref, message.message_id);
            return;
        }

        this.#transport.enqueueSend(ref, "Unsupported message type.");
    }

    // --- Prompt queue (one at a time) ---

    async #queuePrompt(text, opts = {}, ref = null, messageId = null) {
        if (this.#promptActive) {
            this.#promptQueue.push({ text, opts, ref, messageId });
            return;
        }
        this.#promptActive = true;

        // Reset turn-level tracking
        this.#turnToolCount = 0;
        this.#turnToolErrors = 0;
        this.#lastBotMessageId = null;

        // Set active ref for ACP output routing
        this.#activeRef = ref;

        // Create composer for progressive message display
        if (ref) {
            this.#log(`Creating ResponseComposer for chat=${ref.chatId}`);
            this.#composer = new ResponseComposer(this.#telegram, this.#log);
            try {
                await this.#composer.start(ref);
                this.#log(`Composer started, messageId=${this.#composer.messageId}`);
            } catch (err) {
                this.#log(`Composer start failed: ${err.message}`);
            }
        }

        // Update reaction: ⏳ → 👀 (now being processed)
        if (ref && messageId) {
            this.#telegram.setMessageReaction(ref.chatId, messageId, "👀").catch(() => {});
        }

        try {
            // Session switching for forum topics
            if (ref && this.#sessionMgr && this.#acp.alive) {
                const session = this.#sessionMgr.getSession(ref);
                if (session && session.sessionId) {
                    // Check if we need to switch sessions
                    if (this.#sessionMgr.needsSwitch(ref)) {
                        try {
                            this.#log(`Switching session to ${session.sessionId} for ${refKey(ref)}`);
                            await this.#acp.loadSession(session.sessionId);
                            this.#sessionMgr.setActive(ref);
                        } catch (err) {
                            this.#log(`Session load failed for ${session.sessionId}: ${err.message}`);
                            const msg = `⚠️ Could not load session. Use /new to start a fresh session.\nError: ${err.message}`;
                            if (this.#composer?.active) {
                                await this.#composer.abort(msg);
                                this.#composer = null;
                            } else {
                                this.#transport.enqueueSend(ref, msg);
                            }
                            this.#promptActive = false;
                            this.#activeRef = null;
                            return;
                        }
                    }
                } else if (ref.threadId && this.#sessionMgr.isForumChat(ref.chatId)) {
                    // No session for this topic — create one
                    try {
                        this.#log(`Auto-creating session for topic ${ref.threadId}`);
                        const result = await this.#acp.newSession({
                            cwd: this.#config.workingDirectory || "/config",
                        });
                        ref.sessionId = result.sessionId;
                        this.#sessionMgr.register(ref, result.sessionId, `Topic ${ref.threadId}`, false);
                        this.#preambleSent = false;
                    } catch (err) {
                        this.#log(`Auto-create session failed: ${err.message}`);
                        const msg = `⚠️ Failed to create session: ${err.message}`;
                        if (this.#composer?.active) {
                            await this.#composer.abort(msg);
                            this.#composer = null;
                        } else {
                            this.#transport.enqueueSend(ref, msg);
                        }
                        this.#promptActive = false;
                        this.#activeRef = null;
                        return;
                    }
                }
            }

            const result = await this.#acp.prompt(text, opts);
            this.#log(`Prompt completed successfully: ${JSON.stringify(result)?.substring(0, 200)}`);
        } catch (err) {
            this.#log(`Prompt error: ${err.message}`);
            this.#turnToolErrors++;
            const userMsg = formatError(err);
            if (this.#composer?.active) {
                // Show error in the composer message
                await this.#composer.abort(userMsg);
                this.#composer = null;
            } else if (ref) {
                this.#transport.enqueueSend(ref, userMsg);
            } else {
                for (const cid of this.#allowedChatIds) {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(cid, userMsg)
                    );
                }
            }
        } finally {
            // Clear reaction on user's message — response delivered
            if (ref && messageId) {
                const emoji = this.#turnToolErrors > 0 ? "❌" : null;
                this.#telegram.setMessageReaction(ref.chatId, messageId, emoji).catch(() => {});
            }

            // Finalize composer if still active (safety net)
            await this.#finalizeComposer();
            this.#stopTyping();
            this.#activeTools.clear();

            // React on bot's last response if tools were called
            if (ref && this.#lastBotMessageId && this.#turnToolCount > 0) {
                const emoji = this.#turnToolErrors > 0 ? "👎" : "👍";
                this.#telegram.setMessageReaction(ref.chatId, this.#lastBotMessageId, emoji).catch(() => {});
            }

            this.#promptActive = false;
            this.#activeRef = null;

            // Process queued prompts
            if (this.#promptQueue.length > 0) {
                const next = this.#promptQueue.shift();
                this.#queuePrompt(next.text, next.opts, next.ref, next.messageId);
            }
        }
    }

    // --- Preamble ---

    #getPrefix(ref) {
        let prefix;
        if (!this.#preambleSent) {
            this.#preambleSent = true;
            const rules = this.#config.preamble;
            prefix = `[SYSTEM: ${rules}]\n`;
        } else {
            prefix = "[Via Telegram]\n";
        }

        // Append pinned instructions if any
        const chatId = ref?.chatId || this.#activeRef?.chatId;
        if (chatId && this.#pinnedInstructions.has(chatId)) {
            prefix += `[📌 Pinned instructions: ${this.#pinnedInstructions.get(chatId)}]\n`;
        }

        return prefix;
    }

    // --- Copilot lifecycle ---

    async startCopilot() {
        if (this.#acp.alive) return;

        // If already starting, wait for that attempt
        if (this.#startPromise) {
            this.#log("Start already in progress, waiting...");
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
        this.#log("Starting ACP process...");
        try {
            await this.#acp.start();
        } catch (err) {
            throw new Error(`Failed to start copilot binary: ${err.message}. Check copilot_binary path in config.`);
        }

        // Authenticate — required by ACP protocol before session/new
        try {
            await this.#acp.authenticate();
            this.#log("ACP authentication successful");
        } catch (err) {
            const isAuthRequired = err.message?.includes("Authentication required") || err.message?.includes("-32000");
            if (!isAuthRequired) {
                this.#log(`Authentication failed (unexpected): ${err.message}`);
                await this.#acp.stop();
                throw err;
            }

            if (process.env.COPILOT_GITHUB_TOKEN) {
                this.#log("Configured token rejected — clearing and retrying with stored tokens");
                delete process.env.COPILOT_GITHUB_TOKEN;
                await this.#acp.stop();
                await this.#acp.start();
                try {
                    await this.#acp.authenticate();
                    this.#log("ACP authentication successful with stored tokens");
                } catch (retryErr) {
                    if (retryErr.message?.includes("Authentication required") || retryErr.message?.includes("-32000")) {
                        this.#log("No stored tokens either — starting device login");
                        await this.#acp.stop();
                        await this.#runDeviceLogin();
                        await this.#acp.start();
                        await this.#acp.authenticate();
                        this.#log("ACP authentication successful after login");
                    } else {
                        this.#log(`Authentication retry failed: ${retryErr.message}`);
                        await this.#acp.stop();
                        throw retryErr;
                    }
                }
            } else {
                this.#log("No valid token found — starting device login flow");
                await this.#acp.stop();
                await this.#runDeviceLogin();
                await this.#acp.start();
                await this.#acp.authenticate();
                this.#log("ACP authentication successful after login");
            }
        }

        // Create session (small delay to let auth propagate in the ACP process)
        await new Promise(r => setTimeout(r, 500));
        this.#log("Creating new ACP session...");
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

        this.#preambleSent = false;
        this.#log(`Copilot started, session: ${this.#acp.sessionId}`);
        this.#refreshStatusIfAlive().catch(() => {});
    }

    async #runDeviceLogin() {
        // If PAT token is configured, no login needed
        if (process.env.COPILOT_GITHUB_TOKEN) {
            this.#log("GitHub token configured — skipping device login");
            return;
        }

        // If login is already in progress, wait for that one
        if (this.#loginPromise) {
            this.#log("Login already in progress, waiting...");
            return this.#loginPromise;
        }

        this.#log("Authentication required — starting device login flow...");
        const binary = this.#config.copilotBinary || "/share/copilot-tools/copilot";

        this.#loginPromise = new Promise((resolve, reject) => {
            // Use 'yes' pipe to auto-accept all prompts (e.g. plaintext storage)
            this.#log(`[login] Spawning: yes | ${binary} login`);
            const proc = spawn("sh", ["-c", `yes | "${binary}" login`], {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
            });

            let stdout = "";
            let stderr = "";
            let codeSent = false;
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.#log("[login] Timed out after 10 minutes");
                    proc.kill();
                    this.#broadcastAdmin("⏰ Login timed out. Send any message to get a fresh code.");
                    reject(new Error("Login timed out"));
                }
            }, 10 * 60 * 1000);

            proc.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                stdout += text;
                this.#log(`[login] stdout: ${text.trim()}`);
                if (!codeSent) {
                    const match = stdout.match(/enter code ([A-Z0-9]{4}-[A-Z0-9]{4})/);
                    if (match) {
                        codeSent = true;
                        const code = match[1];
                        this.#log(`[login] Device code: ${code}`);
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
                    this.#log(`[login] stderr: ${text}`);
                }
            });

            proc.on("close", (exitCode) => {
                clearTimeout(timeout);
                this.#loginPromise = null;
                if (resolved) return;
                resolved = true;
                this.#log(`[login] Process exited with code ${exitCode}`);
                if (stderr) this.#log(`[login] stderr: ${stderr.trim()}`);

                // Always resolve — the caller will verify auth via acp.authenticate()
                // Login may exit non-zero due to browser/clipboard warnings in containers
                this.#broadcastAdmin("✅ Login flow completed — verifying token...");
                resolve();
            });

            proc.on("error", (err) => {
                clearTimeout(timeout);
                this.#loginPromise = null;
                if (!resolved) {
                    resolved = true;
                    this.#log(`[login] Spawn error: ${err.message}`);
                    reject(err);
                }
            });
        });

        return this.#loginPromise;
    }

    async stopCopilot() {
        await this.#acp.stop();
        this.#preambleSent = false;
    }

    async restartCopilot() {
        await this.stopCopilot();
        await this.startCopilot();
    }

    // --- Reply-to context extraction ---

    #extractReplyContext(message) {
        const reply = message.reply_to_message;
        this.#log(`Reply chain: reply_to_message=${reply ? `msgId=${reply.message_id} from=${reply.from?.username || reply.from?.id} text="${(reply.text || "").substring(0, 50)}"` : "none"}`);
        if (!reply) return "";

        // First, get the immediate reply from Telegram (always available)
        const replyMsgId = reply.message_id;

        // Try to walk the chain using our history (which tracks replyToMessageId)
        const historyChain = this.#history.getReplyChain(replyMsgId, 5, 2000);

        if (historyChain.length > 0) {
            this.#log(`Reply chain from history: ${historyChain.length} messages`);

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
        this.#log(`Reply chain fallback (Telegram only): 1 message`);
        return `[${source}: "${text}"]`;
    }

    // --- File handling ---

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
        return { buffer, displayName, isImage, mimeType: message.document?.mime_type };
    }

    // --- Response Composer lifecycle ---

    async #finalizeComposer() {
        if (!this.#composer) {
            // No composer — fall back to legacy buffer flush
            this.#flushMessageBuffer();
            return;
        }

        const composer = this.#composer;
        this.#composer = null;

        if (this.#messageFlushTimer) {
            clearTimeout(this.#messageFlushTimer);
            this.#messageFlushTimer = null;
        }

        const fullText = this.#messageBuffer.trim();
        this.#messageBuffer = "";

        if (!fullText && !composer.active) {
            // Nothing to show
            await composer.cleanup();
            return;
        }

        // We'll track the bot response in history after we know the message ID
        let botHistoryEntry = null;
        if (fullText) {
            botHistoryEntry = { role: "bot", text: fullText, messageId: null };
            this.#history.push(botHistoryEntry);
        }

        try {
            // Finalize the composer — edits placeholder into final answer
            const overflow = await composer.finalize(fullText);

            // Track the composer's message as last bot message for reactions
            if (composer.messageId) {
                this.#lastBotMessageId = composer.messageId;
            }

            if (overflow?.length > 0) {
                // Answer goes as separate messages
                const ref = this.#activeRef;
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
                                this.#lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    // First chunk — update the main history entry
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0) {
                                    // Subsequent chunks — add alias entries for reply chain lookups
                                    this.#history.push({
                                        role: "bot", text: `(continued)`, messageId: sent.message_id,
                                        replyToMessageId: botHistoryEntry?.messageId,
                                    });
                                }
                            }
                        });
                    }
                }
            } else if (botHistoryEntry && composer.messageId) {
                // No overflow — answer was edited into the composer message
                botHistoryEntry.messageId = composer.messageId;
            }
        } catch (err) {
            this.#log(`Composer finalize error: ${err.message}`);
            // Fallback: send as regular message (skip #sendFormatted to avoid double history push)
            if (fullText) {
                const ref = this.#activeRef;
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
                                this.#lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0) {
                                    this.#history.push({
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

    #flushMessageBuffer() {
        if (this.#messageFlushTimer) {
            clearTimeout(this.#messageFlushTimer);
            this.#messageFlushTimer = null;
        }
        if (!this.#messageBuffer.trim()) return;

        const content = this.#messageBuffer;
        this.#messageBuffer = "";

        // Track bot response in history
        this.#history.push({ role: "bot", text: content });

        const chunks = chunkMessage(content);
        const ref = this.#activeRef;

        if (ref) {
            // Route to the active conversation ref
            for (const chunk of chunks) {
                this.#telegram.enqueue(() => this.#sendFormatted(ref, chunk));
            }
        } else {
            // Fallback: broadcast to all allowed chat IDs
            for (const chatId of this.#allowedChatIds) {
                const fallbackRef = makeRef(chatId);
                for (const chunk of chunks) {
                    this.#telegram.enqueue(() => this.#sendFormatted(fallbackRef, chunk));
                }
            }
        }
    }

    async #sendFormatted(ref, markdown) {
        const html = markdownToTelegramHtml(markdown);
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
            this.#lastBotMessageId = sent.message_id;
            // Track bot message in history with messageId for reply chain lookups
            this.#history.push({ role: "bot", text: markdown, messageId: sent.message_id });
        }
        return sent;
    }

    // --- Tool notifications for interactive mode ---

    #showToolNotification(toolName, result) {
        this.#log(`Tool notification check: ${toolName}, allowAll=${this.#allowAll}`);

        // Only notify for HA write tools
        const writeTools = new Set([
            "ha-mcp-ha_call_service", "ha-mcp-ha_call_event",
            "ha-mcp-ha_bulk_control", "ha-mcp-ha_backup_create",
            "ha-mcp-ha_backup_restore", "ha-mcp-ha_remove_entity",
            "ha-mcp-ha_config_set_automation",
        ]);
        if (!writeTools.has(toolName)) {
            this.#log(`Tool notification skipped: ${toolName} not a write tool`);
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
            this.#log(`Tool notification parse error: ${e.message}`);
            content = {};
        }

        const domain = content?.domain || "";
        const service = content?.service || "";
        const entityId = content?.entity_id || "";
        const success = content?.success !== false;

        this.#log(`Tool notification parsed: ${domain}.${service} → ${entityId} success=${success}`);

        if (!domain && !service) return;

        const emoji = success ? "⚡" : "❌";
        const action = `${domain}.${service}`;
        const target = entityId ? ` → ${entityId}` : "";
        const text = `${emoji} ${action}${target}`;

        // Determine undo action (reversible services)
        const reverseMap = {
            "turn_on": "turn_off",
            "turn_off": "turn_on",
            "open_cover": "close_cover",
            "close_cover": "open_cover",
            "lock": "unlock",
            "unlock": "lock",
            "activate": "deactivate",
        };
        const reverseService = reverseMap[service];

        const ref = this.#activeRef;
        const chatId = ref?.chatId || this.#allowedChatIds?.[0];
        if (!chatId) return;

        if (reverseService && entityId && success) {
            // Show with undo button
            const undoCmd = `/undo ${domain}.${reverseService} ${entityId}`;
            const rows = [[
                { text: "↩️ Undo", value: undoCmd },
                { text: "✅ OK", value: "dismiss" },
            ]];
            this.#log(`Sending undo notification to chat ${chatId}: ${text}`);
            this.#buttons.prompt(chatId, text, rows, {
                timeoutMs: 30000,
                timeoutText: null, // silently expire
            }).then(({ value: selected }) => {
                if (selected && selected.startsWith("/undo ")) {
                    const parts = selected.replace("/undo ", "").split(" ");
                    const [svc, eid] = [parts[0], parts.slice(1).join(" ")];
                    const [d, s] = svc.split(".");
                    this.#log(`Undo: ${d}.${s} → ${eid}`);
                    // Send undo command via prompt
                    this.#queuePrompt(
                        `Please call service ${d}.${s} on entity ${eid} to undo the previous action. Do it immediately without asking.`,
                        {}, ref, null
                    );
                }
            }).catch(err => {
                this.#log(`Tool notification error: ${err.message}`);
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

    #relayToolImages(result) {
        const contents = result?.contents;
        if (!contents || !Array.isArray(contents)) return;

        for (const block of contents) {
            if (block.type === "image" && block.data && block.mimeType) {
                const bytes = Math.ceil(block.data.length * 3 / 4);
                const ref = this.#activeRef;
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

    // --- Cleanup ---

    cleanup() {
        this.#stopTyping();
        this.#activeTools.clear();
        if (this.#messageFlushTimer) clearTimeout(this.#messageFlushTimer);
        try { rmSync(this.#tmpDir, { recursive: true, force: true }); } catch {}
    }
}
