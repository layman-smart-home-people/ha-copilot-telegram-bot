// ============================================================
// UdsServer — UDS IPC for MCP sidecar tools (v7)
// ============================================================
// Handles: ask_user, notify_user, send_file, background_task, telegram_call
// Replaces InteractiveFlows UDS server from v6.

import { createServer as createNetServer } from "node:net";
import { unlinkSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import { withThread } from "../transport/telegram/thread.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("uds");
const TG_UX_SOCK = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_PENDING = 10;

export class UdsServer {
    #telegram;
    #conversationManager;
    #config;
    #rbac;
    #controlStore;
    #server = null;

    // Pending ask_user questions: questionId → { resolve, chatId, options, messageId, freeText, timer }
    #pending = new Map();

    constructor({ telegram, conversationManager, config, rbac, controlStore }) {
        this.#telegram = telegram;
        this.#conversationManager = conversationManager || null;
        this.#rbac = rbac || null;
        this.#config = config;
        this.#controlStore = controlStore || null;
    }

    /** Set conversation manager (when UDS starts before ConversationManager). */
    setConversationManager(cm) { this.#conversationManager = cm; }

    // ── Lifecycle ────────────────────────────────────────────

    start() {
        try { unlinkSync(TG_UX_SOCK); } catch {}
        this.#expirePendingQuestionsOnBoot().catch(err =>
            log.warn(`Failed to expire pending questions on boot: ${err.message}`)
        );
        this.#server = createNetServer({ allowHalfOpen: true }, (conn) => {
            let buf = "";
            const MAX_BUF = 1024 * 1024; // 1MB safety limit
            conn.on("data", (chunk) => {
                buf += chunk.toString();
                if (buf.length > MAX_BUF) {
                    log.warn("UDS: buffer exceeded 1MB, dropping connection");
                    try { conn.end(JSON.stringify({ error: "Request too large" })); } catch {}
                    buf = "";
                    return;
                }
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
            this.#editResolved(q, "⚠️ Bot restarting");
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
            this.#editResolved(q, "❌ Cancelled");
            this.#resolve(qId, { error: "User cancelled" });
        } else if (value === "__custom__") {
            q.freeText = true;
            this.#editResolved(q, "✏️ Type your answer below:", true);
        } else {
            const idx = parseInt(value, 10);
            const opt = (!isNaN(idx) && q.options?.[idx]) ? q.options[idx] : null;
            const answer = opt?.value ?? value;
            const label = opt?.label ?? answer;
            this.#editResolved(q, `✅ ${label}`);
            this.#resolve(qId, { answer });
        }
        return true;
    }

    /** Try to resolve a pending free-text question for this chat/thread. Returns true if consumed. */
    tryResolveText(chatId, text, threadId = null) {
        for (const [qId, q] of this.#pending) {
            if (String(q.chatId) === String(chatId) && q.freeText) {
                // Strict thread matching: question in a thread only matches that thread
                if (q.threadId && String(q.threadId) !== String(threadId || "")) continue;
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
        for (const [qId, q] of this.#pending) {
            this.#editResolved(q, "❌ Cancelled");
            this.#resolve(qId, { error: reason });
        }
    }

    get hasPending() { return this.#pending.size > 0; }

    // ── Request routing ──────────────────────────────────────

    async #route(method, params, scopeKey) {
        switch (method) {
            case "ask_user":       return this.#askUser(params, scopeKey);
            case "notify_user":    return this.#notifyUser(params, scopeKey);
            case "send_file":      return this.#sendFile(params, scopeKey);
            case "background_task": return this.#backgroundTask(params, scopeKey);
            case "telegram_call":  return this.#telegramCall(params, scopeKey);
            case "send_to_user":   return this.#sendToUser(params);
            default:               return { error: `Unknown method: ${method}` };
        }
    }

    // ── Helpers ──────────────────────────────────────────────

    #resolveChatId(scopeKey) {
        if (scopeKey) {
            const conv = this.#conversationManager?.get(scopeKey);
            if (conv?.ref?.chatId) return { chatId: conv.ref.chatId, threadId: conv.ref.threadId };
        }
        const chatId = this.#config.allowedChatIds?.[0];
        return chatId ? { chatId } : {};
    }

    /** Edit a question message to show the result and remove inline keyboard. */
    #editResolved(q, text, keepKeyboard = false) {
        if (!q?.messageId) return;
        const params = { chat_id: q.chatId, message_id: q.messageId, text };
        if (!keepKeyboard) params.reply_markup = { inline_keyboard: [] };
        this.#telegram.call("editMessageText", params).catch(() => {});
    }

    #resolve(qId, result) {
        const q = this.#pending.get(qId);
        if (!q) return;
        clearTimeout(q.timer);
        this.#pending.delete(qId);
        this.#controlStore?.removePendingQuestion(qId);
        q.resolve(result);
    }

    // ── Method handlers ─────────────────────────────────────

    async #askUser({ message, options }, scopeKey) {
        // Block ask_user for silent and SI conversations
        const conv = this.#conversationManager?.get(scopeKey);
        if (conv?.silent || (scopeKey && scopeKey.startsWith("si:"))) {
            log.info(`ask_user blocked for ${scopeKey}: silent/SI mode`);
            return { answer: "ask_user is not available in background/SI mode. Complete the task autonomously without user input." };
        }
        if (scopeKey && scopeKey.startsWith("webui:")) {
            return { answer: "ask_user is not available in WebUI chat yet. Provide a complete answer without asking for interactive follow-up." };
        }

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

        const sendParams = withThread({
            chat_id: chatId,
            text: `❓ ${message}${!hasButtons ? "\n\nType your answer below:" : ""}`,
            reply_markup: replyMarkup,
            link_preview_options: { is_disabled: true },
        }, threadId);

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const tq = this.#pending.get(qId);
                if (tq) this.#editResolved(tq, "⏰ Question timed out");
                this.#resolve(qId, { error: "Question timed out" });
            }, QUESTION_TIMEOUT_MS);
            const entry = { resolve, chatId, threadId, options: options || [], freeText: !hasButtons, timer };
            this.#pending.set(qId, entry);
            this.#controlStore?.savePendingQuestion({
                id: qId,
                scopeKey,
                chatId,
                threadId,
                message,
                options: options || [],
                freeText: !hasButtons,
                expiresAt: Date.now() + QUESTION_TIMEOUT_MS,
            });

            this.#telegram.call("sendMessage", sendParams)
                .then(sent => {
                    entry.messageId = sent?.message_id;
                    this.#controlStore?.updatePendingQuestionMessageId(qId, entry.messageId);
                })
                .catch(err => {
                    log.warn(`ask_user send failed: ${err.message}`);
                    this.#resolve(qId, { error: `Send failed: ${err.message}` });
                });
        });
    }

    async #expirePendingQuestionsOnBoot() {
        if (!this.#controlStore) return;
        const stale = this.#controlStore.drainPendingQuestions();
        for (const q of stale) {
            if (!q.message_id || !q.chat_id) continue;
            const params = {
                chat_id: q.chat_id,
                message_id: q.message_id,
                text: "⚠️ Bot restarted. This question expired — please retry.",
                reply_markup: { inline_keyboard: [] },
            };
            await this.#telegram.call("editMessageText", params).catch(() => {});
        }
    }

    #notifyUser({ message }, scopeKey) {
        if (!message?.trim()) return Promise.resolve({ error: "message is required" });
        if (scopeKey && scopeKey.startsWith("webui:")) {
            return Promise.resolve({ error: "notify_user is not available in WebUI chat mode" });
        }
        const { chatId, threadId } = this.#resolveChatId(scopeKey);
        if (!chatId) return Promise.resolve({ error: "No chat available" });
        log.info(`notify_user: "${message.substring(0, 80)}"`);
        const params = withThread({
            chat_id: chatId, text: message,
            link_preview_options: { is_disabled: true },
        }, threadId);
        this.#telegram.call("sendMessage", params)
            .catch(err => log.warn(`notify_user failed: ${err.message}`));
        return Promise.resolve({ status: "sent" });
    }

    async #sendFile({ file_path, caption, type = "auto" }, scopeKey) {
        if (!file_path || typeof file_path !== "string") return { error: "file_path is required" };

        // Path jail: only allow files under safe HA directories
        const ALLOWED_PREFIXES = ["/config/", "/share/", "/media/", "/tmp/"];
        const resolved = resolvePath(file_path);
        if (!ALLOWED_PREFIXES.some(p => resolved.startsWith(p))) {
            return { error: `file_path must be under one of: ${ALLOWED_PREFIXES.join(", ")}` };
        }

        const { chatId, threadId } = this.#resolveChatId(scopeKey);
        if (!chatId) return { error: "No chat available" };

        const MIME_MAP = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
            ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain",
            ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
            ".zip": "application/zip", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
            ".log": "text/plain", ".md": "text/markdown",
        };
        const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit

        let buffer;
        try {
            buffer = await readFile(file_path);
        } catch (err) {
            return { error: `Cannot read file: ${err.code || "UNKNOWN"}` };
        }
        if (buffer.length > MAX_FILE_SIZE) {
            return { error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Telegram limit is 50MB.` };
        }

        const filename = basename(file_path);
        const ext = extname(file_path).toLowerCase();
        const mimeType = MIME_MAP[ext] || "application/octet-stream";
        const isPhoto = type === "photo" || (type === "auto" && PHOTO_TYPES.has(mimeType));

        log.info(`send_file: ${filename} (${(buffer.length / 1024).toFixed(1)}KB, ${mimeType}, ${isPhoto ? "photo" : "document"})`);

        try {
            const form = new FormData();
            form.append("chat_id", String(chatId));
            if (threadId) form.append("message_thread_id", String(threadId));
            if (caption) form.append("caption", caption.slice(0, 1024));

            if (isPhoto) {
                form.append("photo", new File([buffer], filename, { type: mimeType }));
                await this.#telegram.callForm("sendPhoto", form);
            } else {
                form.append("document", new File([buffer], filename, { type: mimeType }));
                await this.#telegram.callForm("sendDocument", form);
            }
            return { status: "sent", filename, size: buffer.length };
        } catch (err) {
            return { error: `Send failed: ${err.message}` };
        }
    }

    async #backgroundTask({ prompt, description, groupId, groupSize }, scopeKey) {
        if (!prompt) return { error: "prompt is required" };
        if (!description) return { error: "description is required" };

        const { chatId, threadId } = this.#resolveChatId(scopeKey);
        if (!chatId) return { error: "No chat for result delivery" };

        const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        log.info(`Background task: ${taskId} — "${description}"`);

        const ref = { chatId, chatType: "private", userId: chatId };
        if (threadId) ref.threadId = threadId;
        try {
            // Use user's default model preference for background tasks
            const model = this.#config.defaultModel || "standard";
            await this.#conversationManager.route(`bg:${taskId}`, prompt, ref, { model, mcpProfile: "owner" });
            const result = { taskId, status: "completed" };
            if (groupId) { result.groupId = groupId; result.groupSize = groupSize; }
            return result;
        } catch (err) {
            log.warn(`Background task failed: ${err.message}`);
            return { error: err.message };
        }
    }

    async #telegramCall({ method, params: apiParams }, scopeKey) {
        if (!method || typeof method !== "string") return { error: "method is required" };

        // Allowlist: only safe, intended methods
        const ALLOWED_METHODS = new Set([
            // Messages
            "sendmessage", "editmessagetext", "editmessagereplymarkup",
            "editmessagecaption", "editmessagemedia",
            // Forum topics
            "createforumtopic", "editforumtopic", "closeforumtopic",
            "reopenforumtopic", "deleteforumtopic", "getforumtopiciconstickers",
            // Queries
            "getchat", "getchatmembercount", "getchatmember",
            // Callback
            "answercallbackquery",
            // Files
            "sendphoto", "senddocument", "sendvideo", "sendaudio", "sendvoice",
        ]);
        if (!ALLOWED_METHODS.has(method.toLowerCase())) {
            return { error: `Method '${method}' is not in the allowed list` };
        }

        // Auto-inject message_thread_id for outbound messages when not explicitly set
        const THREAD_METHODS = new Set([
            "sendmessage", "sendphoto", "senddocument", "sendvideo", "sendaudio", "sendvoice",
        ]);
        const merged = { ...(apiParams || {}) };
        if (THREAD_METHODS.has(method.toLowerCase()) && !merged.message_thread_id && scopeKey) {
            const { threadId } = this.#resolveChatId(scopeKey);
            withThread(merged, threadId);
        }

        log.info(`telegram_call: ${method}`);
        try {
            const result = await this.#telegram.call(method, merged);
            return { data: result };
        } catch (err) {
            return { error: err.message };
        }
    }

    async #sendToUser({ target, message }) {
        if (!target) return { error: "target is required" };
        if (!message) return { error: "message is required" };
        if (!this.#rbac) return { error: "RBAC not available — cannot resolve users" };

        let chatId = null;
        let resolvedName = target;

        // 1. Direct numeric ID
        const numericId = parseInt(target);
        if (!isNaN(numericId) && String(numericId) === target.trim()) {
            chatId = numericId;
        }

        // 2. Search paired users by @username or display name
        if (!chatId) {
            const query = target.replace(/^@/, "").toLowerCase();
            const users = this.#rbac.getPairedUsers();
            for (const u of users) {
                const username = (u.username || "").toLowerCase();
                const displayName = (u.displayName || "").toLowerCase();
                if (username === query || displayName === query ||
                    displayName.includes(query) || username.includes(query)) {
                    chatId = u.userId;
                    resolvedName = u.displayName || u.username || String(u.userId);
                    break;
                }
            }
        }

        // 3. Check allowed groups
        if (!chatId && this.#config.allowedGroups?.length) {
            for (const groupId of this.#config.allowedGroups) {
                if (String(groupId) === target.trim()) {
                    chatId = parseInt(groupId);
                    resolvedName = `group ${groupId}`;
                    break;
                }
            }
        }

        if (!chatId) return { error: `Could not resolve "${target}". Use a display name, @username, or numeric chat ID.` };

        log.info(`send_to_user: "${message.substring(0, 80)}" → ${resolvedName} (${chatId})`);
        try {
            await this.#telegram.call("sendMessage", { chat_id: chatId, text: message });
            return { status: "sent", resolvedName, chatId };
        } catch (err) {
            return { error: `Send failed: ${err.message}` };
        }
    }
}
