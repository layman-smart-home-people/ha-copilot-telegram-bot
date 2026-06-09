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
import { withThread } from "../transport/telegram/thread.mjs";

const log = createLogger("router");

// ── Reset defaults ──────────────────────────────────────────
// Used by /memory → Reset to restore seed docs to clean state.
// Keep in sync with the actual files in /config/.github/ and agentDir.

const SKILLS_DEFAULT = `# Agent Skills Reference

## MCP Tool Index
Use \`tool_search_tool_regex\` to discover tools by pattern. Schemas are self-documenting.
- **ha-mcp** (82+ tools) — ALL Home Assistant ops: entities, services, automations, dashboards, history, calendar, HACS, backups, bulk control
- **telegram** — \`ask_user\` (inline buttons/prompts, auto-appends ✏️+❌), \`notify_user\`, \`background_task\` (fire-and-forget), \`telegram_call\` (any Bot API method)
- **standing-instructions** — \`si_create/list/get/update/delete/toggle\`. Supports events/cron/timers, conditions (state/numeric/time + AND/OR/NOT), cooldown, chaining, expiry. NEVER edit the JSON file directly.
- **memory** — \`remember\` (auto-enriched write, pinned=true for core identity), \`recall\` (entity-aware search), \`memory_admin\` (pin/unpin/navigate/collections/settings). Core memory always in context.
- **access-control** — user roles & permissions management
- **session-history** — cross-session history lookup

## Sub-Agents & Background Work
- **\`task(mode: "sync")\`** — ALWAYS use sync. Background mode agents are killed when the prompt completes.
- **\`background_task\` MCP tool** — safe fire-and-forget. Runs on a separate agent, delivers results to the user via Telegram. Use for async research, monitoring, or any work the user doesn't need in this response.
- **When to dispatch**: task needs >5 independent tool calls, >2 sequential decision points, or research across unknown files. Otherwise do it inline.
- **When NOT to dispatch**: simple lookups, reading a few known files, single grep/glob — just do it yourself.

## PKM (Memory) Scoping
- **\`scope: "agent"\`** — operational notes private to you: workflow preferences, recurring patterns, internal reminders (e.g. "user prefers notifications 9-17", "AV system uses QSYS protocol")
- **\`scope: "user"\`** — facts about a specific person: preferences, habits, personal context (e.g. "Sam prefers dark mode dashboards", "Jas allergic to shellfish")
- **\`scope: "household"\`** — shared knowledge: home policies, building info, device inventory, shared workflows
- **Graduation rule**: if a fact is useful across 2+ sessions or informs future decision-making, store in PKM. One-off facts stay in conversation.
`;

