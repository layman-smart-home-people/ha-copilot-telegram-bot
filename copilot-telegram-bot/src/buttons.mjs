// ============================================================
// ButtonMenu — Reusable Inline Keyboard Framework
// ============================================================
// Provides one-shot inline buttons with auto-cleanup, timeout,
// and structured callback payloads.

const TIMEOUT_MS = 60_000;
const MAX_MENU_AGE_MS = 10 * 60 * 1000; // 10 minutes — sweep abandoned menus
const SWEEP_INTERVAL_MS = 60 * 1000;    // check every minute

export class ButtonManager {
    #telegram;
    #pending = new Map(); // menuId → { chatId, messageId, resolve, timer, consumed, createdAt }
    #sweepTimer = null;

    constructor(telegram) {
        this.#telegram = telegram;
        // Periodic sweep for abandoned zero-timeout menus
        this.#sweepTimer = setInterval(() => this.#sweepStale(), SWEEP_INTERVAL_MS);
        if (this.#sweepTimer.unref) this.#sweepTimer.unref(); // don't block process exit
    }

    /** Stop the sweep timer (call on shutdown). */
    destroy() {
        if (this.#sweepTimer) {
            clearInterval(this.#sweepTimer);
            this.#sweepTimer = null;
        }
    }

    #sweepStale() {
        const now = Date.now();
        for (const [menuId, menu] of this.#pending) {
            if (!menu.timer && (now - menu.createdAt) > MAX_MENU_AGE_MS) {
                this.#expire(menuId, "⏰ Question expired");
            }
        }
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
        const timeout = opts.timeout ?? opts.timeoutMs ?? TIMEOUT_MS;

        // Build inline keyboard with callback payloads
        const inline_keyboard = buttons.map(row =>
            row.map(btn => ({
                text: btn.text,
                callback_data: `btn:${menuId}:${btn.value}`,
            }))
        );

        // Send via raw API call so reply_to_message_id is a top-level param
        const apiParams = {
            chat_id: chatId,
            text,
            reply_markup: { inline_keyboard },
            link_preview_options: { is_disabled: true },
        };
        if (opts.parseMode) apiParams.parse_mode = opts.parseMode;
        if (opts.reply_to_message_id) apiParams.reply_to_message_id = opts.reply_to_message_id;
        const sent = await this.#telegram.call("sendMessage", apiParams);
        const messageId = sent?.message_id;
        if (!messageId) return { value: null, messageId: null };

        const value = await new Promise((resolve) => {
            // timeout=0 means no timeout (buttons persist until clicked or swept)
            const timer = timeout > 0
                ? setTimeout(() => { this.#expire(menuId, opts.timeoutText); }, timeout)
                : null;

            this.#pending.set(menuId, {
                chatId,
                messageId,
                resolve,
                timer,
                consumed: false,
                createdAt: Date.now(),
            });
        });

        return { value, messageId, menuId };
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
                createdAt: Date.now(),
            });
        });

        return { value, messageId };
    }

    /**
     * Handle a callback_query. Returns true if handled (consumed).
     */
    async handleCallback(query) {
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

        // Clear buttons from the message — await to prevent race with finalize()
        try {
            await this.#telegram.call("editMessageReplyMarkup", {
                chat_id: menu.chatId,
                message_id: menu.messageId,
                reply_markup: { inline_keyboard: [] },
            });
        } catch (err) {
            // Non-fatal: finalize() will also clear buttons
        }

        menu.resolve(value);
        return true;
    }

    /**
     * Update the button message to show final state (clears buttons).
     * Throws on failure so callers can handle/log errors.
     */
    async finalize(chatId, messageId, text, parseMode) {
        await this.#telegram.call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: parseMode || undefined,
            reply_markup: { inline_keyboard: [] },
        });
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

    /**
     * Cancel a specific menu by its menuId.
     */
    cancelMenu(menuId, text) {
        if (menuId) this.#expire(menuId, text || "Dismissed");
    }

    /**
     * Cancel all pending menus for a specific chat.
     */
    cancelForChat(chatId, text) {
        for (const [menuId, menu] of this.#pending) {
            if (menu.chatId === chatId) {
                this.#expire(menuId, text || "Dismissed");
            }
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
