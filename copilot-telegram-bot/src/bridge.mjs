// ============================================================
// Bridge — Telegram ↔ Copilot ACP Orchestrator
// ============================================================
// Handles message routing, typing indicators, tool call bubbles,
// file attachments, and session lifecycle.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "./formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { ButtonManager } from "./buttons.mjs";
import { ChatHistory } from "./history.mjs";
import { formatError } from "./errors.mjs";
import { MessageTransport, makeRef, refKey } from "./transport.mjs";
import { basename } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const BUBBLE_DEBOUNCE_MS = 300;
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

    // Bubble state
    #activeTools = new Map();
    #bubbleMessageIds = new Map();
    #allBubbleIds = new Map();
    #bubbleDebounce = null;
    #bubbleActive = false;
    #flushInProgress = false;
    #reflushNeeded = false;
    #lastCompletedToolDesc = null;

    // Message accumulator (collect chunks → send as complete message)
    // Use a longer flush timer as a safety net — primary flush happens on message_end
    #messageBuffer = "";
    #messageFlushTimer = null;
    #messageFlushMs = 2000;

    // Preamble
    #preambleSent = false;

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

    // Turn-level tracking for tool call reactions
    #turnToolCount = 0;
    #turnToolErrors = 0;
    #lastBotMessageId = null;  // Message ID of last bot message sent during this turn

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

    // --- Setup event handlers ---

    setupACPHandlers() {
        const acp = this.#acp;

        // Text chunks → accumulate and flush
        acp.on("text_chunk", (text) => {
            this.#resetTypingDebounce();
            this.#messageBuffer += text;
            if (this.#messageFlushTimer) clearTimeout(this.#messageFlushTimer);
            this.#messageFlushTimer = setTimeout(() => this.#flushMessageBuffer(), this.#messageFlushMs);
        });

        // Message boundaries
        acp.on("message_start", () => {
            this.#log("Agent message_start");
            this.#messageBuffer = "";
        });

        acp.on("message_end", () => {
            this.#log("Agent message_end");
            this.#flushMessageBuffer();
            this.#stopTyping();
            this.#dismissBubble();
        });

        // Tool calls → bubble updates
        acp.on("tool_start", ({ toolCallId, toolName, arguments: args }) => {
            this.#log(`Tool start: ${toolName} (${toolCallId})`);
            this.#turnToolCount++;
            this.#resetTypingDebounce();
            this.#bubbleActive = true;
            const desc = describeToolCall(toolName, args);
            if (desc) {
                this.#activeTools.set(toolCallId, { name: toolName, description: desc });
                this.#scheduleBubbleUpdate();
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
            if (completed?.description) {
                this.#lastCompletedToolDesc = completed.description;
            }
            this.#activeTools.delete(toolCallId);
            this.#scheduleBubbleUpdate();

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
            this.#dismissBubble();
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
            const selected = await this.#buttons.prompt(
                chatId,
                `🔐 Permission request:\n${label}`,
                rows,
                { timeoutMs: 60000, timeoutText: "🔐 Permission denied (timeout)" }
            );

            if (selected === allowOnceId || selected === allowAlwaysId) {
                if (selected === allowAlwaysId) {
                    this.#sessionGrantedTools.add(tool);
                }
                acp.respondPermission(requestId, selected);
                this.#log(`Permission granted (${selected}): ${tool}`);
            } else {
                acp.respondPermission(requestId, rejectOnceId);
                this.#log(`Permission denied: ${tool}`);
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
        if (this.#buttons.handleCallback(query)) return;

        // Legacy callback handling — acknowledge the button press
        try {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id });
        } catch {}

        const data = query.data;
        if (!data) return;

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
                this.#history.push({ role: "user", text, messageId: message.message_id });

                // Ack reaction
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
        this.#history.push({ role: "user", text, messageId: message.message_id });

        // Handle ask_user response
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
        this.#bubbleActive = true;
        this.#scheduleBubbleUpdate();

        // Ensure Copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                this.#stopTyping();
                this.#dismissBubble();
                this.#transport.enqueueSend(ref, formatError(err));
                return;
            }
        }

        // Build prompt
        const prefix = this.#getPrefix();
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
                            this.#transport.enqueueSend(ref,
                                `⚠️ Could not load session. Use /new to start a fresh session.\n` +
                                `Error: ${err.message}`
                            );
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
                        this.#transport.enqueueSend(ref, `⚠️ Failed to create session: ${err.message}`);
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
            this.#turnToolErrors++; // Count prompt failure for reaction
            const userMsg = formatError(err);
            if (ref) {
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
                this.#telegram.setMessageReaction(ref.chatId, messageId, null).catch(() => {});
            }

            // Flush remaining buffer BEFORE clearing activeRef
            // so output goes to the correct conversation
            this.#flushMessageBuffer();
            this.#stopTyping();
            this.#dismissBubble();

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

    #getPrefix() {
        if (!this.#preambleSent) {
            this.#preambleSent = true;
            let rules = this.#config.preamble;
            // In interactive mode, instruct the agent to confirm before write actions
            if (!this.#allowAll) {
                rules += `\n• SAFETY: Before performing ANY write action on Home Assistant (turning on/off devices, calling services, running automations, changing settings), you MUST first describe exactly what you plan to do and ask the user to confirm. Only proceed after explicit user confirmation. Read-only actions (searching entities, checking states, viewing history) are fine without confirmation.`;
            }
            return `[SYSTEM: This message arrived via Telegram. Follow these rules for your reply:\n• ${rules}]\n`;
        }
        // In interactive mode, include a shorter reminder on subsequent messages
        if (!this.#allowAll) {
            return "[Via Telegram — remember: confirm with user before any HA write actions]\n";
        }
        return "[Via Telegram]\n";
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

        this.#broadcastAdmin("🟢 Copilot session started.");
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
        if (!reply) return "";

        const isBotReply = reply.from?.is_bot;
        const MAX_QUOTE = 500;

        // Determine the quoted content
        let quotedText = reply.text || reply.caption || "";

        if (!quotedText) {
            // Non-text messages — describe the content type
            if (reply.photo) quotedText = "<photo>";
            else if (reply.sticker) quotedText = `<sticker: ${reply.sticker.emoji || "🎴"}>`;
            else if (reply.voice) quotedText = "<voice message>";
            else if (reply.video) quotedText = "<video>";
            else if (reply.video_note) quotedText = "<video note>";
            else if (reply.audio) quotedText = `<audio: ${reply.audio.title || "audio"}>`;
            else if (reply.document) quotedText = `<file: ${reply.document.file_name || "document"}>`;
            else if (reply.animation) quotedText = "<GIF>";
            else if (reply.location) quotedText = `<location: ${reply.location.latitude}, ${reply.location.longitude}>`;
            else if (reply.poll) quotedText = `<poll: ${reply.poll.question}>`;
            else if (reply.contact) quotedText = `<contact: ${reply.contact.first_name}>`;
            else quotedText = "<message>";
        }

        // Truncate long quotes
        if (quotedText.length > MAX_QUOTE) {
            quotedText = quotedText.substring(0, MAX_QUOTE) + "…";
        }

        // Also check our history for the original message (may have richer context)
        const historyEntry = this.#history.findByMessageId(reply.message_id);
        if (historyEntry && historyEntry.text.length > quotedText.length) {
            quotedText = historyEntry.text.substring(0, MAX_QUOTE);
            if (historyEntry.text.length > MAX_QUOTE) quotedText += "…";
        }

        const source = isBotReply ? "Replying to bot" : "Replying to";
        return `[${source}: "${quotedText}"]`;
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
            }).then(selected => {
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
                this.#telegram.call("sendMessage", { chat_id: chatId, text, ...extra })
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
            if (this.#bubbleActive) this.#resetTypingDebounce();
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

    // --- Tool call bubble ---

    #composeBubbleText() {
        const lines = [];
        for (const [, info] of this.#activeTools) {
            if (info.description) lines.push(`● ${info.description}`);
        }
        if (lines.length === 0) {
            if (this.#lastCompletedToolDesc) return `● ${this.#lastCompletedToolDesc}`;
            return null;
        }
        return lines.join("\n");
    }

    #scheduleBubbleUpdate() {
        if (!this.#bubbleActive) return;
        if (this.#bubbleDebounce) clearTimeout(this.#bubbleDebounce);
        this.#bubbleDebounce = setTimeout(() => this.#flushBubble(), BUBBLE_DEBOUNCE_MS);
    }

    async #flushBubble() {
        this.#bubbleDebounce = null;
        if (!this.#bubbleActive) return;
        if (this.#flushInProgress) { this.#reflushNeeded = true; return; }
        this.#flushInProgress = true;

        try {
            const text = this.#composeBubbleText();
            if (!text) return;

            const ref = this.#activeRef;
            const targets = ref ? [ref.chatId] : [...this.#allowedChatIds];

            for (const chatId of targets) {
                const existingId = this.#bubbleMessageIds.get(chatId);
                if (existingId) {
                    try {
                        await this.#telegram.enqueue(() =>
                            this.#telegram.editMessageText(chatId, existingId, text)
                        );
                    } catch (err) {
                        if (/message is not modified/i.test(err?.message)) {
                            // unchanged
                        } else if (/message to edit not found/i.test(err?.message)) {
                            this.#bubbleMessageIds.delete(chatId);
                            this.#allBubbleIds.get(chatId)?.delete(existingId);
                            if (!this.#bubbleActive) continue;
                            try {
                                const params = { chat_id: chatId, text };
                                if (ref?.threadId) params.message_thread_id = ref.threadId;
                                const sent = await this.#telegram.enqueue(() =>
                                    this.#telegram.call("sendMessage", params)
                                );
                                if (!this.#bubbleActive) {
                                    try { await this.#telegram.enqueue(() => this.#telegram.deleteMessage(chatId, sent.message_id)); } catch {}
                                } else {
                                    this.#trackBubble(chatId, sent.message_id);
                                }
                            } catch {}
                        }
                    }
                } else {
                    if (!this.#bubbleActive) continue;
                    try {
                        const params = { chat_id: chatId, text };
                        if (ref?.threadId) params.message_thread_id = ref.threadId;
                        const sent = await this.#telegram.enqueue(() =>
                            this.#telegram.call("sendMessage", params)
                        );
                        if (!this.#bubbleActive) {
                            try { await this.#telegram.enqueue(() => this.#telegram.deleteMessage(chatId, sent.message_id)); } catch {}
                        } else {
                            this.#trackBubble(chatId, sent.message_id);
                        }
                    } catch {}
                }
            }
        } finally {
            this.#flushInProgress = false;
            if (this.#reflushNeeded) {
                this.#reflushNeeded = false;
                this.#scheduleBubbleUpdate();
            }
        }
    }

    #trackBubble(chatId, messageId) {
        this.#bubbleMessageIds.set(chatId, messageId);
        if (!this.#allBubbleIds.has(chatId)) this.#allBubbleIds.set(chatId, new Set());
        this.#allBubbleIds.get(chatId).add(messageId);
    }

    async #dismissBubble() {
        this.#bubbleActive = false;
        this.#reflushNeeded = false;
        if (this.#bubbleDebounce) { clearTimeout(this.#bubbleDebounce); this.#bubbleDebounce = null; }
        this.#activeTools.clear();
        this.#lastCompletedToolDesc = null;
        await this.#deleteAllBubbles();
        setTimeout(() => this.#deleteAllBubbles(), 2000);
    }

    async #deleteAllBubbles() {
        for (const [chatId, ids] of this.#allBubbleIds) {
            for (const msgId of ids) {
                try { await this.#telegram.enqueue(() => this.#telegram.deleteMessage(chatId, msgId)); } catch {}
            }
            ids.clear();
        }
        this.#allBubbleIds.clear();
        this.#bubbleMessageIds.clear();
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
        this.#dismissBubble();
        if (this.#messageFlushTimer) clearTimeout(this.#messageFlushTimer);
        try { rmSync(this.#tmpDir, { recursive: true, force: true }); } catch {}
    }
}
