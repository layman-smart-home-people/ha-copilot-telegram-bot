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
    #sessionGrantedTools = new Set();

    constructor({ telegram, acp, config, log }) {
        this.#telegram = telegram;
        this.#acp = acp;
        this.#config = config;
        this.#log = log;
        this.#allowedChatIds = (config.allowedChatIds || []).map(Number);
        this.#tmpDir = join("/tmp", `copilot-tg-${process.pid}`);
        this.#buttons = new ButtonManager(telegram);
        this.#history = new ChatHistory(50);
    }

    get allowedChatIds() { return this.#allowedChatIds; }
    get promptActive() { return this.#promptActive; }

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
            this.#messageBuffer = "";
        });

        acp.on("message_end", () => {
            this.#flushMessageBuffer();
            this.#stopTyping();
            this.#dismissBubble();
        });

        // Tool calls → bubble updates
        acp.on("tool_start", ({ toolCallId, toolName, arguments: args }) => {
            this.#resetTypingDebounce();
            this.#bubbleActive = true;
            const desc = describeToolCall(toolName, args);
            if (desc) {
                this.#activeTools.set(toolCallId, { name: toolName, description: desc });
                this.#scheduleBubbleUpdate();
            }
        });

        acp.on("tool_end", ({ toolCallId, result }) => {
            this.#resetTypingDebounce();
            const completed = this.#activeTools.get(toolCallId);
            if (completed?.description) {
                this.#lastCompletedToolDesc = completed.description;
            }
            this.#activeTools.delete(toolCallId);
            this.#scheduleBubbleUpdate();

            // Relay images from tool results
            this.#relayToolImages(result);
        });

        // Process exit — handle crash recovery
        acp.on("exit", ({ code, signal }) => {
            this.#stopTyping();
            this.#dismissBubble();
            this.#flushMessageBuffer();

            // Crash recovery: reject any active prompt so the queue doesn't wedge
            if (this.#promptActive) {
                this.#promptActive = false;
                // Drain the queue — notify users that queued messages were lost
                const dropped = this.#promptQueue.length;
                this.#promptQueue = [];
                if (dropped > 0) {
                    for (const chatId of this.#allowedChatIds) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, `⚠️ ${dropped} queued message(s) dropped due to Copilot exit.`)
                        );
                    }
                }
            }

            // Don't broadcast exit if it was intentional (code 0 or null = SIGTERM)
            if (code !== 0 && code !== null) {
                for (const chatId of this.#allowedChatIds) {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(chatId, `⚠️ Copilot process exited (code: ${code}). Send a message to restart.`)
                    );
                }
            }
        });

        acp.on("error", (err) => {
            this.#log(`ACP error: ${err.message}`);
        });

        acp.on("log", (text) => {
            this.#log(`ACP: ${text}`);
        });

        acp.on("permission_request", async (req) => {
            const { requestId, toolName, description } = req;
            const tool = toolName || req.tool || "unknown_tool";
            const desc = description || req.input?.service || "";

            // Policy: auto-approve read-only HA tools + standard copilot tools
            const readOnlyTools = new Set([
                "ha_search_entities", "ha_get_state", "ha_get_history",
                "ha_deep_search", "ha_get_overview", "ha_get_entity_state",
                "ha_search_automations", "ha_get_automation",
            ]);
            const isReadOnly = readOnlyTools.has(tool) || !tool.startsWith("ha_");

            // Session grants: user previously allowed this tool for the session
            if (isReadOnly || this.#sessionGrantedTools.has(tool)) {
                acp.respondPermission(requestId, "approved");
                this.#log(`Permission auto-approved: ${tool}`);
                return;
            }

            // Ask user via inline buttons
            const chatId = this.#allowedChatIds?.[0];
            if (!chatId || !this.#buttons) {
                // No chat to ask — deny by default
                acp.respondPermission(requestId, "denied");
                this.#log(`Permission denied (no chat): ${tool}`);
                return;
            }

            const label = desc ? `${tool}\n${desc}` : tool;
            const rows = [
                [
                    { text: "✅ Allow once", value: "once" },
                    { text: "✅ Allow session", value: "session" },
                    { text: "❌ Deny", value: "deny" },
                ],
            ];
            const selected = await this.#buttons.prompt(
                chatId,
                `🔐 Permission request:\n${label}`,
                rows,
                { timeoutMs: 60000, timeoutText: "🔐 Permission denied (timeout)" }
            );

            if (selected === "once" || selected === "session") {
                if (selected === "session") {
                    this.#sessionGrantedTools.add(tool);
                }
                acp.respondPermission(requestId, "approved");
                this.#log(`Permission granted (${selected}): ${tool}`);
            } else {
                acp.respondPermission(requestId, "denied");
                this.#log(`Permission denied: ${tool}`);
            }
        });

        // Capture session data (models, modes) from session events
        acp.on("session", (result) => {
            if (result.models?.availableModels) {
                this.#models = result.models.availableModels;
                this.#log(`Models available: ${this.#models.length}`);
            }
            if (result.modes?.availableModes) {
                this.#modes = result.modes.availableModes;
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
            const modeOpt = options?.find(o => o.id === "mode");
            if (modeOpt?.options) {
                this.#modes = modeOpt.options.map(o => ({
                    id: o.value,
                    name: o.name,
                    description: o.description,
                }));
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

    // --- Inbound message processing ---

    async #handleCallbackQuery(query) {
        const chatId = query.message?.chat?.id;
        const userId = query.from?.id;
        if (!chatId || !this.#allowedChatIds.includes(userId)) return;

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

        // Route callback data as slash commands
        const parts = data.split(" ");
        const command = parts[0].replace("/", "");
        const args = parts.slice(1).join(" ");

        await handleSlashCommand({
            acp: this.#acp,
            telegram: this.#telegram,
            chatId,
            chatIds: this.#allowedChatIds,
            log: this.#log,
            startCopilot: () => this.startCopilot(),
            stopCopilot: () => this.stopCopilot(),
            restartCopilot: () => this.restartCopilot(),
            buttons: this.#buttons,
            models: this.#models,
            modes: this.#modes,
            history: this.#history,
        }, command, args);
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
        if (userId == null) return;

        const text = message.text || message.caption || "";

        // Check if user is allowed
        if (!this.#allowedChatIds.includes(userId)) {
            this.#log(`Ignoring message from unauthorized user: ${userId}`);
            return;
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

        // Ack reaction
        this.#telegram.enqueue(() =>
            this.#telegram.setMessageReaction(chatId, message.message_id, "👀").catch(() => {})
        );

        // Handle slash commands BEFORE typing
        if (message.text?.startsWith("/")) {
            const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
            if (parsed) {
                const handled = await handleSlashCommand({
                    acp: this.#acp,
                    telegram: this.#telegram,
                    chatId,
                    chatIds: this.#allowedChatIds,
                    log: this.#log,
                    startCopilot: () => this.startCopilot(),
                    stopCopilot: () => this.stopCopilot(),
                    restartCopilot: () => this.restartCopilot(),
                    buttons: this.#buttons,
                    models: this.#models,
                    modes: this.#modes,
                    history: this.#history,
                }, parsed.command, parsed.args);
                if (handled) return;
            }
            // Unknown command — fall through to prompt
        }

        // Start typing
        this.#startTyping();
        this.#bubbleActive = true;
        this.#scheduleBubbleUpdate();

        // Ensure Copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                this.#stopTyping();
                this.#dismissBubble();
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, formatError(err))
                );
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
                    });
                    return;
                }
            } catch (err) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, formatError(err))
                );
                return;
            }
        }

        if (promptText.trim()) {
            await this.#queuePrompt(promptText);
            return;
        }

        this.#telegram.enqueue(() =>
            this.#telegram.sendMessage(chatId, "Unsupported message type.")
        );
    }

    // --- Prompt queue (one at a time) ---

    async #queuePrompt(text, opts = {}) {
        if (this.#promptActive) {
            this.#promptQueue.push({ text, opts });
            return;
        }
        this.#promptActive = true;

        try {
            await this.#acp.prompt(text, opts);
        } catch (err) {
            this.#log(`Prompt error: ${err.message}`);
            const userMsg = formatError(err);
            for (const chatId of this.#allowedChatIds) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, userMsg)
                );
            }
        } finally {
            this.#promptActive = false;
            this.#flushMessageBuffer();
            this.#stopTyping();
            this.#dismissBubble();

            // Process queued prompts
            if (this.#promptQueue.length > 0) {
                const next = this.#promptQueue.shift();
                this.#queuePrompt(next.text, next.opts);
            }
        }
    }

    // --- Preamble ---

    #getPrefix() {
        if (!this.#preambleSent) {
            this.#preambleSent = true;
            return `[SYSTEM: This message arrived via Telegram. Follow these rules for your reply:\n• ${this.#config.preamble}]\n`;
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

        for (const chatId of this.#allowedChatIds) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, "🟢 Copilot session started.")
            );
        }
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
                    for (const chatId of this.#allowedChatIds) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(
                                chatId,
                                "⏰ Login timed out. Send any message to get a fresh code."
                            )
                        );
                    }
                    reject(new Error("Login timed out"));
                }
            }, 10 * 60 * 1000);

            proc.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                stdout += text;
                this.#log(`[login] stdout: ${text.trim()}`);
                if (!codeSent) {
                    const match = stdout.match(/enter code ([A-Z0-9]{4}-[A-Z0-9]{4})/);
                    if (match && this.#allowedChatIds.length > 0) {
                        codeSent = true;
                        const code = match[1];
                        this.#log(`[login] Device code: ${code}`);
                        for (const chatId of this.#allowedChatIds) {
                            this.#telegram.enqueue(() =>
                                this.#telegram.sendMessage(
                                    chatId,
                                    `🔐 GitHub authentication required\n\n` +
                                    `1️⃣ Visit: https://github.com/login/device\n` +
                                    `2️⃣ Enter code: ${code}\n\n` +
                                    `⏳ Waiting for you to authorize...\n` +
                                    `(One-time setup — takes 30 seconds)`,
                                    undefined,
                                    {
                                        inline_keyboard: [[
                                            { text: "🔗 Open GitHub", url: "https://github.com/login/device" }
                                        ]]
                                    }
                                )
                            );
                        }
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
                for (const chatId of this.#allowedChatIds) {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(chatId, "✅ Login flow completed — verifying token...")
                    );
                }
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
        for (const chatId of this.#allowedChatIds) {
            for (const chunk of chunks) {
                this.#telegram.enqueue(() => this.#sendFormatted(chatId, chunk));
            }
        }
    }

    async #sendFormatted(chatId, markdown) {
        const html = markdownToTelegramHtml(markdown);
        try {
            return await this.#telegram.sendMessage(chatId, html, "HTML");
        } catch (err) {
            if (err.message && /can.t parse|entit/i.test(err.message)) {
                return this.#telegram.sendMessage(chatId, markdown);
            }
            throw err;
        }
    }

    // --- Relay images from tool results ---

    #relayToolImages(result) {
        const contents = result?.contents;
        if (!contents || !Array.isArray(contents)) return;

        for (const block of contents) {
            if (block.type === "image" && block.data && block.mimeType) {
                const bytes = Math.ceil(block.data.length * 3 / 4);
                for (const chatId of this.#allowedChatIds) {
                    if (bytes > MAX_PHOTO_BYTES) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "(Image too large for Telegram, >10MB)")
                        );
                        continue;
                    }
                    const buf = Buffer.from(block.data, "base64");
                    if (PHOTO_MIMES.has(block.mimeType)) {
                        this.#telegram.enqueue(() => this.#telegram.sendPhoto(chatId, buf, block.mimeType));
                    } else {
                        const ext = block.mimeType.split("/")[1] || "bin";
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendDocument(chatId, buf, block.mimeType, `image.${ext}`)
                        );
                    }
                }
            }
        }
    }

    // --- Typing indicators ---

    #startTyping() {
        this.#stopTyping();
        const doType = () => {
            for (const chatId of this.#allowedChatIds) {
                this.#telegram.enqueue(() => this.#telegram.sendChatAction(chatId).catch(() => {}));
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

            for (const chatId of this.#allowedChatIds) {
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
                                const sent = await this.#telegram.enqueue(() =>
                                    this.#telegram.sendMessage(chatId, text)
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
                        const sent = await this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, text)
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

    // --- Cleanup ---

    cleanup() {
        this.#stopTyping();
        this.#dismissBubble();
        if (this.#messageFlushTimer) clearTimeout(this.#messageFlushTimer);
        try { rmSync(this.#tmpDir, { recursive: true, force: true }); } catch {}
    }
}
