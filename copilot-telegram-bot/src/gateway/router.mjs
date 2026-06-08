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
import { FileHandler } from "./file-handler.mjs";
import { MenuManager, menuCallback, parseMenuCallback, row, btn } from "./menus.mjs";

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
    #fileHandler;
    #menus;
    #siOrchestrator = null; // set externally after boot
    #topicManager = null;   // set externally after boot

    constructor({ telegram, conversationManager, pool, permissions, config, enricher }) {
        this.#telegram = telegram;
        this.#conversationManager = conversationManager;
        this.#pool = pool;
        this.#permissions = permissions;
        this.#config = config;
        this.#enricher = enricher || new PromptEnricher({ config, permissions });
        this.#fileHandler = new FileHandler({ telegram });
        this.#menus = new MenuManager({ telegram });

        // Register built-in command handlers
        this.#handlers.set("stop", (ref) => this.#cmdStop(ref));
        this.#handlers.set("new", (ref) => this.#cmdNew(ref));
        this.#handlers.set("help", (ref) => this.#cmdHelp(ref));
        this.#handlers.set("status", (ref) => this.#cmdStatus(ref));
        this.#handlers.set("settings", (ref) => this.#cmdSettings(ref));
        this.#handlers.set("standing", (ref) => this.#cmdStanding(ref));
        this.#handlers.set("memory", (ref) => this.#cmdMemory(ref));
    }

    /** Set SI orchestrator reference (called after boot). */
    setSIOrchestrator(orch) { this.#siOrchestrator = orch; }

    /** Set TopicManager reference (called after boot). */
    setTopicManager(mgr) { this.#topicManager = mgr; }

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
        this.#menus.stop();
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

        // Group mention gate: in groups (non-forum), only respond if mentioned/replied/command
        if (this.#shouldIgnoreInGroup(msg, ref)) {
            return;
        }

        // DM topic lobby gate: when topics are enabled, root messages (no threadId)
        // get redirected — only commands pass through
        if (this.#isDmLobbyMessage(msg, ref)) {
            const text = msg.text || msg.caption || "";
            // Allow commands in the lobby
            if (text.startsWith("/")) {
                // Fall through to normal processing
            } else {
                await this.#handleLobbyMessage(ref);
                return;
            }
        }

        // Extract text (with file attachment handling)
        let text = msg.text || msg.caption || "";

        // Handle file attachments if no text or has media
        if (!text || msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.sticker || msg.contact || msg.location || msg.animation || msg.video_note) {
            const fileResult = await this.#fileHandler.process(msg);
            if (fileResult.rejection) {
                await this.#reply(ref, fileResult.rejection).catch(() => {});
                return;
            }
            if (fileResult.text) {
                text = text ? `${text}\n\n${fileResult.text}` : fileResult.text;
            }
        }

        if (!text) return;

        // Strip @botname from text
        const botUsername = this.#telegram.botInfo?.username;
        if (botUsername) {
            text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
        }

        // Command dispatch
        if (text.startsWith("/")) {
            const handled = await this.#dispatchCommand(text, ref);
            if (handled) return;
        }

        // Resolve scope key
        const scopeKey = this.#resolveScopeKey(ref);

        // Progress query interception — if the agent is busy and user asks for progress,
        // show status instead of steering (which would cancel the current operation)
        const existingConv = this.#conversationManager.get(scopeKey);
        if (existingConv?.state === "prompting" && this.#isProgressQuery(text)) {
            const progress = existingConv.streamer?.getProgress();
            if (progress) {
                const lines = [`⏳ <b>Agent is working</b> (${progress.elapsedSec}s)`];
                if (progress.toolsRunning.length > 0) {
                    lines.push(`🔧 ${progress.toolsRunning.join(", ")}`);
                }
                if (progress.toolsDone > 0) {
                    lines.push(`✅ ${progress.toolsDone} steps completed`);
                }
                if (progress.planStep) {
                    lines.push(`📋 ${progress.planStep}`);
                }
                if (progress.hasText) {
                    lines.push(`✍️ Writing response...`);
                }
                lines.push(`\n💡 Send a different message to redirect the agent.`);
                await this.#reply(ref, lines.join("\n"), "HTML");
                return;
            }
        }

        // Get role-based config
        const roleModel = this.#permissions.getModelTier(ref.userId, this.#config);
        // Use dispatcher model (fast triage) for user conversations if configured
        const model = (this.#config.dispatcherModel && roleModel !== "fast")
            ? this.#config.dispatcherModel
            : roleModel;
        const mcpProfile = this.#permissions.getMcpProfile(ref.userId);

        // Check if conversation already exists (determines if first message)
        const isFirstMessage = !existingConv || existingConv.state === "dead";

        // Enrich text with context prefix
        const isDispatcher = model === "fast" && roleModel !== "fast";
        const enrichedText = this.#enricher.enrich(text, ref, { isFirstMessage, isDispatcher });

        // Route to conversation manager
        try {
            await this.#conversationManager.route(scopeKey, enrichedText, ref, {
                messageId: msg.message_id,
                rawText: text,
                model,
                mcpProfile,
            });
        } catch (err) {
            log.error(`Route error for ${scopeKey}: ${err.message}`);
            const errMsg = err.name === "PoolExhaustedError"
                ? "⏳ All instances busy. Try again in a moment."
                : `⚠️ ${err.message}`;
            await this.#reply(ref, errMsg).catch(() => {});
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

    // ── Group Mention Gate ──────────────────────────────────

    #shouldIgnoreInGroup(msg, ref) {
        // Only applies to group/supergroup that's NOT a forum
        if (ref.chatType === "private") return false;
        if (ref.isForum) return false; // forums use topic scoping, no gate

        // group_mode: "all" means respond to everything
        if (this.#config.groupMode === "all") return false;

        // Commands always pass through
        const text = msg.text || msg.caption || "";
        if (text.startsWith("/")) return false;

        // Reply to bot message passes through
        if (msg.reply_to_message?.from?.id === this.#telegram.botInfo?.id) return false;

        // Check for @mention of bot in entities
        const botUsername = this.#telegram.botInfo?.username?.toLowerCase();
        if (botUsername && msg.entities) {
            for (const ent of msg.entities) {
                if (ent.type === "mention") {
                    const mention = text.substring(ent.offset, ent.offset + ent.length).toLowerCase();
                    if (mention === `@${botUsername}`) return false;
                }
            }
        }

        // Not addressed to us — ignore
        return true;
    }

    // ── DM Topic Lobby ───────────────────────────────────────

    /** Check if this is a root/lobby message in a DM with topics enabled. */
    #isDmLobbyMessage(msg, ref) {
        if (ref.chatType !== "private") return false;
        if (!this.#config.dmTopicsEnabled) return false;
        if (ref.threadId) return false; // in a topic — not lobby
        if (msg.is_topic_message) return false; // explicitly in a topic
        return true;
    }

    /** Handle a message sent to the DM lobby (outside any topic). */
    async #handleLobbyMessage(ref) {
        const topics = this.#topicManager?.getTopics(ref.chatId);
        if (topics && topics.length > 0) {
            const topicList = topics.map(t => `  • ${t.name}`).join("\n");
            await this.#reply(ref,
                `💡 <b>Please use a topic thread</b>\n\n` +
                `This chat uses topics for organized conversations. ` +
                `Tap a topic above to get started!\n\n` +
                `<b>Available topics:</b>\n${topicList}\n\n` +
                `<i>Commands (/help, /status, etc.) still work here.</i>`,
                "HTML",
            );
        } else {
            await this.#reply(ref,
                `💡 <b>Topics are enabled</b>\n\n` +
                `Tap a topic above to start a conversation, or use /help for commands.`,
                "HTML",
            );
        }
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
        // DM with topic → scope per topic thread
        if (ref.chatType === "private" && ref.threadId) {
            return `dm:${ref.userId}:${ref.threadId}`;
        }
        // DM: scope per user
        return `dm:${ref.userId}`;
    }

    /** Detect if a message is asking about progress rather than a new instruction. */
    #isProgressQuery(text) {
        const lower = text.toLowerCase().trim();
        const patterns = [
            /^(progress|status|update)\??$/,
            /^what('?s| is) (the )?(progress|status|happening)/,
            /^how('?s| is) (it|that|the|things?) (going|coming|doing)/,
            /^(are you|you) (still )?(working|busy|running|thinking)/,
            /^(what are you|what're you) doing/,
            /^(stream|show|give).*progress/,
            /^eta\??$/,
        ];
        return patterns.some(p => p.test(lower));
    }

    /** Thread-aware reply — sends to correct thread/topic. */
    async #reply(ref, text, parseMode = null, replyMarkup = null) {
        const params = { chat_id: ref.chatId, text, link_preview_options: { is_disabled: true } };
        if (parseMode) params.parse_mode = parseMode;
        if (replyMarkup) params.reply_markup = replyMarkup;
        if (ref.threadId) params.message_thread_id = ref.threadId;
        return this.#telegram.call("sendMessage", params);
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
            try {
                await conv.receive("/stop");
                await this.#reply(ref, "⏹️ Stopped.");
            } catch {
                await this.#reply(ref, "⏹️ Nothing to stop.");
            }
        } else {
            await this.#reply(ref, "⏹️ Nothing running.");
        }
    }

    async #cmdNew(ref) {
        const scopeKey = this.#resolveScopeKey(ref);
        const destroyed = await this.#conversationManager.destroy(scopeKey);

        // Forum mode: create new topic for the conversation
        if (ref.isForum) {
            const title = `💬 Chat ${new Date().toLocaleString("en-SG", { timeZone: process.env.TZ || "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
            try {
                const topic = await this.#telegram.call("createForumTopic", {
                    chat_id: ref.chatId, name: title,
                });
                const newThreadId = topic?.result?.message_thread_id;
                if (newThreadId) {
                    await this.#telegram.call("sendMessage", {
                        chat_id: ref.chatId, message_thread_id: newThreadId,
                        text: "🆕 New conversation started. Send your first message here!",
                    });
                    return;
                }
            } catch (err) {
                log.warn(`Failed to create topic: ${err.message}`);
            }
        }

        if (destroyed) {
            await this.#reply(ref, "🆕 Fresh conversation started.");
        } else {
            await this.#reply(ref, "🆕 Ready for new conversation.");
        }
    }

    async #cmdHelp(ref) {
        const scopePrefix = this.#scopePrefix(ref);
        const text = `<b>📋 Ezra v7</b>\n\nSend any message to chat with Copilot.\n💡 Send a new message while I'm working to redirect me.`;

        const keyboard = [
            row(
                btn("🆕 New Chat", menuCallback(scopePrefix, "help", "new")),
                btn("⏹ Stop", menuCallback(scopePrefix, "help", "stop")),
            ),
            row(
                btn("⚙️ Settings", menuCallback(scopePrefix, "help", "settings")),
                btn("📊 Status", menuCallback(scopePrefix, "help", "status")),
            ),
            row(
                btn("📌 Standing", menuCallback(scopePrefix, "help", "standing")),
                btn("🧠 Memory", menuCallback(scopePrefix, "help", "memory")),
            ),
        ];

        await this.#menus.show(ref.chatId, "help", text, keyboard, { threadId: ref.threadId });
    }

    async #cmdStatus(ref) {
        const scopePrefix = this.#scopePrefix(ref);
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
            for (const c of convos.slice(0, 6)) {
                const icon = c.state === "prompting" ? "⚡" : c.state === "eliciting" ? "❓" : "💤";
                lines.push(`  ${icon} ${c.scopeKey} · ${c.model} · ${c.promptCount}p`);
            }
            if (convos.length > 6) lines.push(`  ...+${convos.length - 6} more`);
        }

        // SI status
        if (this.#siOrchestrator) {
            const siStatus = this.#siOrchestrator.status();
            lines.push(`\n<b>📌 Standing</b> ${siStatus.enabled}/${siStatus.total} enabled · ${siStatus.triggerCount} triggers`);
            if (siStatus.paused) lines.push(`  ⏸️ Paused`);
        }

        // Metrics
        lines.push(`\n<b>📈 Metrics</b>`);
        lines.push(`  ${metrics.totalPrompts} prompts · ${(metrics.totalMs / 1000).toFixed(1)}s total`);
        if (metrics.totalCrashes > 0) lines.push(`  ⚠️ ${metrics.totalCrashes} crashes`);
        if (poolStatus.waitQueueLength > 0) lines.push(`  ⏳ Wait queue: ${poolStatus.waitQueueLength}`);

        const keyboard = [
            row(
                btn("🆕 New", menuCallback(scopePrefix, "status", "new")),
                btn("⏹ Stop", menuCallback(scopePrefix, "status", "stop")),
                btn("⚙️ Settings", menuCallback(scopePrefix, "status", "settings")),
                btn("🔄 Refresh", menuCallback(scopePrefix, "status", "refresh")),
            ),
        ];

        await this.#menus.show(ref.chatId, "status", lines.join("\n"), keyboard, { threadId: ref.threadId });
    }

    async #cmdSettings(ref) {
        const scopePrefix = this.#scopePrefix(ref);
        const currentModel = this.#config.defaultModel || "standard";
        const modelIcon = currentModel === "fast" ? "⚡" : currentModel === "reasoning" ? "🧠" : "🔵";
        const permPolicy = this.#config.permissionPolicy || "interactive";
        const permIcon = permPolicy === "allow_all" ? "🔓" : "🔐";

        const text = [
            `<b>⚙️ Settings</b>\n`,
            `<b>Model:</b> ${modelIcon} ${currentModel}`,
            `<b>Permission:</b> ${permIcon} ${permPolicy}`,
            `\nTap to change:`,
        ].join("\n");

        const keyboard = [
            row(
                btn(`⚡ Fast${currentModel === "fast" ? " ✓" : ""}`, menuCallback(scopePrefix, "settings", "model:fast")),
                btn(`🔵 Standard${currentModel === "standard" ? " ✓" : ""}`, menuCallback(scopePrefix, "settings", "model:standard")),
                btn(`🧠 Reasoning${currentModel === "reasoning" ? " ✓" : ""}`, menuCallback(scopePrefix, "settings", "model:reasoning")),
            ),
            row(
                btn(`🔐 Interactive${permPolicy === "interactive" ? " ✓" : ""}`, menuCallback(scopePrefix, "settings", "perm:interactive")),
                btn(`🔓 Allow All${permPolicy === "allow_all" ? " ✓" : ""}`, menuCallback(scopePrefix, "settings", "perm:allow_all")),
            ),
            row(
                btn("❌ Close", menuCallback(scopePrefix, "settings", "close")),
            ),
        ];

        await this.#menus.show(ref.chatId, "settings", text, keyboard, { threadId: ref.threadId });
    }

    async #cmdStanding(ref) {
        if (!this.#siOrchestrator) {
            await this.#reply(ref, "📌 Standing instructions not available (SI engine not running).");
            return;
        }

        const scopePrefix = this.#scopePrefix(ref);
        const instructions = this.#siOrchestrator.manager.list();
        const enabled = instructions.filter(i => i.enabled);
        const disabled = instructions.filter(i => !i.enabled);

        const lines = [`<b>📌 Standing Instructions</b> (${enabled.length} active, ${disabled.length} disabled)\n`];

        for (const inst of instructions.slice(0, 10)) {
            const icon = inst.enabled ? "🟢" : "🔴";
            const desc = inst.description?.slice(0, 40) || "Unnamed";
            lines.push(`${icon} ${desc}`);
        }
        if (instructions.length > 10) lines.push(`...+${instructions.length - 10} more`);
        if (instructions.length === 0) lines.push("No instructions configured.");

        const buttons = [];
        if (this.#siOrchestrator.isPaused) {
            buttons.push(btn("▶️ Resume", menuCallback(scopePrefix, "standing", "resume")));
        } else {
            buttons.push(btn("⏸️ Pause All", menuCallback(scopePrefix, "standing", "pause")));
        }
        buttons.push(btn("❌ Close", menuCallback(scopePrefix, "standing", "close")));

        const keyboard = [row(...buttons)];
        await this.#menus.show(ref.chatId, "standing", lines.join("\n"), keyboard, { threadId: ref.threadId });
    }

    async #cmdMemory(ref) {
        const scopePrefix = this.#scopePrefix(ref);
        const { readFileSync, existsSync, readdirSync } = await import("node:fs");
        const agentDir = this.#config.agentDir || "/config/.agent";

        const files = ["IDENTITY.md", "MEMORY.md", "SKILLS.md", "TASKS.md"];
        const lines = [`<b>🧠 Agent Memory</b>\n`];

        for (const f of files) {
            const path = `${agentDir}/${f}`;
            if (existsSync(path)) {
                const size = readFileSync(path).length;
                const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)}K` : `${size}`;
                lines.push(`📄 ${f} (${sizeStr})`);
            } else {
                lines.push(`📄 ${f} <i>missing</i>`);
            }
        }

        // Daily logs
        const memDir = `${agentDir}/memory`;
        if (existsSync(memDir)) {
            try {
                const logs = readdirSync(memDir).filter(f => f.endsWith(".md"));
                lines.push(`📁 memory/ (${logs.length} daily logs)`);
            } catch {}
        }

        const keyboard = [
            row(
                btn("📄 Identity", menuCallback(scopePrefix, "memory", "view:IDENTITY.md")),
                btn("📄 Memory", menuCallback(scopePrefix, "memory", "view:MEMORY.md")),
            ),
            row(
                btn("📄 Tasks", menuCallback(scopePrefix, "memory", "view:TASKS.md")),
                btn("❌ Close", menuCallback(scopePrefix, "memory", "close")),
            ),
        ];

        await this.#menus.show(ref.chatId, "memory", lines.join("\n"), keyboard, { threadId: ref.threadId });
    }

    // ── Scope Prefix Helper ──────────────────────────────────

    #scopePrefix(ref) {
        if (ref.isForum && ref.threadId) return `forum:${ref.chatId}:${ref.threadId}`;
        if (ref.chatType === "group" || ref.chatType === "supergroup") return `group:${ref.chatId}:${ref.userId}`;
        if (ref.chatType === "private" && ref.threadId) return `dm:${ref.userId}:${ref.threadId}`;
        return `dm:${ref.userId}`;
    }

    // ── Callback Handling ────────────────────────────────────

    async #handleCallback(query) {
        const data = query.data;
        const userId = query.from?.id;
        const chatId = query.message?.chat?.id;
        const messageId = query.message?.message_id;

        if (!data || !userId || !chatId) return;

        // Check if this is a menu callback — ack immediately for menus
        const menuParsed = parseMenuCallback(data);
        if (menuParsed) {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
            await this.#handleMenuCallback(menuParsed, { chatId, userId, messageId, query });
            return;
        }

        // Legacy: scope-encoded elicitation callbacks — defer ack for alert text
        const parts = data.split(":");
        if (parts.length < 3) {
            await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
            log.debug(`Ignoring unrecognized callback: ${data}`);
            return;
        }

        let scopeKey, action, payload;
        if (parts[0] === "dm") {
            // dm:{userId}:action:payload OR dm:{userId}:{threadId}:action:payload
            // Detect: if parts[2] is numeric, it's a threadId (DM topic)
            if (parts.length >= 4 && /^\d+$/.test(parts[2])) {
                scopeKey = `dm:${parts[1]}:${parts[2]}`;
                action = parts[3];
                payload = parts.slice(4).join(":");
            } else {
                scopeKey = `dm:${parts[1]}`;
                action = parts[2];
                payload = parts.slice(3).join(":");
            }
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
            await this.#telegram.call("answerCallbackQuery", {
                callback_query_id: query.id,
                text: "⌛ Conversation ended. Send a new message.",
                show_alert: true,
            }).catch(() => {});
            return;
        }

        // Auth check
        const convOwner = conv.ref?.userId;
        if (convOwner && userId !== convOwner && !this.#permissions.isOwner(userId)) {
            await this.#telegram.call("answerCallbackQuery", {
                callback_query_id: query.id,
                text: "⛔ Not your conversation.",
                show_alert: true,
            }).catch(() => {});
            return;
        }

        switch (action) {
            case "elicit":
                await conv.respondElicitation(payload === "decline" ? "decline" : "accept");
                await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
                break;
            default:
                await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
                log.debug(`Unknown callback action: ${action}`);
        }
    }

    // ── Menu Callback Router ─────────────────────────────────

    async #handleMenuCallback(parsed, ctx) {
        const { scopeKey, menuName, action } = parsed;
        const { chatId, userId, messageId } = ctx;

        // Auth: only allowed users can interact with menus
        if (!this.#permissions.isAllowed(userId)) return;

        // Build correct ref from parsed scope key
        const ref = this.#refFromScope(scopeKey, chatId, userId);

        switch (menuName) {
        case "help":
            await this.#handleHelpAction(action, ref);
            break;
        case "status":
            await this.#handleStatusAction(action, ref);
            break;
        case "settings":
            await this.#handleSettingsAction(action, { chatId, userId, messageId, ref });
            break;
        case "standing":
            await this.#handleStandingAction(action, ref);
            break;
        case "memory":
            await this.#handleMemoryAction(action, ref);
            break;
        default:
            log.debug(`Unknown menu: ${menuName}`);
        }
    }

    /** Reconstruct a ref from a scope key for correct scope resolution. */
    #refFromScope(scopeKey, chatId, userId) {
        if (scopeKey.startsWith("forum:")) {
            const parts = scopeKey.split(":");
            return { chatId, userId, chatType: "supergroup", isForum: true, threadId: parseInt(parts[2]) || null };
        }
        if (scopeKey.startsWith("group:")) {
            return { chatId, userId, chatType: "supergroup", isForum: false, threadId: null };
        }
        // dm:{userId}:{threadId} → DM topic
        const dmParts = scopeKey.split(":");
        if (dmParts.length >= 3 && dmParts[0] === "dm") {
            return { chatId, userId, chatType: "private", isForum: false, threadId: parseInt(dmParts[2]) || null };
        }
        return { chatId, userId, chatType: "private", isForum: false, threadId: null };
    }

    async #handleHelpAction(action, ref) {
        switch (action) {
        case "new": await this.#cmdNew(ref); break;
        case "stop": await this.#cmdStop(ref); break;
        case "settings": await this.#cmdSettings(ref); break;
        case "status": await this.#cmdStatus(ref); break;
        case "standing": await this.#cmdStanding(ref); break;
        case "memory": await this.#cmdMemory(ref); break;
        }
    }

    async #handleStatusAction(action, ref) {
        switch (action) {
        case "new": await this.#cmdNew(ref); break;
        case "stop": await this.#cmdStop(ref); break;
        case "settings": await this.#cmdSettings(ref); break;
        case "refresh": await this.#cmdStatus(ref); break;
        }
    }

    async #handleSettingsAction(action, { chatId, userId, messageId, ref }) {
        if (action === "close") {
            await this.#menus.close(chatId, "settings", "⚙️ Settings closed.");
            return;
        }
        const settingsRef = ref || { chatId, userId, chatType: "private", isForum: false, threadId: null };
        if (action.startsWith("model:")) {
            const model = action.split(":")[1];
            this.#config.defaultModel = model;
            log.info(`Model changed to: ${model}`);
            await this.#cmdSettings(settingsRef);
        } else if (action.startsWith("perm:")) {
            const policy = action.split(":")[1];
            this.#config.permissionPolicy = policy;
            log.info(`Permission policy changed to: ${policy}`);
            await this.#cmdSettings(settingsRef);
        }
    }

    async #handleStandingAction(action, ref) {
        if (!this.#siOrchestrator) return;
        if (action === "close") {
            await this.#menus.close(ref.chatId, "standing", "📌 Standing closed.");
            return;
        }
        if (action === "pause") {
            this.#siOrchestrator.pause();
            await this.#reply(ref, "⏸️ Standing instructions paused.");
        } else if (action === "resume") {
            this.#siOrchestrator.resume();
            await this.#reply(ref, "▶️ Standing instructions resumed.");
        }
    }

    async #handleMemoryAction(action, ref) {
        if (action === "close") {
            await this.#menus.close(ref.chatId, "memory", "🧠 Memory closed.");
            return;
        }
        if (action.startsWith("view:")) {
            const fileName = action.split(":")[1];
            const agentDir = this.#config.agentDir || "/config/.agent";

            // Path traversal protection
            const { resolve } = await import("node:path");
            const resolved = resolve(agentDir, fileName);
            if (!resolved.startsWith(resolve(agentDir) + "/")) {
                await this.#reply(ref, "⛔ Invalid file path.");
                return;
            }

            try {
                const { readFileSync, existsSync } = await import("node:fs");
                if (!existsSync(resolved)) {
                    await this.#reply(ref, `📄 ${fileName} not found.`);
                    return;
                }
                let content = readFileSync(resolved, "utf-8");
                if (content.length > 3800) content = content.slice(0, 3800) + "\n\n... (truncated)";
                await this.#reply(ref, `<b>📄 ${fileName}</b>\n\n<pre>${escapeHtml(content)}</pre>`, "HTML");
            } catch (err) {
                await this.#reply(ref, `⚠️ Error reading ${fileName}: ${err.message}`);
            }
        }
    }
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
