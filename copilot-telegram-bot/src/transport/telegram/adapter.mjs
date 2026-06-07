// ============================================================
// TelegramAdapter — Telegram-specific update handling
// ============================================================
// Extracted from bridge.mjs (Phase 5). Handles all inbound
// Telegram updates: callback queries, membership changes,
// file attachments, reply context, rate limiting.
//
// The adapter delegates prompt execution and ACP lifecycle
// to the orchestrator (bridge) via purpose-specific methods.

import { handleSlashCommand } from "../../core/commands.mjs";
import { makeRef } from "./transport-ref.mjs";
import { extractCallbackTargetUserId } from "../../ai/copilot/permissions.mjs";
import { createLogger } from "../../logger.mjs";

const log = createLogger("adapter");

const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_MIMES = new Set([
    "text/plain", "text/csv", "text/html", "text/xml", "text/yaml", "text/markdown",
    "application/json", "application/yaml", "application/x-yaml", "application/xml",
    "application/javascript", "application/typescript", "application/toml", "application/x-sh",
]);

const TEXT_EXTENSIONS = new Set([
    ".yaml", ".yml", ".json", ".txt", ".csv", ".log", ".md", ".py", ".js", ".ts",
    ".sh", ".xml", ".toml", ".cfg", ".ini", ".conf", ".env", ".html", ".css",
]);

const TEXT_FILE_MAX_BYTES = 50 * 1024;

export class TelegramAdapter {
    #telegram;
    #orchestrator;  // Bridge instance — for prompt queueing and ACP lifecycle
    #config;
    #pairing;
    #scopeMgr;
    #transport;
    #buttons;
    #statusMenu;
    #pinnedInstructions;
    #userMessageTimes = new Map(); // userId → [timestamps]

    /**
     * @param {object} opts
     * @param {object} opts.telegram - TelegramClient instance
     * @param {object} opts.orchestrator - Bridge instance
     * @param {object} opts.config - Bot config
     * @param {object} opts.pairing - PairingManager or null
     * @param {object} opts.scopeMgr - ScopeManager or null
     * @param {object} opts.transport - MessageTransport instance
     * @param {object} opts.buttons - ButtonManager instance
     * @param {object} opts.statusMenu - StatusMenu instance
     * @param {Map} opts.pinnedInstructions - shared pinned instructions map
     */
    constructor({ telegram, orchestrator, config, pairing, scopeMgr, transport, buttons, statusMenu, pinnedInstructions }) {
        this.#telegram = telegram;
        this.#orchestrator = orchestrator;
        this.#config = config;
        this.#pairing = pairing;
        this.#scopeMgr = scopeMgr;
        this.#transport = transport;
        this.#buttons = buttons;
        this.#statusMenu = statusMenu;
        this.#pinnedInstructions = pinnedInstructions;
    }

    // ── Rate Limiting ──────────────────────────────────────────

    checkRateLimit(userId) {
        const now = Date.now();
        const times = this.#userMessageTimes.get(userId) || [];
        const recent = times.filter((t) => now - t < 60000);
        if (recent.length >= 10) {
            this.#userMessageTimes.set(userId, recent);
            return false;
        }
        recent.push(now);
        this.#userMessageTimes.set(userId, recent);
        return true;
    }

    // ── Reply Context Extraction ───────────────────────────────

