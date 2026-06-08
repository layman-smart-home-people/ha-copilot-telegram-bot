// ============================================================
// Router — Message routing for v7 architecture
// ============================================================
// Responsibilities:
// 1. Parse Telegram update → build ref (chatId, userId, threadId, chatType)
// 2. Check permissions (role gate)
// 3. Handle commands (/stop, /new, /help, /status)
// 4. Resolve scope key
// 5. Route to ConversationManager

import { createLogger } from "../logger.mjs";
import { PromptEnricher } from "./prompt-enricher.mjs";

const log = createLogger("router");

// Commands handled by the router
const COMMANDS = new Map([
    ["stop", "Cancel current operation"],
    ["new", "Start fresh conversation"],
    ["help", "Show available commands"],
    ["status", "Show bot & pool status"],
    ["settings", "Configure bot settings"],
    ["standing", "Manage standing instructions"],
    ["memory", "Memory & knowledge base"],
]);

export class Router {
    #telegram;
    #conversationManager;
    #pool;
    #permissions;
    #config;
    #enricher;
    #handlers = new Map(); // command → handler function

    constructor({ telegram, conversationManager, pool, permissions, config }) {
        this.#telegram = telegram;
        this.#conversationManager = conversationManager;
        this.#pool = pool;
        this.#permissions = permissions;
        this.#config = config;
        this.#enricher = new PromptEnricher({ config, permissions });

        // Register built-in command handlers
        this.#handlers.set("stop", (ref) => this.#cmdStop(ref));
        this.#handlers.set("new", (ref) => this.#cmdNew(ref));
        this.#handlers.set("help", (ref) => this.#cmdHelp(ref));
        this.#handlers.set("status", (ref) => this.#cmdStatus(ref));
        this.#handlers.set("settings", (ref) => this.#cmdStub(ref, "settings"));
        this.#handlers.set("standing", (ref) => this.#cmdStub(ref, "standing"));
        this.#handlers.set("memory", (ref) => this.#cmdStub(ref, "memory"));
    }

    #updateListener = null;

    /** Start listening to Telegram updates. */
    start() {
        this.#updateListener = (update) => this.#handleUpdate(update);
        this.#telegram.on("update", this.#updateListener);
        log.info("Router listening for updates");
    }

    /** Stop listening (cleanup). */
    stop() {
        if (this.#updateListener) {
            this.#telegram.off("update", this.#updateListener);
            this.#updateListener = null;
        }
    }

    // ── Update Handling ──────────────────────────────────────

    async #handleUpdate(update) {
        // Only handle message updates (text, photo, etc.)
        const msg = update.message || update.edited_message;
        if (!msg) {
            // Handle callback queries (buttons)
            if (update.callback_query) {
                await this.#handleCallback(update.callback_query);
            }
            return;
        }

        // Handle pinned message — store as context (only from allowed users)
        if (msg.pinned_message) {
            const pinnerId = msg.from?.id;
            if (pinnerId && this.#permissions.isAllowed(pinnerId)) {
                const pinnedText = msg.pinned_message.text || msg.pinned_message.caption;
                if (pinnedText) {
                    this.#enricher.setPinned(msg.chat.id, pinnedText);
                    log.debug(`Pinned instruction set for chat ${msg.chat.id} by ${pinnerId}`);
                }
            }
            return;
        }

        // Build ref from message
        const ref = this.#buildRef(msg);
        if (!ref) return;

        // Permission check
        if (!this.#permissions.isAllowed(ref.userId)) {
            log.debug(`Blocked message from unknown user ${ref.userId}`);
            return;
        }

        // Extract text
        const text = msg.text || msg.caption || "";
        if (!text) return; // Skip non-text for now (photos handled later)

        // Command dispatch
        if (text.startsWith("/")) {
            const handled = await this.#dispatchCommand(text, ref);
            if (handled) return;
        }

        // Resolve scope key
        const scopeKey = this.#resolveScopeKey(ref);

        // Get role-based config
        const model = this.#permissions.getModelTier(ref.userId, this.#config);
        const mcpProfile = this.#permissions.getMcpProfile(ref.userId);

        // Check if conversation already exists (determines if first message)
        const existingConv = this.#conversationManager.get(scopeKey);
        const isFirstMessage = !existingConv || existingConv.state === "dead";