const COPILOT_INSTRUCTIONS_DEFAULT = `# Copilot Instructions for Home Assistant

## Tool Preference
**Always use ha-mcp tools over curl.** 82+ MCP tools available. Use \`tool_search_tool_regex\` to discover.

### Tool routing
- Entity state → \`ha_get_state\` | Service → \`ha_call_service\` | Search → \`ha_search_entities\`
- History → \`ha_get_history\` | Templates → \`ha_eval_template\` | System → \`ha_get_system_health\`
- Dashboard R/W → \`ha_config_get/set_dashboard\` | Automations → \`ha_config_get/set_automation\`
- Bulk control → \`ha_bulk_control\` | Prompts → \`ask_user\`
- Fallback: \`bash/curl\` with \`$SUPERVISOR_TOKEN\` — LAST RESORT

## Environment
- Home Assistant OS, working directory: \`/config\`
- \`/config/www/\` serves at \`https://nuach.thng.sg/local/\`

## Telegram Formatting
Auto-converted from markdown to Telegram HTML. Bold, italic, code, lists, headers, blockquotes work.
Use emoji for hierarchy. **Avoid** tables — save HTML reports to \`/config/www/\` instead.

## Telegram Bot API — \`telegram_call\`
Direct Bot API access: \`telegram_call(method="...", params={...})\`
- Forum topics: \`editForumTopic\`, \`createForumTopic\`, \`closeForumTopic\`, \`getForumTopicIconStickers\`
- Messages: \`sendMessage\` (with \`message_thread_id\`), \`editMessageText\`
- Any Bot API method works. Blocked: webhook/logout methods.

## Dashboard Editing
**NEVER edit \`.storage/lovelace*\` directly.** Use:
1. \`ha_config_get_dashboard(url_path="...")\` → get config + \`config_hash\`
2. \`ha_config_set_dashboard(url_path="...", config_hash="...", python_transform="...")\` → surgical edits
Key dashboards: \`lovelace\` (main), \`dashboard-modern\` (floorplan), \`jasmine-home\` (YAML)

## Reactive Requests — SI vs HA Automation
When the user asks "when X happens, do Y":
- **Standing Instruction (SI)** — default choice for user-requested reactive behavior. Use when: agent reasoning needed, complex conditions, user explicitly asked, or cross-system logic.
- **HA Automation** — only suggest (never create directly) for sub-second latency triggers or simple state-based rules the user wants to own in the HA UI.
- **Decision rule**: if the user asked you to do it → SI. If it's a raw device trigger → suggest HA automation and let the user decide.

## Output Routing
- **Telegram inline** — under 300 words, single topic, no data grids
- **HTML report** (\`/config/www/\`) — multi-section analysis, data with >5 rows or >3 columns, visual formatting
- **Log/file** — diagnostic traces, verbose output, archival

## Safety
- Confirm physical-consequence actions via \`ask_user\` first
- Never expose tokens/secrets. Don't modify \`.storage/\` directly.
- Search entities first — don't guess IDs
`;

// Commands handled by the router
const COMMANDS = new Map([
    ["start", "Welcome & quick start guide"],
    ["stop", "Cancel current operation"],
    ["new", "Start fresh conversation"],
    ["help", "Show available commands"],
    ["status", "Show bot & pool status"],
    ["settings", "Configure bot settings"],
    ["standing", "Manage standing instructions"],
    ["memory", "Memory & knowledge base"],
    ["dream", "Deep memory maintenance"],
]);

export class Router {
    #telegram;
    #conversationManager;
    #pool;
    #permissions;
    #rbac;
    #config;
    #enricher;
    #pkm;
    #handlers = new Map(); // command → handler function
    #fileHandler;
    #menus;
    #siOrchestrator = null; // set externally after boot
    #topicManager = null;   // set externally after boot
    #udsServer = null;      // set externally after boot
    #rejectCooldowns = new Map(); // userId → last rejection timestamp

    constructor({ telegram, conversationManager, pool, permissions, rbac, config, enricher, pkm }) {
        this.#telegram = telegram;
        this.#conversationManager = conversationManager;
        this.#pool = pool;
        this.#permissions = permissions;
        this.#rbac = rbac || null;
        this.#config = config;
        this.#enricher = enricher || new PromptEnricher({ config, permissions });
        this.#pkm = pkm || null;
        this.#fileHandler = new FileHandler({ telegram });
        this.#menus = new MenuManager({ telegram });

        // Register built-in command handlers
        this.#handlers.set("start", (ref) => this.#cmdHelp(ref));
        this.#handlers.set("stop", (ref) => this.#cmdStop(ref));
        this.#handlers.set("new", (ref) => this.#cmdNew(ref));
        this.#handlers.set("help", (ref) => this.#cmdHelp(ref));
        this.#handlers.set("status", (ref) => this.#cmdStatus(ref));
        this.#handlers.set("settings", (ref) => this.#cmdSettings(ref));
        this.#handlers.set("standing", (ref) => this.#cmdStanding(ref));
        this.#handlers.set("memory", (ref) => this.#cmdMemory(ref));
        this.#handlers.set("dream", (ref) => this.#cmdDream(ref));
    }