    extractReplyContext(message, scope) {
        const reply = message.reply_to_message;
        log.debug(`Reply chain: reply_to_message=${reply ? `msgId=${reply.message_id} from=${reply.from?.username || reply.from?.id}` : "none"}`);
        if (!reply) return "";

        const replyMsgId = reply.message_id;
        const history = scope?.history;

        // Try to walk the chain using scope's history
        const historyChain = history ? history.getReplyChain(replyMsgId, 5, 2000) : [];

        if (historyChain.length > 0) {
            log.debug(`Reply chain from history: ${historyChain.length} messages`);

            if (historyChain.length === 1) {
                const c = historyChain[0];
                const source = c.role === "bot" ? "Replying to bot" : "Replying to user";
                return `[${source}: "${c.text}"]`;
            }

            const formatted = historyChain.map(c => {
                const who = c.role === "bot" ? "🤖" : "👤";
                return `${who} ${c.text}`;
            }).join("\n");
            return `[Reply thread (${historyChain.length} messages):\n${formatted}]`;
        }

        // Fallback: use the immediate reply_to_message from Telegram
        const isBotMsg = reply.from?.is_bot;
        let text = reply.text || reply.caption || "";
        if (!text) {
            if (reply.photo) text = "<photo>";
            else if (reply.sticker) text = `<sticker: ${reply.sticker.emoji || "🎴"}>`;
            else if (reply.voice) text = "<voice message>";
            else if (reply.video) text = "<video>";
            else if (reply.document) text = `<file: ${reply.document.file_name || "document"}>`;
            else text = "<message>";
        }
        if (text.length > 500) text = text.substring(0, 500) + "…";

        const source = isBotMsg ? "Replying to bot" : "Replying to user";
        log.debug(`Reply chain fallback (Telegram only): 1 message`);
        return `[${source}: "${text}"]`;
    }

    // ── File Attachment Handling ────────────────────────────────

    async handleFileAttachment(message) {
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
        const mimeType = message.document?.mime_type || "";

        let textContent = null;
        if (!isImage && buffer.length <= TEXT_FILE_MAX_BYTES) {
            const ext = displayName ? "." + displayName.split(".").pop().toLowerCase() : "";
            if (TEXT_MIMES.has(mimeType) || TEXT_EXTENSIONS.has(ext)) {
                textContent = buffer.toString("utf-8");
            }
        }

        return { buffer, displayName, isImage, mimeType, textContent };
    }

    // ── Membership Changes ─────────────────────────────────────

