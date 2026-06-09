// ============================================================
// Menus — Inline keyboard framework for v7 Telegram UX
// ============================================================
// Provides scope-aware inline keyboards with:
// - Edit-in-place updates (no message spam)
// - Auto-expiry (5 minutes)
// - Callback routing by menu ID
// - Builder helpers for common patterns

import { withThread } from "../transport/telegram/thread.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("menus");
const MENU_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export class MenuManager {
    #telegram;
    #activeMenus = new Map(); // menuKey → { chatId, messageId, handler, timer }

    constructor({ telegram }) {
        this.#telegram = telegram;
    }

    /**
     * Send or update a menu.
     * @param {string} chatId
     * @param {string} menuId — unique identifier for this menu instance
     * @param {string} text — message text (HTML)
     * @param {Array} keyboard — array of button rows
     * @param {object} opts — { messageId?: update existing, threadId? }
     * @returns {number} messageId of the sent/updated message
     */
    async show(chatId, menuId, text, keyboard, opts = {}) {
        const replyMarkup = { inline_keyboard: keyboard };
        // Include threadId in key so menus in different threads don't collide
        const threadSuffix = opts.threadId ? `:${opts.threadId}` : "";
        const menuKey = `${chatId}:${menuId}${threadSuffix}`;

        // If we already have this menu open, edit in place
        const existing = this.#activeMenus.get(menuKey);
        if (existing?.messageId || opts.messageId) {
            const msgId = opts.messageId || existing.messageId;
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: msgId,
                    text,
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                });
                this.#track(menuKey, chatId, msgId);
                return msgId;
            } catch (err) {
                // Message might be deleted or unchanged — send new
                if (!err.message?.includes("message is not modified")) {
                    log.debug(`Edit failed, sending new: ${err.message}`);
                }
            }
        }

        // Send new message
        const params = withThread({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
        }, opts.threadId);

        const sent = await this.#telegram.call("sendMessage", params);
        this.#track(menuKey, chatId, sent.message_id);
        return sent.message_id;
    }

    /**
     * Close a menu (remove buttons, optionally update text).
     */
    async close(chatId, menuId, finalText, opts = {}) {
        const threadSuffix = opts.threadId ? `:${opts.threadId}` : "";
        const menuKey = `${chatId}:${menuId}${threadSuffix}`;
        const existing = this.#activeMenus.get(menuKey);
        if (!existing) return;

        try {
            if (finalText) {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: existing.messageId,
                    text: finalText,
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] },
                });
            } else {
                await this.#telegram.call("editMessageReplyMarkup", {
                    chat_id: chatId,
                    message_id: existing.messageId,
                    reply_markup: { inline_keyboard: [] },
                });
            }
        } catch {}

        this.#cleanup(menuKey);
    }

    /**
     * Check if a callback belongs to an active menu.
     */
    isMenuCallback(data) {
        return data.includes(":menu:");
    }

    #track(menuKey, chatId, messageId) {
        const existing = this.#activeMenus.get(menuKey);
        if (existing?.timer) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            // Extract menuId from key (chatId:menuId or chatId:menuId:threadId)
            const parts = menuKey.split(":");
            const menuId = parts.slice(1).join(":");
            this.close(chatId, menuId, "⏰ Menu expired. Use the command again to reopen.").catch(() => {});
        }, MENU_EXPIRY_MS);

        this.#activeMenus.set(menuKey, { chatId, messageId, timer });
    }

    #cleanup(menuKey) {
        const existing = this.#activeMenus.get(menuKey);
        if (existing?.timer) clearTimeout(existing.timer);
        this.#activeMenus.delete(menuKey);
    }

    /** Cleanup all menus on shutdown. */
    stop() {
        for (const [key, { timer }] of this.#activeMenus) {
            if (timer) clearTimeout(timer);
        }
        this.#activeMenus.clear();
    }
}

// ── Button Builders ──────────────────────────────────────────

/**
 * Build a callback data string.
 * Format: {scopePrefix}:menu:{menuName}:{action}
 */
export function menuCallback(scopePrefix, menuName, action) {
    return `${scopePrefix}:menu:${menuName}:${action}`;
}

/**
 * Parse a menu callback data string.
 * Returns { scopeKey, menuName, action } or null.
 */
export function parseMenuCallback(data) {
    const parts = data.split(":menu:");
    if (parts.length !== 2) return null;

    const scopePrefix = parts[0];
    const [menuName, ...actionParts] = parts[1].split(":");
    const action = actionParts.join(":");

    // Reconstruct scopeKey from prefix
    let scopeKey;
    const scopeParts = scopePrefix.split(":");
    if (scopeParts[0] === "dm") {
        scopeKey = scopeParts.length >= 3
            ? `dm:${scopeParts[1]}:${scopeParts[2]}`
            : `dm:${scopeParts[1]}`;
    }
    else if (scopeParts[0] === "group") scopeKey = `group:${scopeParts[1]}:${scopeParts[2]}`;
    else if (scopeParts[0] === "forum") scopeKey = `forum:${scopeParts[1]}:${scopeParts[2]}`;
    else scopeKey = scopePrefix;

    return { scopeKey, menuName, action };
}

/**
 * Build a button row.
 */
export function row(...buttons) {
    return buttons;
}

/**
 * Build a single button.
 */
export function btn(text, callbackData) {
    return { text, callback_data: callbackData };
}