        // Enrich text with context prefix
        const enrichedText = this.#enricher.enrich(text, ref, { isFirstMessage });

        // Route to conversation manager
        try {
            await this.#conversationManager.route(scopeKey, enrichedText, ref, {
                messageId: msg.message_id,
                model,
                mcpProfile,
            });
        } catch (err) {
            log.error(`Route error for ${scopeKey}: ${err.message}`);
            const errMsg = err.name === "PoolExhaustedError"
                ? "⏳ All instances busy. Try again in a moment."
                : `⚠️ ${err.message}`;
            await this.#telegram.sendMessage(ref.chatId, errMsg).catch(() => {});
        }
    }

    // ── Ref Building ─────────────────────────────────────────

    #buildRef(msg) {
        const chatId = msg.chat?.id;
        const userId = msg.from?.id;
        if (!chatId || !userId) return null;

        const chatType = msg.chat?.type || "private"; // private, group, supergroup
        const threadId = msg.message_thread_id || null;
        const isForum = msg.chat?.is_forum || false;

        // Check if replying to bot message
        let replyToText = null;
        if (msg.reply_to_message?.from?.is_bot) {
            replyToText = msg.reply_to_message.text || msg.reply_to_message.caption || null;
        }

        return {
            chatId,
            userId,
            chatType,
            threadId,
            isForum,
            messageId: msg.message_id,
            username: msg.from?.username,
            firstName: msg.from?.first_name,
            replyToText,
        };
    }

    // ── Scope Resolution ─────────────────────────────────────

    #resolveScopeKey(ref) {
        // Forum: scope per topic (thread)
        if (ref.isForum && ref.threadId) {
            return `forum:${ref.chatId}:${ref.threadId}`;
        }
        // Group: scope per user within group
        if (ref.chatType === "group" || ref.chatType === "supergroup") {
            return `group:${ref.chatId}:${ref.userId}`;
        }
        // DM: scope per user
        return `dm:${ref.userId}`;
    }

    // ── Command Dispatch ─────────────────────────────────────

    async #dispatchCommand(text, ref) {
        // Parse: /command@botname args
        const match = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)?$/s);
        if (!match) return false;

        const cmd = match[1].toLowerCase();
        const handler = this.#handlers.get(cmd);
        if (!handler) return false;

        try {
            await handler(ref, match[2]?.trim());
        } catch (err) {
            log.error(`Command /${cmd} error: ${err.message}`);
        }
        return true;
    }

    // ── Command Handlers ─────────────────────────────────────

    async #cmdStop(ref) {
        const scopeKey = this.#resolveScopeKey(ref);
        const conv = this.#conversationManager.get(scopeKey);

        if (conv && conv.state === "prompting") {
            // Cancel the in-flight prompt
            try {
                await conv.receive("/stop");
                await this.#telegram.sendMessage(ref.chatId, "⏹️ Stopped.");
            } catch {
                await this.#telegram.sendMessage(ref.chatId, "⏹️ Nothing to stop.");
            }
        } else {
            await this.#telegram.sendMessage(ref.chatId, "⏹️ Nothing running.");
        }
    }

    async #cmdNew(ref) {
        const scopeKey = this.#resolveScopeKey(ref);
        const destroyed = await this.#conversationManager.destroy(scopeKey);

        if (destroyed) {
            await this.#telegram.sendMessage(ref.chatId, "🆕 Fresh conversation started.");
        } else {
            await this.#telegram.sendMessage(ref.chatId, "🆕 Ready for new conversation.");
        }
    }

    async #cmdHelp(ref) {
        const lines = ["<b>📋 Commands</b>\n"];
        for (const [cmd, desc] of COMMANDS) {
            lines.push(`/${cmd} — ${desc}`);
        }
        lines.push("\nSend any message to chat with Copilot.");
        await this.#telegram.sendMessage(ref.chatId, lines.join("\n"), "HTML");
    }

    async #cmdStatus(ref) {
        const poolStatus = this.#pool.status();
        const convos = this.#conversationManager.list();
        const metrics = this.#pool.getMetrics();

        const lines = [
            "<b>📊 Ezra v7 Status</b>\n",
            `<b>🤖 Pool</b>`,
            `  ${poolStatus.claimed} active · ${poolStatus.idle} idle · ${poolStatus.booting} booting (max ${poolStatus.maxSize})`,
        ];

        if (poolStatus.instances.length > 0) {
            for (const inst of poolStatus.instances) {
                const icon = inst.state === "claimed" ? "⚡" : inst.state === "idle" ? "💤" : "🔄";
                const model = inst.model === "fast" ? "⚡H" : inst.model === "reasoning" ? "🧠O" : "🔵S";
                const claim = inst.claimedBy ? ` → ${inst.claimedBy}` : "";
                lines.push(`  ${icon} ${inst.id} [${model}]${claim}`);
            }
        }

        lines.push(`\n<b>💬 Conversations</b> (${convos.length})`);
        if (convos.length > 0) {
            for (const c of convos.slice(0, 8)) {
                const icon = c.state === "prompting" ? "⚡" : c.state === "eliciting" ? "❓" : "💤";
                lines.push(`  ${icon} ${c.scopeKey} · ${c.model} · ${c.promptCount} prompts`);
            }
            if (convos.length > 8) lines.push(`  ...+${convos.length - 8} more`);
        }

        // SI conversations
        const siConvos = convos.filter(c => c.scopeKey.startsWith("si:"));
        if (siConvos.length > 0) {
            lines.push(`\n<b>🤖 SI Active</b> (${siConvos.length})`);
        }

        // Metrics
        lines.push(`\n<b>📈 Metrics</b>`);
        lines.push(`  ${metrics.totalPrompts} prompts · ${(metrics.totalMs / 1000).toFixed(1)}s total`);
        if (metrics.totalCrashes > 0) lines.push(`  ⚠️ ${metrics.totalCrashes} crashes`);

        if (poolStatus.waitQueueLength > 0) {
            lines.push(`\n⏳ Wait queue: ${poolStatus.waitQueueLength}`);
        }

        await this.#telegram.sendMessage(ref.chatId, lines.join("\n"), "HTML");
    }

    async #cmdStub(ref, name) {
        await this.#telegram.sendMessage(ref.chatId, `🚧 /${name} — coming in Phase 4`);
    }

    // ── Callback Handling ────────────────────────────────────

    async #handleCallback(query) {
        const data = query.data;
        const userId = query.from?.id;
        const chatId = query.message?.chat?.id;

        if (!data || !userId || !chatId) return;

        // Acknowledge the callback immediately
        await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});

        // Parse scope-encoded callback: "scope:action:payload"
        // e.g., "dm:430432097:elicit:accept" or "dm:430432097:elicit:decline"
        const parts = data.split(":");
        if (parts.length < 3) {
            log.debug(`Ignoring unrecognized callback: ${data}`);
            return;
        }

        // Reconstruct scope key and action
        let scopeKey, action, payload;
        if (parts[0] === "dm") {
            scopeKey = `dm:${parts[1]}`;
            action = parts[2];
            payload = parts.slice(3).join(":");
        } else if (parts[0] === "group") {
            scopeKey = `group:${parts[1]}:${parts[2]}`;
            action = parts[3];
            payload = parts.slice(4).join(":");
        } else if (parts[0] === "forum") {
            scopeKey = `forum:${parts[1]}:${parts[2]}`;
            action = parts[3];
            payload = parts.slice(4).join(":");
        } else {
            log.debug(`Unknown scope type in callback: ${data}`);
            return;
        }

        const conv = this.#conversationManager.get(scopeKey);
        if (!conv) {
            // Stale button — conversation was reaped
            await this.#telegram.call("answerCallbackQuery", {
                callback_query_id: query.id,
                text: "⌛ Conversation ended. Send a new message.",
                show_alert: true,
            }).catch(() => {});
            return;
        }

        // Auth check: only the conversation owner or bot owner can interact
        const convOwner = conv.ref?.userId;
        if (convOwner && userId !== convOwner && !this.#permissions.isOwner(userId)) {
            await this.#telegram.call("answerCallbackQuery", {
                callback_query_id: query.id,
                text: "⛔ Not your conversation.",
                show_alert: true,
            }).catch(() => {});
            return;
        }

        // Route by action type
        switch (action) {
            case "elicit":
                await conv.respondElicitation(payload === "decline" ? "decline" : "accept");
                break;
            default:
                log.debug(`Unknown callback action: ${action}`);
        }
    }
}
