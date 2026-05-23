// ============================================================
// Bridge — Telegram ↔ Copilot ACP Orchestrator
// ============================================================
// Handles message routing, typing indicators, tool call bubbles,
// file attachments, and session lifecycle.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "./formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { basename } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

    // Temp dir
    #tmpDir;

    constructor({ telegram, acp, config, log }) {
        this.#telegram = telegram;
        this.#acp = acp;
        this.#config = config;
        this.#log = log;
        this.#allowedChatIds = (config.allowedChatIds || []).map(Number);
        this.#tmpDir = join("/tmp", `copilot-tg-${process.pid}`);
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

        acp.on("permission", (params) => {
            this.#log(`Auto-approved permission: ${JSON.stringify(params).substring(0, 200)}`);
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

    async #processUpdate(update) {
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
                    this.#telegram.sendMessage(chatId, `❌ Failed to start Copilot: ${err.message}`)
                );
                return;
            }
        }

        // Build prompt
        const prefix = this.#getPrefix();
        let promptText = prefix + (text || "");

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
                    this.#telegram.sendMessage(chatId, `Failed to process attachment: ${err.message}`)
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
            for (const chatId of this.#allowedChatIds) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, `❌ Error: ${err.message}`)
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

        await this.#acp.start();
        // Don't pass stdio-based MCP servers in session/new params —
        // copilot reads them from ~/.copilot/mcp.json automatically
        await this.#acp.newSession({
            cwd: this.#config.workingDirectory || "/config",
        });

        this.#preambleSent = false;
        this.#log(`Copilot started, session: ${this.#acp.sessionId}`);

        for (const chatId of this.#allowedChatIds) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, "🟢 Copilot session started.")
            );
        }
    }

    async stopCopilot() {
        await this.#acp.stop();
        this.#preambleSent = false;
    }

    async restartCopilot() {
        await this.stopCopilot();
        await this.startCopilot();
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