    async handleMembershipChange(memberUpdate) {
        const chat = memberUpdate.chat;
        if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

        const newStatus = memberUpdate.new_chat_member?.status;
        const oldStatus = memberUpdate.old_chat_member?.status;
        const chatId = chat.id;

        // Bot added to group
        if ((newStatus === "member" || newStatus === "administrator") &&
            (oldStatus === "left" || oldStatus === "kicked" || !oldStatus)) {

            // Whitelist check
            const allowedGroups = this.#config.allowedGroups || [];
            if (allowedGroups.length > 0 && !allowedGroups.includes(String(chatId))) {
                log.info(`Group ${chatId} not in allowed_groups, leaving`);
                await this.#telegram.call("leaveChat", { chat_id: chatId }).catch(() => {});
                return;
            }

            // Size check
            try {
                const count = await this.#telegram.call("getChatMemberCount", { chat_id: chatId });
                const maxMembers = this.#config.maxGroupMembers || 50;
                if (count > maxMembers) {
                    await this.#telegram.sendMessage(
                        chatId,
                        `⚠️ This group has ${count} members (max ${maxMembers}). I can't operate in large groups.`
                    );
                    await this.#telegram.call("leaveChat", { chat_id: chatId }).catch(() => {});
                    return;
                }
            } catch {
                // Ignore count errors.
            }

            // Welcome message
            const isForum = chat.is_forum === true;
            if (isForum) {
                this.#scopeMgr?.setForumChat(chatId);
                await this.#telegram.sendMessage(
                    chatId,
                    "👋 Forum mode activated!\n\n" +
                    "📝 Use /new [title] to create a topic with its own AI session\n" +
                    "📋 Use /sessions to see active topics\n" +
                    "ℹ️ This General topic is for management commands only"
                );
            } else {
                const botUsername = this.#telegram.botInfo?.username || "bot";
                const groupMode = this.#config.groupMode || "mention";
                const promptLine = groupMode === "all"
                    ? "💬 I can respond to messages in this group\n"
                    : `📌 @${botUsername} — mention me to ask a question\n`;
                await this.#telegram.sendMessage(
                    chatId,
                    "👋 Hi! I'm your AI assistant.\n\n" +
                    promptLine +
                    "↩️ Reply to my messages to continue a conversation\n" +
                    "🔐 Only authorized users can interact\n\n" +
                    "⚠️ Responses are visible to all group members."
                );
            }

            log.info(`Bot added to ${isForum ? "forum" : "group"} ${chatId} (${chat.title || "untitled"})`);
        }

        // Bot removed from group
        if ((newStatus === "left" || newStatus === "kicked") &&
            (oldStatus === "member" || oldStatus === "administrator")) {
            log.info(`Bot removed from group ${chatId}`);
            this.#scopeMgr?.deleteByChat(chatId);
            this.#pinnedInstructions?.delete(chatId);
        }
    }

    // ── Pairing Notifications ──────────────────────────────────

    notifyAdminPairingRequest(userId, username, isGroup, sourceChatId) {
        const adminChatId = this.#orchestrator.allowedChatIds[0];
        if (!adminChatId || adminChatId === userId) return;
        const who = username ? `@${username}` : `User ${userId}`;
        const where = isGroup ? ` (from a group)` : ``;
        this.#telegram.enqueue(() =>
            this.#telegram.sendMessage(adminChatId,
                `🔐 Pairing request${where}\n\n` +
                `👤 ${who} (ID: ${userId})\n` +
                `📋 Code is in the add-on logs`
            )
        );
    }

    notifyAdminPairing(userId, username, sourceChatId) {
        const adminChatId = this.#orchestrator.allowedChatIds[0];
        if (!adminChatId || adminChatId === userId) return;
        const who = username ? `@${username}` : `User ${userId}`;
        this.#telegram.enqueue(() =>
            this.#telegram.sendMessage(adminChatId, `✅ ${who} (ID: ${userId}) paired successfully!`)
        );
    }

    // ── Callback Query Handling ────────────────────────────────

    async handleCallbackQuery(query) {
        const chatId = query.message?.chat?.id;
        const userId = query.from?.id;
        const data = query.data;
        if (!chatId || !data) return;

        // Auth check for callbacks
        const isAuthorized = this.#pairing
            ? this.#pairing.isPaired(userId)
            : this.#orchestrator.allowedChatIds.includes(userId);
        if (!isAuthorized) return;

        const targetUserId = extractCallbackTargetUserId(data);
        if (targetUserId != null && targetUserId !== Number(userId)) {
            try {
                await this.#telegram.call("answerCallbackQuery", {
                    callback_query_id: query.id,
                    text: "⚠️ This button is for another user",
                    show_alert: false,
                });
            } catch {}
            return;
        }

        // Try ButtonManager first (handles btn: prefix callbacks)
        if (await this.#buttons.handleCallback(query)) return;

        // Handlers with custom callback answers (must answer before generic fallback)
        if ((data === "changelog" || data.startsWith("changelog:")) && !(this.#config?.changelog?.length)) {
            try {
                await this.#telegram.call("answerCallbackQuery", {
                    callback_query_id: query.id,
                    text: "No changelog available",
                    show_alert: true,
                });
            } catch {}
            return;
        }

        // Generic acknowledge for all other legacy callbacks
        try {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id });
        } catch {}

        // Handle dismiss — delete the message entirely
        if (data === "dismiss") {
            try {
                await this.#telegram.call("deleteMessage", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
            } catch {}
            if (this.#statusMenu.statusMsg?.messageId === query.message.message_id) {
                this.#statusMenu.statusMsg = null;
            }
            return;
        }

        // Handle changelog viewer (empty case already handled above)
        if (data === "changelog" || data.startsWith("changelog:")) {
            const entries = this.#config?.changelog || [];
            const page = data === "changelog" ? 0 : parseInt(data.split(":")[1]) || 0;
            const entry = entries[page];
            if (!entry) return;

            let text = `📋 Changelog — v${entry.version}\n\n`;
            let body = entry.body
                .replace(/^### (.+)/gm, "⸻ $1 ⸻")
                .replace(/^- \*\*(.+?)\*\*:?\s*/gm, "• $1: ")
                .replace(/^- /gm, "• ")
                .replace(/\*\*(.+?)\*\*/g, "$1");
            if (text.length + body.length > 3800) {
                body = body.slice(0, 3800 - text.length) + "\n\n…(truncated)";
            }
            text += body;

            const navButtons = [];
            if (page > 0) {
                navButtons.push({ text: "⬅️ Newer", callback_data: `changelog:${page - 1}` });
            }
            if (page < entries.length - 1) {
                navButtons.push({ text: "Older ➡️", callback_data: `changelog:${page + 1}` });
            }
            const buttons = {
                inline_keyboard: [
                    ...(navButtons.length > 0 ? [navButtons] : []),
                    [
                        { text: "⬅️ Back", callback_data: "status:back" },
                        { text: "✕ Dismiss", callback_data: "dismiss" },
                    ],
                ],
            };
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text,
                    reply_markup: buttons,
                });
            } catch (err) {
                log.error(`Changelog display failed: ${err.message}`);
            }
            return;
        }

        if (data === "status:back") {
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            const scope = this.#orchestrator.buildCommandContext(ref).scope;
            const { text, buttons } = this.#statusMenu.buildContent(scope);
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text,
                    reply_markup: buttons,
                });
                this.#statusMenu.statusMsg = {
                    chatId,
                    messageId: query.message.message_id,
                    createdAt: Date.now(),
                    scopeKey: scope?.key || null,
                };
            } catch (err) {
                log.error(`Status back failed: ${err.message}`);
            }
            return;
        }

        // Handle /status refresh — edit in place instead of sending new
        if (data === "/status") {
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            await this.#orchestrator.showStatusMenu(chatId, this.#orchestrator.buildCommandContext(ref).scope);
            return;
        }

        // If a state-changing command is triggered from the active status menu,
        // immediately show transitional state, execute command, then refresh
        const isFromStatusMenu = this.#statusMenu.statusMsg?.messageId === query.message?.message_id;
        if (isFromStatusMenu && (data === "/session new" || data === "/session stop")) {
            const label = data === "/session new" ? "⏳ Starting a new scope session..." : "⏳ Stopping Copilot...";
            try {
                await this.#telegram.call("editMessageText", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    text: label,
                    reply_markup: { inline_keyboard: [[{ text: "✕ Dismiss", callback_data: "dismiss" }]] },
                });
            } catch {}
            const threadId = query.message?.message_thread_id || null;
            const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
            ref.userId = userId;
            try {
                this.#statusMenu.refreshPaused = true;
                const pauseGuard = setTimeout(() => { this.#statusMenu.refreshPaused = false; }, 60000);
                try {
                    await handleSlashCommand(this.#orchestrator.buildCommandContext(ref), "session", data === "/session new" ? "new" : "stop");
                } finally {
                    clearTimeout(pauseGuard);
                    this.#statusMenu.refreshPaused = false;
                }
            } catch (err) {
                this.#statusMenu.refreshPaused = false;
                log.error(`Status menu action failed: ${err.message}`);
            }
            await this.#statusMenu.refreshIfAlive();
            return;
        }

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
        const ref = makeRef(chatId, threadId, null, query.message?.chat?.type || null);
        ref.userId = userId;

        // Route callback data as slash commands
        const parts = data.split(" ");
        const command = parts[0].replace("/", "");
        const args = parts.slice(1).join(" ");

        await handleSlashCommand(this.#orchestrator.buildCommandContext(ref), command, args);
    }
}
