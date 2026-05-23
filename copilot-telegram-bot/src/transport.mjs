// ============================================================
// MessageTransport — Outbound message routing via ConversationRef
// ============================================================
// Wraps TelegramClient to route all outbound messages through
// ConversationRef(chatId, threadId). Prepares for future streaming
// via sendMessageDraft.

/**
 * @typedef {Object} ConversationRef
 * @property {number} chatId       - Telegram chat ID
 * @property {number|null} threadId - message_thread_id (null = private chat or General)
 * @property {string|null} sessionId - ACP session ID (null = not yet created)
 */

/**
 * Create a ConversationRef.
 * @param {number} chatId
 * @param {number|null} [threadId=null]
 * @param {string|null} [sessionId=null]
 * @returns {ConversationRef}
 */
export function makeRef(chatId, threadId = null, sessionId = null) {
    return { chatId, threadId, sessionId };
}

/**
 * Unique string key for a ConversationRef (for Map lookups).
 */
export function refKey(ref) {
    return `${ref.chatId}:${ref.threadId ?? "main"}`;
}

export class MessageTransport {
    #telegram;

    constructor(telegram) {
        this.#telegram = telegram;
    }

    get telegram() { return this.#telegram; }

    /**
     * Send a text message to a ConversationRef.
     */
    send(ref, text, parseMode, replyMarkup) {
        const params = { chat_id: ref.chatId, text };
        if (ref.threadId) params.message_thread_id = ref.threadId;
        if (parseMode) params.parse_mode = parseMode;
        if (replyMarkup) params.reply_markup = replyMarkup;
        return this.#telegram.call("sendMessage", params);
    }

    /**
     * Enqueue a send (rate-limited).
     */
    enqueueSend(ref, text, parseMode, replyMarkup) {
        return this.#telegram.enqueue(() => this.send(ref, text, parseMode, replyMarkup));
    }

    /**
     * Send a chat action (typing indicator) to a ConversationRef.
     */
    sendChatAction(ref, action = "typing") {
        const params = { chat_id: ref.chatId, action };
        if (ref.threadId) params.message_thread_id = ref.threadId;
        return this.#telegram.call("sendChatAction", params);
    }

    /**
     * Set message reaction.
     */
    setReaction(ref, messageId, emoji) {
        return this.#telegram.setMessageReaction(ref.chatId, messageId, emoji);
    }

    /**
     * Send a photo to a ConversationRef.
     */
    async sendPhoto(ref, buffer, mimeType, caption) {
        const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : "png";
        const form = new FormData();
        form.append("chat_id", String(ref.chatId));
        if (ref.threadId) form.append("message_thread_id", String(ref.threadId));
        form.append("photo", new File([buffer], `image.${ext}`, { type: mimeType }));
        if (caption) form.append("caption", caption.slice(0, 1024));
        return this.#telegram.callForm("sendPhoto", form);
    }

    /**
     * Send a document to a ConversationRef.
     */
    async sendDocument(ref, buffer, mimeType, filename, caption) {
        const form = new FormData();
        form.append("chat_id", String(ref.chatId));
        if (ref.threadId) form.append("message_thread_id", String(ref.threadId));
        form.append("document", new File([buffer], filename || "file", { type: mimeType }));
        if (caption) form.append("caption", caption.slice(0, 1024));
        return this.#telegram.callForm("sendDocument", form);
    }

    /**
     * Edit a message's reply markup (for button cleanup).
     */
    editReplyMarkup(ref, messageId, replyMarkup) {
        return this.#telegram.call("editMessageReplyMarkup", {
            chat_id: ref.chatId,
            message_id: messageId,
            reply_markup: replyMarkup,
        });
    }

    /**
     * Edit message text.
     */
    editMessageText(ref, messageId, text, parseMode) {
        const params = { chat_id: ref.chatId, message_id: messageId, text };
        if (parseMode) params.parse_mode = parseMode;
        return this.#telegram.call("editMessageText", params);
    }

    /**
     * Delete a message.
     */
    deleteMessage(ref, messageId) {
        return this.#telegram.call("deleteMessage", {
            chat_id: ref.chatId,
            message_id: messageId,
        });
    }

    /**
     * Answer a callback query.
     */
    answerCallback(callbackQueryId, text) {
        return this.#telegram.call("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text,
        });
    }

    // --- Forum Topic Management ---

    /**
     * Create a forum topic.
     */
    createForumTopic(chatId, name, iconColor) {
        const params = { chat_id: chatId, name };
        if (iconColor) params.icon_color = iconColor;
        return this.#telegram.call("createForumTopic", params);
    }

    /**
     * Close a forum topic.
     */
    closeForumTopic(chatId, threadId) {
        return this.#telegram.call("closeForumTopic", {
            chat_id: chatId,
            message_thread_id: threadId,
        });
    }

    /**
     * Reopen a forum topic.
     */
    reopenForumTopic(chatId, threadId) {
        return this.#telegram.call("reopenForumTopic", {
            chat_id: chatId,
            message_thread_id: threadId,
        });
    }

    /**
     * Delete a forum topic.
     */
    deleteForumTopic(chatId, threadId) {
        return this.#telegram.call("deleteForumTopic", {
            chat_id: chatId,
            message_thread_id: threadId,
        });
    }
}
