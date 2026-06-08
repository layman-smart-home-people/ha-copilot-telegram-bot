// ============================================================
// UdsServer — UDS IPC for MCP sidecar tools (v7)
// ============================================================
// Handles: ask_user, notify_user, background_task, telegram_call
// Replaces InteractiveFlows UDS server from v6.

import { createServer as createNetServer } from "node:net";
import { unlinkSync, chmodSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("uds");
const TG_UX_SOCK = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_PENDING = 10;

export class UdsServer {
    #telegram;
    #conversationManager;
    #config;
    #server = null;

    // Pending ask_user questions: questionId → { resolve, chatId, options, messageId, freeText, timer }
    #pending = new Map();

    constructor({ telegram, conversationManager, config }) {
        this.#telegram = telegram;
        this.#conversationManager = conversationManager || null;
        this.#config = config;
    }

    /** Set conversation manager (when UDS starts before ConversationManager). */
    setConversationManager(cm) { this.#conversationManager = cm; }

    // ── Lifecycle ────────────────────────────────────────────

    start() {
        try { unlinkSync(TG_UX_SOCK); } catch {}
        this.#server = createNetServer({ allowHalfOpen: true }, (conn) => {
            let buf = "";
            conn.on("data", (chunk) => {
                buf += chunk.toString();
                const nl = buf.indexOf("\n");
                if (nl === -1) return;
                const line = buf.slice(0, nl);
                buf = "";
                let req;
                try { req = JSON.parse(line); } catch {
                    try { conn.end(JSON.stringify({ error: "Invalid JSON" })); } catch {}
                    return;
                }
                const method = req.method || "ask_user";
                const scopeKey = req.scopeKey;
                log.debug(`UDS: ${method} (scope=${scopeKey || "?"})`);
                this.#route(method, req.params || {}, scopeKey)
                    .then(r => { try { conn.end(JSON.stringify(r)); } catch {} })
                    .catch(e => { try { conn.end(JSON.stringify({ error: e.message })); } catch {} });
            });
            conn.on("error", () => {});
        });
        this.#server.on("error", (e) => log.debug(`UDS server error: ${e.message}`));
        return new Promise((resolve) => {
            this.#server.listen(TG_UX_SOCK, () => {
                try { chmodSync(TG_UX_SOCK, 0o600); } catch {}
                log.info(`UDS server listening on ${TG_UX_SOCK}`);
                resolve();
            });
        });
    }

    stop() {
        if (this.#server) {
            this.#server.close();
            this.#server = null;
            try { unlinkSync(TG_UX_SOCK); } catch {}
        }
        for (const [id, q] of this.#pending) {
            clearTimeout(q.timer);
            q.resolve({ error: "Server shutting down" });
        }
        this.#pending.clear();
    }

    // ── Callback / text hooks (called by Router) ─────────────

    /** Handle a Telegram callback_query with data starting with "uds:". Returns true if handled. */
    handleCallback(query) {
        const data = query.data;
        if (!data?.startsWith("uds:")) return false;

        const parts = data.split(":");
        const qId = parts[1];
        const value = parts.slice(2).join(":");
        const q = this.#pending.get(qId);
        if (!q) return false;

        this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});

        if (value === "__cancel__") {
            this.#resolve(qId, { error: "User cancelled" });
        } else if (value === "__custom__") {
            q.freeText = true;
            this.#telegram.call("editMessageText", {
                chat_id: q.chatId,
                message_id: q.messageId,
                text: "✏️ Type your answer below:",
            }).catch(() => {});
        } else {
            const idx = parseInt(value, 10);
            const answer = (!isNaN(idx) && q.options?.[idx]) ? q.options[idx].value : value;
            this.#resolve(qId, { answer });
        }
        return true;
    }

    /** Try to resolve a pending free-text question for this chatId. Returns true if consumed. */
    tryResolveText(chatId, text) {
        for (const [qId, q] of this.#pending) {
            if (String(q.chatId) === String(chatId) && q.freeText) {
                // Update the button message to show the answer
                if (q.messageId) {
                    this.#telegram.call("editMessageText", {
                        chat_id: q.chatId,
                        message_id: q.messageId,
                        text: `✅ ${text}`,
                    }).catch(() => {});
                }
                this.#resolve(qId, { answer: text });
                return true;
            }
        }
        return false;
    }

    /** Cancel all pending questions (e.g., on /stop). */
    cancelAll(reason = "Cancelled") {
        for (const [qId] of this.#pending) {
            this.#resolve(qId, { error: reason });
        }
    }

    get hasPending() { return this.#pending.size > 0; }

    // ── Request routing ──────────────────────────────────────

    async #route(method, params, scopeKey) {
        switch (method) {
            case "ask_user":       return this.#askUser(params, scopeKey);
            case "notify_user":    return this.#notifyUser(params);
            case "background_task": return this.#backgroundTask(params, scopeKey);
            case "telegram_call":  return this.#telegramCall(params);
            default:               return { error: `Unknown method: ${method}` };
        }
    }

    // ── Helpers ──────────────────────────────────────────────

    #resolveChatId(scopeKey) {
        if (scopeKey) {
            const conv = this.#conversationManager.get(scopeKey);
            if (conv?.ref?.chatId) return { chatId: conv.ref.chatId, threadId: conv.ref.threadId };
        }
        const chatId = this.#config.allowedChatIds?.[0];
        return chatId ? { chatId } : {};
    }

    #resolve(qId, result) {
        const q = this.#pending.get(qId);
        if (!q) return;
        clearTimeout(q.timer);
        this.#pending.delete(qId);
        q.resolve(result);
    }

    // ── Method handlers ─────────────────────────────────────

    async #askUser({ message, options }, scopeKey) {
        const { chatId, threadId } = this.#resolveChatId(scopeKey);
        if (!chatId) return { error: "No active chat" };
        if (!message) return { error: "No message provided" };
        if (this.#pending.size >= MAX_PENDING) return { error: "Too many pending questions" };

        const qId = `q${Date.now().toString(36)}`;
        const hasButtons = Array.isArray(options) && options.length > 0 && options.length <= 8;

        // Build inline keyboard
        let replyMarkup;
        if (hasButtons) {
            const rows = options.map((opt, i) => [{
                text: opt.label || opt.value,
                callback_data: `uds:${qId}:${i}`,
            }]);
            rows.push([{ text: "✏️ Something else", callback_data: `uds:${qId}:__custom__` }]);
            rows.push([{ text: "❌ Cancel", callback_data: `uds:${qId}:__cancel__` }]);
            replyMarkup = { inline_keyboard: rows };
        } else {
            replyMarkup = { inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: `uds:${qId}:__cancel__` }],
            ]};
        }

        const sendParams = {
            chat_id: chatId,
            text: `❓ ${message}${!hasButtons ? "\n\nType your answer below:" : ""}`,
            reply_markup: replyMarkup,
            link_preview_options: { is_disabled: true },
        };
        if (threadId) sendParams.message_thread_id = threadId;

        return new Promise((resolve) => {
            const timer = setTimeout(() => this.#resolve(qId, { error: "Question timed out" }), QUESTION_TIMEOUT_MS);
            const entry = { resolve, chatId, options: options || [], freeText: !hasButtons, timer };
            this.#pending.set(qId, entry);

            this.#telegram.call("sendMessage", sendParams)
                .then(sent => { entry.messageId = sent?.message_id; })
                .catch(err => {
                    log.warn(`ask_user send failed: ${err.message}`);
                    this.#resolve(qId, { error: `Send failed: ${err.message}` });
                });
        });
    }

    #notifyUser({ message }) {
        if (!message?.trim()) return Promise.resolve({ error: "message is required" });
        const chatId = this.#config.allowedChatIds?.[0];
        if (!chatId) return Promise.resolve({ error: "No chat available" });
        log.info(`notify_user: "${message.substring(0, 80)}"`);
        this.#telegram.call("sendMessage", {
            chat_id: chatId, text: message,
            link_preview_options: { is_disabled: true },
        }).catch(err => log.warn(`notify_user failed: ${err.message}`));
        return Promise.resolve({ status: "sent" });
    }

    async #backgroundTask({ prompt, description, groupId, groupSize }, scopeKey) {
        if (!prompt) return { error: "prompt is required" };
        if (!description) return { error: "description is required" };

        const { chatId } = this.#resolveChatId(scopeKey);
        if (!chatId) return { error: "No chat for result delivery" };

        const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        log.info(`Background task: ${taskId} — "${description}"`);

        const ref = { chatId, chatType: "private", userId: chatId };
        try {
            await this.#conversationManager.route(`bg:${taskId}`, prompt, ref, {});
            const result = { taskId, status: "completed" };
            if (groupId) { result.groupId = groupId; result.groupSize = groupSize; }
            return result;
        } catch (err) {
            log.warn(`Background task failed: ${err.message}`);
            return { error: err.message };
        }
    }

    async #telegramCall({ method, params: apiParams }) {
        if (!method || typeof method !== "string") return { error: "method is required" };
        if (/^(set|delete)webhook|getme|logout|close$/i.test(method)) {
            return { error: `Method '${method}' not allowed` };
        }
        log.info(`telegram_call: ${method}`);
        try {
            const result = await this.#telegram.call(method, apiParams || {});
            return { data: result };
        } catch (err) {
            return { error: err.message };
        }
    }
}