    /** Set SI orchestrator reference (called after boot). */
    setSIOrchestrator(orch) { this.#siOrchestrator = orch; }

    /** Set TopicManager reference (called after boot). */
    setTopicManager(mgr) { this.#topicManager = mgr; }

    /** Set UDS server reference for MCP sidecar IPC (called after boot). */
    setUdsServer(uds) { this.#udsServer = uds; }

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

        const rawText = msg.text || msg.caption || "";
        const inviteToken = this.#parseInviteToken(rawText);

        // Permission check
        if (!this.#permissions.isAllowed(ref.userId)) {
            if (inviteToken) {
                const displayName = this.#displayNameFor(msg.from);
                if (!this.#rbac) {
                    await this.#reply(ref, "❌ Invite onboarding is unavailable right now. Ask the admin to pair you manually.").catch(() => {});
                    return;
                }
                if (!inviteToken.valid) {
                    await this.#reply(ref, "❌ This invite link is invalid. Ask the admin for a fresh invite.").catch(() => {});
                    return;
                }

                try {
                    const invite = this.#rbac.consumeInvite(inviteToken.token, ref.userId, displayName);
                    if (!invite) {
                        await this.#reply(ref, "❌ This invite link is invalid, expired, or already used. Ask the admin for a new invite.").catch(() => {});
                        return;
                    }

                    this.#rbac.setUserRole(ref.userId, invite.role, {
                        username: msg.from?.username || null,
                        displayName,
                        pairedBy: "invite",
                        expiresAt: invite.roleExpiresAt,
                    });
                    log.info(`User ${ref.userId} paired via invite deep link as ${invite.role}`);
                } catch (err) {
                    log.warn(`Invite onboarding failed for ${ref.userId}: ${err.message}`);
                    await this.#reply(ref, "❌ I couldn't complete invite onboarding. Ask the admin for a fresh invite or manual pairing.").catch(() => {});
                    return;
                }
            } else {
                // Rate-limited rejection reply (once per user per 10 min)
                const now = Date.now();
                const lastReject = this.#rejectCooldowns?.get(ref.userId) || 0;
                if (now - lastReject > 600_000) {
                    if (!this.#rejectCooldowns) this.#rejectCooldowns = new Map();
                    this.#rejectCooldowns.set(ref.userId, now);
                    try {
                        await this.#reply(ref, "🔒 You're not authorized to use this bot. Ask the admin to grant you access.");
                    } catch {}
                }
                return;
            }
        }

        // Group allowlist gate: if allowed_groups is configured, only respond in listed groups
        if (ref.chatType !== "private") {
            const allowedGroups = this.#config.allowedGroups;
            if (allowedGroups?.length > 0 && !allowedGroups.includes(String(ref.chatId))) {
                log.debug(`Blocked message from unlisted group ${ref.chatId}`);
                return;
            }
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

        // Intercept text for pending UDS ask_user questions (MCP sidecar)
        if (this.#udsServer?.tryResolveText(ref.chatId, text, ref.threadId)) {
            log.debug(`Text resolved pending UDS question for chat ${ref.chatId}:${ref.threadId || "main"}`);
            return;
        }

        // Get role-based config
        const roleModel = this.#permissions.getModelTier(ref.userId, this.#config);
        // Dispatcher pattern: if dispatcherModel is explicitly set and differs from the
        // user's role model, use it for fast triage. When dispatcherModel is empty/unset,
        // the user's default_model is used directly (no dispatcher).
        const dispatcherModel = this.#config.dispatcherModel || "";
        const useDispatcher = dispatcherModel && dispatcherModel !== roleModel && roleModel !== "fast";
        const model = useDispatcher ? dispatcherModel : roleModel;
        const mcpProfile = this.#permissions.getMcpProfile(ref.userId);

        // Check if conversation already exists (determines if first message)
        const isFirstMessage = !existingConv || existingConv.state === "dead";

        // Enrich text with context prefix
        const isDispatcher = useDispatcher;
        const enrichedText = this.#enricher.enrich(text, ref, { isFirstMessage, isDispatcher });

        // Track user message for PKM buffer search (non-blocking)
        if (this.#pkm) {
            // Auto-enable PKM for owner on first interaction
            try {
                const uid = String(ref.userId);
                if (!this.#pkm.store?.isEnabled(uid) && this.#permissions.getRole(ref.userId) === "owner") {
                    this.#pkm.store.enableUser(uid);
                    log.info(`Auto-enabled PKM for owner ${uid}`);
                }
            } catch {}
            try { this.#pkm.trackMessage(String(ref.userId), String(ref.chatId), text, "user"); } catch {}
        }

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
                ? "⏳ I'm handling other requests right now. Please try again in a few seconds."
                : "⚠️ Something went wrong. Please try again.";
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
        // Forum: scope per user within topic (enables concurrent requests)
        if (ref.isForum && ref.threadId) {
            return `forum:${ref.chatId}:${ref.threadId}:${ref.userId}`;
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

    #parseInviteToken(text) {
        const match = text.match(/^\/start(?:@\w+)?\s+(invite_(\S+))\s*$/i);
        if (!match) return null;
        const token = match[2] || "";
        return {
            token,
            valid: /^[a-f0-9]{32}$/i.test(token),
        };
    }

    #displayNameFor(user) {
        if (!user) return null;
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
        return fullName || user.username || null;
    }

    /** Thread-aware reply — sends to correct thread/topic. */
    async #reply(ref, text, parseMode = null, replyMarkup = null) {
        const params = withThread({ chat_id: ref.chatId, text, link_preview_options: { is_disabled: true } }, ref);
        if (parseMode) params.parse_mode = parseMode;
        if (replyMarkup) params.reply_markup = replyMarkup;
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

        // Cancel any pending UDS questions
        if (this.#udsServer) this.#udsServer.cancelAll("User cancelled");

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
        const text = [
            `<b>🤖 Home Assistant Copilot v${this.#config.version}</b>\n`,
            `Send any message to chat — ask questions, control devices, or get reports.`,
            `📸 Send a photo for visual analysis`,
            `📎 Send text files to discuss their contents`,
            `💡 Send a new message while I'm working to redirect me\n`,
            `<b>Quick actions:</b>`,
            `⚙️ <b>Settings</b> — change model (fast/standard/reasoning)`,
            `📌 <b>Standing</b> — auto-rules like "alert me when door opens"`,
            `🧠 <b>Memory</b> — what I remember about you & your home`,
        ].join("\n");

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

        const activeConvos = convos.filter(c => c.state === "prompting");
        const modelLabel = this.#config.defaultModel === "fast" ? "⚡ Fast" :
            this.#config.defaultModel === "reasoning" ? "🧠 Reasoning" : "🔵 Standard";

        const lines = [
            `<b>📊 Status</b> — v${this.#config.version}\n`,
            `<b>Model:</b> ${modelLabel}`,
            `<b>Active chats:</b> ${activeConvos.length} working, ${convos.length - activeConvos.length} idle`,
            `<b>Capacity:</b> ${poolStatus.claimed + poolStatus.idle} of ${poolStatus.maxSize} slots used`,
        ];

        // HA connection
        if (this.#config.haConnected) {
            lines.push(`<b>Home Assistant:</b> ✅ connected (${this.#config.haVersion || "unknown"})`);
        } else {
            lines.push(`<b>Home Assistant:</b> ❌ disconnected`);
        }

        // SI status — this is the core feature, show prominently
        if (this.#siOrchestrator) {
            const siStatus = this.#siOrchestrator.status();
            const siLine = siStatus.paused
                ? `⏸️ Paused (${siStatus.enabled} rules ready)`
                : `✅ ${siStatus.enabled} active rules, ${siStatus.triggerCount} triggers today`;
            lines.push(`<b>Standing Instructions:</b> ${siLine}`);
        }

        // Simple metrics
        if (metrics.totalPrompts > 0) {
            lines.push(`\n<i>${metrics.totalPrompts} prompts served · avg ${metrics.totalPrompts > 0 ? ((metrics.totalMs / metrics.totalPrompts) / 1000).toFixed(1) : 0}s</i>`);
        }
        if (poolStatus.waitQueueLength > 0) {
            lines.push(`⏳ ${poolStatus.waitQueueLength} request${poolStatus.waitQueueLength > 1 ? "s" : ""} waiting`);
        }

        const keyboard = [
            row(
                btn("🆕 New Chat", menuCallback(scopePrefix, "status", "new")),
                btn("⏹ Stop", menuCallback(scopePrefix, "status", "stop")),
                btn("🔄 Refresh", menuCallback(scopePrefix, "status", "refresh")),
            ),
            row(
                btn("⚙️ Settings", menuCallback(scopePrefix, "status", "settings")),
                btn("❌ Close", menuCallback(scopePrefix, "status", "close")),
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

        const modelDesc = {
            fast: "quick answers, simple tasks",
            standard: "balanced speed & quality",
            reasoning: "deep analysis, complex tasks",
        };

        const text = [
            `<b>⚙️ Settings</b>\n`,
            `<b>Model:</b> ${modelIcon} ${currentModel} — ${modelDesc[currentModel] || ""}`,
            `<b>Permission:</b> ${permIcon} ${permPolicy}`,
            `\n<i>Changing model starts a fresh conversation.</i>`,
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

        if (instructions.length === 0) {
            lines.push(`<i>No instructions yet. Tell me something like "alert me when the front door opens" and I'll create one.</i>`);
        } else {
            for (const inst of instructions.slice(0, 10)) {
                const icon = inst.enabled ? "🟢" : "🔴";
                const trigger = inst.trigger?.type === "cron" ? "⏰" : inst.trigger?.type === "timer" ? "⏲" : "📡";
                const desc = inst.description?.slice(0, 50) || "Unnamed";
                lines.push(`${icon} ${trigger} ${desc}`);
            }
            if (instructions.length > 10) lines.push(`...+${instructions.length - 10} more`);
        }

        const buttons = [];
        if (this.#siOrchestrator.isPaused) {
            buttons.push(btn("▶️ Resume", menuCallback(scopePrefix, "standing", "resume")));
        } else {
            buttons.push(btn("⏸️ Pause All", menuCallback(scopePrefix, "standing", "pause")));
        }

        const keyboard = [
            row(...buttons, btn("❌ Close", menuCallback(scopePrefix, "standing", "close"))),
        ];

        // Add template suggestions if no instructions exist
        if (instructions.length === 0) {
            keyboard.unshift(
                row(
                    btn("🚪 Door Alert", menuCallback(scopePrefix, "standing", "tpl:door")),
                    btn("🌡 Temp Warning", menuCallback(scopePrefix, "standing", "tpl:temp")),
                ),
                row(
                    btn("☀️ Morning Briefing", menuCallback(scopePrefix, "standing", "tpl:morning")),
                    btn("🔋 Battery Alert", menuCallback(scopePrefix, "standing", "tpl:battery")),
                ),
            );
        }

        await this.#menus.show(ref.chatId, "standing", lines.join("\n"), keyboard, { threadId: ref.threadId });
    }

    async #cmdMemory(ref) {
        const scopePrefix = this.#scopePrefix(ref);
        const { readFileSync, existsSync } = await import("node:fs");

        const lines = [`<b>🧠 Memory</b>\n`];

        // PKM stats — show actual user memories if database exists
        const pkmDbExists = existsSync("/data/pkm.db");
        if (pkmDbExists) {
            try {
                // Try to get stats from the PKM API
                const res = await fetch("http://localhost:8099/api/pkm/stats", {
                    headers: { "X-Scope-Key": `dm:${ref.userId}` },
                });
                if (res.ok) {
                    const stats = await res.json();
                    const total = stats.total_notes ?? stats.totalNotes ?? 0;
                    const topics = stats.total_topics ?? stats.topicCount ?? 0;
                    const entities = stats.total_entities ?? stats.entityCount ?? 0;
                    lines.push(`📊 <b>${total}</b> memories · <b>${topics}</b> topics · <b>${entities}</b> entities`);
                    if (total > 0) {
                        lines.push(`<i>Ask me anything about past conversations — I'll search my memory.</i>`);
                    } else {
                        lines.push(`<i>No memories yet. Chat with me and I'll start remembering.</i>`);
                    }
                } else {
                    lines.push(`📊 Memory database ready`);
                    lines.push(`<i>Use remember and recall tools to manage memories.</i>`);
                }
            } catch {
                lines.push(`📊 Memory system available`);
            }
        } else {
            lines.push(`<i>Memory database not yet created. It will be initialized on first use.</i>`);
        }

        // Agent config
        const agentDir = this.#config.agentDir || "/config/copilot-telegram-bot";
        const identityPath = `${agentDir}/IDENTITY.md`;
        if (existsSync(identityPath)) {
            const size = readFileSync(identityPath).length;
            lines.push(`\n<b>Agent Config</b>`);
            lines.push(`🤖 Identity ${size > 1024 ? `${(size / 1024).toFixed(1)}K` : `${size}B`}`);
        }

        // Core memory (pinned notes)
        if (this.#pkm) {
            try {
                const core = this.#pkm.getCoreMemoryBlock();
                if (core) {
                    lines.push(`📌 Core memory: ${core.length} chars pinned`);
                }
            } catch {}
        }

        const keyboard = [
            row(
                btn("🔍 Search Memory", menuCallback(scopePrefix, "memory", "search")),
                btn("🌙 Dream", menuCallback(scopePrefix, "memory", "dream")),
            ),
            row(
                btn("🤖 View Identity", menuCallback(scopePrefix, "memory", "view:IDENTITY.md")),
            ),
            row(
                btn("🔄 Reset Agent Config", menuCallback(scopePrefix, "memory", "reset")),
                btn("❌ Close", menuCallback(scopePrefix, "memory", "close")),
            ),
        ];

        await this.#menus.show(ref.chatId, "memory", lines.join("\n"), keyboard, { threadId: ref.threadId });
    }

    async #cmdDream(ref) {
        if (!this.#pkm) {
            await this.#reply(ref, "⚠️ Memory system not available.");
            return;
        }

        const statusMsg = await this.#reply(ref, "🌙 <i>Dreaming...</i>", "HTML");
        const editStatus = async (text) => {
            try {
                const params = withThread({
                    chat_id: ref.chatId, message_id: statusMsg.message_id,
                    text, parse_mode: "HTML",
                }, ref);
                await this.#telegram.call("editMessageText", params);
            } catch {}
        };

        const DREAM_TIMEOUT_MS = 5 * 60 * 1000;
        const dreamFetch = async (scope) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), DREAM_TIMEOUT_MS);
            try {
                const res = await fetch("http://localhost:8099/api/pkm/dream", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Scope-Key": `dm:${ref.userId}` },
                    body: JSON.stringify(scope === "agent" ? { scope: "agent" } : {}),
                    signal: ctrl.signal,
                });
                if (res.ok) return { scope, data: await res.json() };
                const body = await res.json().catch(() => ({}));
                return { scope, error: body.error || `HTTP ${res.status}` };
            } catch (e) {
                return { scope, error: e.name === "AbortError" ? "Timed out" : e.message };
            } finally {
                clearTimeout(timer);
            }
        };

        // Dream for user, then agent
        const userResult = await dreamFetch("user");
        await editStatus("🌙 <i>Dreaming... (user ✅, agent pending)</i>");
        const agentResult = await dreamFetch("agent");

        // Build summary
        const formatResult = ({ scope, data, error }) => {
            const label = scope === "agent" ? "🤖 Agent" : "👤 User";
            if (error) return `${label}: ⚠️ ${error}`;
            if (!data) return `${label}: ⚠️ Empty response`;
            const parts = [];
            if (data.harvested) parts.push(`📥 ${data.harvested} harvested`);
            if (data.curated)   parts.push(`🧹 ${data.curated} curated`);
            if (data.contradictions) parts.push(`⚔️ ${data.contradictions} contradictions`);
            if (data.merged)    parts.push(`🔗 ${data.merged} merged`);
            if (data.synthesized) parts.push(`💡 ${data.synthesized} synthesized`);
            if (data.stale)     parts.push(`⏳ ${data.stale} stale`);
            if (data.entities)  parts.push(`👤 ${data.entities} entities`);
            if (data.suggestions) parts.push(`💭 ${data.suggestions} suggestions`);
            if (data.compacted) parts.push(`🗜️ ${data.compacted} compacted`);
            return `${label}: ${parts.length ? parts.join(" · ") : "✅ No changes needed"}`;
        };

        const lines = [
            "🌙 <b>Dream complete</b>\n",
            formatResult(userResult),
            formatResult(agentResult),
        ];
        await editStatus(lines.join("\n"));
    }

