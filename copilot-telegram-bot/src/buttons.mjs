// ============================================================
// ButtonMenu — Reusable Inline Keyboard Framework
// ============================================================
// Provides one-shot inline buttons with auto-cleanup, timeout,
// and structured callback payloads.

const TIMEOUT_MS = 60_000;

export class ButtonManager {
    #telegram;
    #pending = new Map(); // menuId → { chatId, messageId, resolve, timer, consumed }

    constructor(telegram) {
        this.#telegram = telegram;
    }

    /**
     * Send a message with inline buttons and await the user's selection.
     * Returns the selected value or null on timeout/cancellation.
     *
     * @param {number} chatId
     * @param {string} text - Message text
     * @param {Array<Array<{text: string, value: string}>>} buttons - 2D array of button rows
     * @param {object} opts - { timeout, onTimeout }
     * @returns {Promise<string|null>} Selected value or null
     */
    async prompt(chatId, text, buttons, opts = {}) {
        const menuId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timeout = opts.timeout || opts.timeoutMs || TIMEOUT_MS;

        // Build inline keyboard with callback payloads
        const inline_keyboard = buttons.map(row =>
            row.map(btn => ({
                text: btn.text,
                callback_data: `btn:${menuId}:${btn.value}`,
            }))
        );

        // Send the message
        const sent = await this.#telegram.sendMessage(
            chatId, text, undefined, { inline_keyboard }
        );
        const messageId = sent?.message_id;
        if (!messageId) return { value: null, messageId: null };

        const value = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.#expire(menuId, opts.timeoutText);
            }, timeout);

            this.#pending.set(menuId, {
                chatId,
                messageId,
                resolve,
                timer,
                consumed: false,
            });
        });

        return { value, messageId };
    }

    /**
     * Send buttons that update an existing message (edit in-place).
     * Returns the selected value or null on timeout.
     */
    async promptEdit(chatId, messageId, text, buttons, opts = {}) {
        const menuId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timeout = opts.timeout || TIMEOUT_MS;

        const inline_keyboard = buttons.map(row =>
            row.map(btn => ({
                text: btn.text,
                callback_data: `btn:${menuId}:${btn.value}`,
            }))
        );

        // Edit the message with new text and buttons
        await this.#telegram.call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text,
            reply_markup: { inline_keyboard },
        });

        const value = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.#expire(menuId, opts.timeoutText);
            }, timeout);

            this.#pending.set(menuId, {
                chatId,
                messageId,
                resolve,
                timer,
                consumed: false,
            });
        });

        return { value, messageId };
    }

    /**
     * Handle a callback_query. Returns true if handled (consumed).
     */
    handleCallback(query) {
        const data = query.data;
        if (!data?.startsWith("btn:")) return false;

        const parts = data.split(":");
        if (parts.length < 3) return false;
        const menuId = parts[1];
        const value = parts.slice(2).join(":");

        const menu = this.#pending.get(menuId);
        if (!menu || menu.consumed) {
            // Stale button — acknowledge silently
            this.#telegram.call("answerCallbackQuery", {
                callback_query_id: query.id,
                text: "⏰ This menu has expired",
                show_alert: false,
            }).catch(() => {});
            return true;
        }

        // Consume
        menu.consumed = true;
        clearTimeout(menu.timer);
        this.#pending.delete(menuId);

        // Acknowledge button press
        this.#telegram.call("answerCallbackQuery", {
            callback_query_id: query.id,
        }).catch(() => {});

        // Clear buttons from the message
        this.#telegram.call("editMessageReplyMarkup", {
            chat_id: menu.chatId,
            message_id: menu.messageId,
            reply_markup: { inline_keyboard: [] },
        }).catch(() => {});

        menu.resolve(value);
        return true;
    }

    /**
     * Update the button message to show final state (clears buttons).
     */
    async finalize(chatId, messageId, text, parseMode) {
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: parseMode || undefined,
                reply_markup: { inline_keyboard: [] },
            });
        } catch (err) {
            // Log finalize failures for debugging
            console.error(`[Buttons] finalize error: ${err.message} (chat=${chatId}, msg=${messageId})`);
        }
    }

    /**
     * Get the message_id of the last sent prompt for a given menu.
     * Useful for finalizing after prompt() resolves.
     */
    getMessageId(chatId) {
        for (const [, menu] of this.#pending) {
            if (menu.chatId === chatId && !menu.consumed) {
                return menu.messageId;
            }
        }
        return null;
    }

    /**
     * Cancel all pending menus (e.g., on session restart).
     */
    cancelAll() {
        for (const [menuId] of this.#pending) {
            this.#expire(menuId, "Session ended");
        }
    }

    #expire(menuId, text) {
        const menu = this.#pending.get(menuId);
        if (!menu || menu.consumed) return;

        menu.consumed = true;
        clearTimeout(menu.timer);
        this.#pending.delete(menuId);

        // Clear buttons with timeout message
        this.#telegram.call("editMessageText", {
            chat_id: menu.chatId,
            message_id: menu.messageId,
            text: text || "⏰ Menu expired",
            reply_markup: { inline_keyboard: [] },
        }).catch(() => {});

        menu.resolve(null);
    }
}
