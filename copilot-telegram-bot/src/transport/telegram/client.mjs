// ============================================================
// Telegram Bot API Client
// ============================================================
// Full Telegram Bot API client with long polling, rate limiting,
// send queue, and all methods needed for a rich bot experience.

import { EventEmitter } from "node:events";
import { createLogger } from "../../logger.mjs";

const TELEGRAM_API = "https://api.telegram.org";
const log = createLogger("tg-client");

export class TelegramClient extends EventEmitter {
    #token;
    #offset = 0;
    #polling = false;
    #abortController = null;
    #pollTimeout;
    #apiTimeout;
    #sendQueue = [];
    #sendQueueRunning = false;
    #sendPaceMs;
    #botInfo = null;

    constructor({ token, pollTimeout = 30, apiTimeout = 30000, sendPaceMs = 50 }) {
        super();
        this.#token = token;
        this.#pollTimeout = pollTimeout;
        this.#apiTimeout = apiTimeout;
        this.#sendPaceMs = sendPaceMs;
    }

    get botInfo() { return this.#botInfo; }
    set offset(v) { this.#offset = v; }
    get offset() { return this.#offset; }

    // --- Core API ---

    async call(method, params = {}) {
        const url = `${TELEGRAM_API}/bot${this.#token}/${method}`;
        const timeoutMs = method === "getUpdates"
            ? (this.#pollTimeout + 10) * 1000
            : this.#apiTimeout;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = method === "getUpdates" && this.#abortController
            ? AbortSignal.any([this.#abortController.signal, timeoutSignal])
            : timeoutSignal;

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
            signal,
        });

        if (res.status === 409) {
            const err = new Error("Conflict: another process is polling this bot");
            err.status = 409;
            throw err;
        }
        if (res.status === 429) {
            const body = await res.json().catch(() => ({}));
            const err = new Error("Rate limited");
            err.status = 429;
            err.retryAfter = body?.parameters?.retry_after || 5;
            throw err;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            // Auto-recover from stale/invalid thread IDs (e.g., forum→non-forum switch)
            if (res.status === 400 && /thread not found/i.test(body) && params.message_thread_id) {
                log.warn(`Thread ${params.message_thread_id} not found in ${method}, retrying without threadId`);
                const { message_thread_id: _, ...retryParams } = params;
                return this.call(method, retryParams);
            }
            const err = new Error(`Telegram API ${method} failed: ${res.status} ${body}`);
            err.status = res.status;
            throw err;
        }
        const json = await res.json();
        if (!json.ok) throw new Error(`Telegram API ${method} returned ok=false: ${JSON.stringify(json)}`);
        return json.result;
    }

    // --- Convenience methods ---

    async getMe() {
        this.#botInfo = await this.call("getMe");
        return this.#botInfo;
    }

    sendMessage(chatId, text, parseMode, replyMarkup) {
        const params = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
        if (parseMode) params.parse_mode = parseMode;
        if (replyMarkup) params.reply_markup = replyMarkup;
        return this.call("sendMessage", params);
    }

    editMessageText(chatId, messageId, text, parseMode) {
        const params = { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } };
        if (parseMode) params.parse_mode = parseMode;
        return this.call("editMessageText", params);
    }

    deleteMessage(chatId, messageId) {
        return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    }

    sendChatAction(chatId, action = "typing") {
        return this.call("sendChatAction", { chat_id: chatId, action });
    }

    sendMessageDraft(chatId, draftId, text, parseMode) {
        const params = { chat_id: chatId, draft_id: draftId };
        if (text != null) params.text = text;
        if (parseMode) params.parse_mode = parseMode;
        return this.call("sendMessageDraft", params);
    }

    setMessageReaction(chatId, messageId, emoji) {
        return this.call("setMessageReaction", {
            chat_id: chatId, message_id: messageId,
            reaction: emoji ? [{ type: "emoji", emoji }] : [],
        });
    }

    getFile(fileId) {
        return this.call("getFile", { file_id: fileId });
    }

    /**
     * Send a raw FormData request to a Telegram API method.
     */
    async callForm(method, form) {
        const url = `${TELEGRAM_API}/bot${this.#token}/${method}`;
        const res = await fetch(url, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(this.#apiTimeout),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            // Auto-recover from stale/invalid thread IDs
            if (res.status === 400 && /thread not found/i.test(body) && form.has("message_thread_id")) {
                log.warn(`Thread not found in ${method}, retrying without threadId`);
                form.delete("message_thread_id");
                return this.callForm(method, form);
            }
            throw new Error(`Telegram ${method} failed: ${res.status} ${body}`);
        }
        return (await res.json()).result;
    }

    async sendPhoto(chatId, buffer, mimeType, caption) {
        const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : "png";
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("photo", new File([buffer], `image.${ext}`, { type: mimeType }));
        if (caption) form.append("caption", caption.slice(0, 1024));
        return this.callForm("sendPhoto", form);
    }

    async sendDocument(chatId, buffer, mimeType, filename, caption) {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("document", new File([buffer], filename || "file", { type: mimeType }));
        if (caption) form.append("caption", caption.slice(0, 1024));
        return this.callForm("sendDocument", form);
    }

    async downloadFile(filePath) {
        const url = `${TELEGRAM_API}/file/bot${this.#token}/${filePath}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }

    // --- Send Queue ---

    enqueue(fn) {
        return new Promise((resolve, reject) => {
            this.#sendQueue.push({ fn, resolve, reject });
            if (!this.#sendQueueRunning) this.#drainQueue();
        });
    }

    async #drainQueue() {
        this.#sendQueueRunning = true;
        while (this.#sendQueue.length > 0) {
            const { fn, resolve, reject } = this.#sendQueue.shift();
            try {
                resolve(await fn());
            } catch (err) {
                if (err.status === 429) {
                    this.#sendQueue.unshift({ fn, resolve, reject });
                    await sleep(err.retryAfter * 1000);
                    continue;
                }
                reject(err);
            }
            if (this.#sendQueue.length > 0) await sleep(this.#sendPaceMs);
        }
        this.#sendQueueRunning = false;
    }

    // --- Polling ---

    async startPolling() {
        if (this.#polling) return;
        this.#polling = true;
        let errorDelay = 5000;

        while (this.#polling) {
            this.#abortController = new AbortController();
            try {
                const updates = await this.call("getUpdates", {
                    offset: this.#offset,
                    timeout: this.#pollTimeout,
                    allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"],
                });
                errorDelay = 5000;

                for (const update of updates) {
                    this.emit("update", update);
                    this.#offset = update.update_id + 1;
                }
            } catch (err) {
                if (!this.#polling) break;
                if (this.#abortController.signal.aborted) break;

                if (err.status === 409) {
                    this.emit("conflict");
                    break;
                }

                this.emit("poll_error", err);
                await sleep(errorDelay);
                errorDelay = Math.min(errorDelay * 2, 60000);
            }
        }
    }

    stopPolling() {
        this.#polling = false;
        if (this.#abortController) this.#abortController.abort();
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