    // ── Scope Prefix Helper ──────────────────────────────────

    #scopePrefix(ref) {
        if (ref.isForum && ref.threadId) return `forum:${ref.chatId}:${ref.threadId}:${ref.userId}`;
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

        // UDS server callbacks (MCP ask_user buttons)
        if (this.#udsServer?.handleCallback(query)) return;

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
            scopeKey = `forum:${parts[1]}:${parts[2]}:${parts[3]}`;
            action = parts[4];
            payload = parts.slice(5).join(":");
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
        case "close":
            await this.#menus.close(ref.chatId, "status", "📊 Status closed.", { threadId: ref.threadId });
            break;
        }
    }

    async #handleSettingsAction(action, { chatId, userId, messageId, ref }) {
        if (action === "close") {
            await this.#menus.close(chatId, "settings", "⚙️ Settings closed.", { threadId: ref?.threadId });
            return;
        }
        const settingsRef = ref || { chatId, userId, chatType: "private", isForum: false, threadId: null };
        if (action.startsWith("model:")) {
            const model = action.split(":")[1];
            this.#config.defaultModel = model;
            log.info(`Model changed to: ${model}`);

            // Destroy the active conversation so next message uses the new model
            const scopeKey = this.#resolveScopeKey(settingsRef);
            const existingConv = this.#conversationManager.get(scopeKey);
            if (existingConv && existingConv.state !== "dead") {
                await this.#conversationManager.destroy(scopeKey);
                log.info(`Destroyed conversation ${scopeKey} for model change → ${model}`);
            }

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
            await this.#menus.close(ref.chatId, "standing", "📌 Standing closed.", { threadId: ref.threadId });
            return;
        }
        if (action === "pause") {
            this.#siOrchestrator.pause();
            await this.#reply(ref, "⏸️ Standing instructions paused.");
        } else if (action === "resume") {
            this.#siOrchestrator.resume();
            await this.#reply(ref, "▶️ Standing instructions resumed.");
        } else if (action.startsWith("tpl:")) {
            // SI template — route as a prompt to the agent
            const templates = {
                door: "Create a standing instruction that alerts me when any door or window sensor opens. Use state_change trigger watching binary_sensor entities with 'door' or 'window' in the name, triggering when state changes to 'on'.",
                temp: "Create a standing instruction that warns me when any room temperature exceeds 30°C or drops below 16°C. Use state_change trigger with above/below thresholds on climate or temperature sensor entities.",
                morning: "Create a standing instruction that gives me a morning briefing every day at 7:00 AM. Use a cron trigger (0 7 * * *) with wake_agent action. The briefing should include: weather, any overnight alerts, today's calendar, and device status summary.",
                battery: "Create a standing instruction that alerts me when any device battery level drops below 20%. Use state_change trigger with below: 20 on battery sensor entities.",
            };
            const prompt = templates[action.split(":")[1]];
            if (!prompt) return;
            await this.#menus.close(ref.chatId, "standing", "📌 Setting up...", { threadId: ref.threadId });
            // Route the template prompt through the conversation
            const scopeKey = this.#resolveScopeKey(ref);
            const enrichedText = this.#enricher.enrich(prompt, ref, { isFirstMessage: !this.#conversationManager.get(scopeKey) });
            const roleModel = this.#permissions.getModelTier(ref.userId, this.#config);
            await this.#conversationManager.route(scopeKey, enrichedText, ref, {
                model: roleModel, mcpProfile: "owner", rawText: prompt,
            });
        }
    }

    async #handleMemoryAction(action, ref) {
        if (action === "close") {
            await this.#menus.close(ref.chatId, "memory", "🧠 Memory closed.", { threadId: ref.threadId });
            return;
        }
        if (action === "dream") {
            await this.#menus.close(ref.chatId, "memory", null, { threadId: ref.threadId });
            await this.#cmdDream(ref);
            return;
        }
        if (action === "search") {
            await this.#menus.close(ref.chatId, "memory", "🔍 Tell me what you'd like to recall — I'll search my memory.", { threadId: ref.threadId });
            return;
        }
        if (action === "reset") {
            // Show confirmation
            const scopePrefix = this.#scopePrefix(ref);
            const text = "⚠️ <b>Reset agent config?</b>\n\nThis will reset IDENTITY.md, SKILLS.md, TASKS.md, and copilot-instructions.md to defaults.\nPinned core memories will be preserved.\nDaily logs will be cleared.";
            const keyboard = [
                row(
                    btn("✅ Yes, reset", menuCallback(scopePrefix, "memory", "confirm-reset")),
                    btn("❌ Cancel", menuCallback(scopePrefix, "memory", "close")),
                ),
            ];
            await this.#menus.show(ref.chatId, "memory", text, keyboard, { threadId: ref.threadId });
            return;
        }
        if (action === "confirm-reset") {
            const agentDir = this.#config.agentDir || "/config/.agent";
            const { writeFileSync, rmSync, mkdirSync, existsSync: exists } = await import("node:fs");

            // Reset agent seed files to defaults
            const defaults = {
                "SKILLS.md": SKILLS_DEFAULT,
                "TASKS.md": "# Active Tasks\n\nTasks the agent is working on or needs to resume.\n\n## In Progress\n\n## Pending\n\n## Recently Completed\n",
            };

            try {
                for (const [file, content] of Object.entries(defaults)) {
                    writeFileSync(`${agentDir}/${file}`, content, "utf-8");
                }

                // Reset copilot-instructions.md (operational context)
                writeFileSync("/config/.github/copilot-instructions.md", COPILOT_INSTRUCTIONS_DEFAULT, "utf-8");

                // Clear daily logs
                const memDir = `${agentDir}/memory`;
                if (exists(memDir)) {
                    rmSync(memDir, { recursive: true });
                    mkdirSync(memDir, { recursive: true });
                }

                // Reload enricher cache
                this.#enricher.reload();

                await this.#menus.close(ref.chatId, "memory",
                    "✅ Reset complete.\n📄 SKILLS.md, TASKS.md, copilot-instructions.md → defaults\n📁 Daily logs cleared\n📌 Core memories preserved",
                    { threadId: ref.threadId });
            } catch (err) {
                await this.#reply(ref, `⚠️ Reset failed: ${err.message}`);
            }
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
