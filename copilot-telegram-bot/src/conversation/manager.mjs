// ============================================================
// ConversationManager — Routes messages to Conversations
// ============================================================
// Maps scopeKey → Conversation. Handles:
// - Routing incoming messages to the right conversation
// - Lazy creation on first message
// - Idle reaping (conversations inactive > timeout get destroyed)
// - SI (scheduled intelligence) conversation spawning

import { Conversation } from "./conversation.mjs";
import { SessionLedger } from "./session-ledger.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("conv-mgr");
const REAP_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_REAP_MS = 30 * 60_000; // 30 min

export class ConversationManager {
    #conversations = new Map(); // scopeKey → Conversation
    #creating = new Map();      // scopeKey → Promise<Conversation> (in-flight creation guard)
    #pool;                      // ACPPool
    #telegram;                  // TelegramClient
    #config;
    #reapInterval = null;
    #idleReapMs;
    #ledger;                    // SessionLedger — persists scopeKey→sessionId

    constructor({ pool, telegram, config }) {
        this.#pool = pool;
        this.#telegram = telegram;
        this.#config = config;
        this.#idleReapMs = (config.poolIdleMinutes || 30) * 60_000;
        this.#ledger = new SessionLedger();
    }

    // ── Public API ───────────────────────────────────────────

    /** Start the manager (reap interval). */
    start() {
        this.#reapInterval = setInterval(() => this.#reapIdle(), REAP_INTERVAL_MS);
        this.#reapInterval.unref?.();
        log.info("ConversationManager started");
    }

    /** Stop all conversations and clean up. */
    async stop() {
        if (this.#reapInterval) {
            clearInterval(this.#reapInterval);
            this.#reapInterval = null;
        }
        for (const conv of this.#conversations.values()) {
            // Persist sessionIds before shutdown
            const sid = conv.sessionId;
            if (sid && conv.scopeKey) {
                this.#ledger.record(conv.scopeKey, sid);
            }
            if (conv.instanceId) {
                this.#pool.release(conv.instanceId);
            }
            conv.kill();
        }
        this.#conversations.clear();
        log.info("ConversationManager stopped");
    }

    /**
     * Route a message to the appropriate conversation.
     * Creates a new conversation if none exists for this scope.
     * @param {string} scopeKey — e.g., "dm:430432097"
     * @param {string} text — user message text
     * @param {object} ref — { chatId, threadId?, chatType, userId }
     * @param {object} opts — { messageId?, images?, model?, mcpProfile? }
     * @returns {Promise<any>}
     */
    async route(scopeKey, text, ref, opts = {}) {
        let conv = this.#conversations.get(scopeKey);

        if (conv && conv.state === "dead") {
            // Dead conversation — remove and recreate
            this.#conversations.delete(scopeKey);
            conv = null;
        }

        if (!conv) {
            // Serialize creation per scope to prevent duplicate pool instances
            if (this.#creating.has(scopeKey)) {
                conv = await this.#creating.get(scopeKey);
            } else {
                const p = this.#createConversation(scopeKey, ref, opts);
                this.#creating.set(scopeKey, p);
                try {
                    conv = await p;
                } finally {
                    this.#creating.delete(scopeKey);
                }
            }
        }

        return conv.receive(text, opts);
    }

    /**
     * Get an existing conversation by scope key.
     */
    get(scopeKey) {
        return this.#conversations.get(scopeKey) ?? null;
    }

    /**
     * Spawn a dedicated SI (Scheduled Intelligence) conversation.
     * SI gets its own pool instance, separate from user conversations.
     */
    async spawnSI(scopeKey, ref, { model, mcpProfile } = {}) {
        const siKey = `si:${scopeKey}`;
        if (this.#conversations.has(siKey)) {
            return this.#conversations.get(siKey);
        }

        const inst = await this.#pool.acquire(siKey, {
            model: model || this.#config.siDefaultModel || "standard",
            mcpProfile: mcpProfile || "owner",
        });

        const conv = new Conversation({
            scopeKey: siKey, poolInstance: inst, telegram: this.#telegram, ref,
            config: this.#config,
        });
        this.#setupConvListeners(conv);
        this.#conversations.set(siKey, conv);
        log.info(`SI conversation spawned: ${siKey} on ${inst.id}`);
        return conv;
    }

    /**
     * Destroy a specific conversation (e.g., user says /new).
     * Clears ledger entry so next conversation starts fresh.
     */
    async destroy(scopeKey) {
        const conv = this.#conversations.get(scopeKey);
        if (!conv) return false;
        this.#ledger.clear(scopeKey);
        this.#releaseConversation(conv, { skipLedger: true });
        return true;
    }

    /**
     * List all active conversations (for /status).
     */
    list() {
        return [...this.#conversations.values()].map(c => c.toStatus());
    }

    /**
     * Get conversation count.
     */
    get size() {
        return this.#conversations.size;
    }

    // ── Private ──────────────────────────────────────────────

    async #createConversation(scopeKey, ref, opts = {}) {
        const model = opts.model || this.#config.defaultModel || "standard";
        const mcpProfile = opts.mcpProfile || "owner";

        log.info(`Creating conversation for ${scopeKey} (model=${model}, profile=${mcpProfile})`);

        const inst = await this.#pool.acquire(scopeKey, { model, mcpProfile });

        // Try to resume previous session from ledger
        const previousSessionId = this.#ledger.get(scopeKey);
        if (previousSessionId) {
            try {
                await inst.acp.loadSession(previousSessionId);
                inst.sessionId = previousSessionId;
                log.info(`Resumed session ${previousSessionId} for ${scopeKey}`);
            } catch (err) {
                log.debug(`Could not resume session ${previousSessionId}: ${err.message} — using fresh session`);
            }
        }

        const conv = new Conversation({
            scopeKey, poolInstance: inst, telegram: this.#telegram, ref,
            config: this.#config,
        });
        this.#setupConvListeners(conv);
        this.#conversations.set(scopeKey, conv);

        // Record current sessionId for future resumption
        if (inst.sessionId) {
            this.#ledger.record(scopeKey, inst.sessionId);
        }

        return conv;
    }

    #setupConvListeners(conv) {
        conv.on("prompt_complete", ({ elapsed, scopeKey }) => {
            log.debug(`${scopeKey} prompt done in ${elapsed}ms`);

            // Auto-rename forum topic after first prompt (asynchronous, non-blocking)
            if (conv.promptCount === 1 && scopeKey.startsWith("forum:")) {
                this.#autoRenameTopic(conv).catch(err =>
                    log.debug(`Topic rename skipped: ${err.message}`)
                );
            }
        });

        conv.on("error", (err) => {
            log.error(`${conv.scopeKey} error: ${err.message}`);
        });

        conv.on("dead", ({ scopeKey }) => {
            log.warn(`${scopeKey} died — removing`);
            this.#conversations.delete(scopeKey);
        });

        conv.on("elicitation", (data) => {
            log.debug(`${conv.scopeKey} elicitation: ${data.message?.substring(0, 80)}`);
        });

        // Crash recovery: acquire new instance and retry
        conv.on("needs_new_instance", async ({ scopeKey, text, opts }) => {
            try {
                const model = conv.model || this.#config.defaultModel || "standard";
                const mcpProfile = conv.mcpProfile || "owner";
                const newInst = await this.#pool.acquire(scopeKey, { model, mcpProfile });
                conv.replaceInstance(newInst);
                log.info(`Crash recovery: ${scopeKey} got new instance ${newInst.id}`);
                // Retry the prompt
                await conv.receive(text, opts);
            } catch (err) {
                log.error(`Crash recovery failed for ${scopeKey}: ${err.message}`);
                conv.kill();
            }
        });
    }

    #releaseConversation(conv, { skipLedger = false } = {}) {
        // Persist sessionId before releasing (unless explicitly skipped, e.g. /new)
        if (!skipLedger) {
            const sid = conv.sessionId;
            if (sid && conv.scopeKey) {
                this.#ledger.record(conv.scopeKey, sid);
            }
        }
        conv.kill();
        this.#conversations.delete(conv.scopeKey);
        if (conv.instanceId) {
            this.#pool.release(conv.instanceId);
        }
        log.debug(`Conversation ${conv.scopeKey} released`);
    }

    /** Rename a forum topic based on the user's first message. */
    async #autoRenameTopic(conv) {
        const ref = conv.ref;
        if (!ref?.threadId) return;

        const firstPrompt = conv.rawUserText || "";
        let text = firstPrompt.replace(/\n/g, " ").trim();
        if (!text || text.startsWith("/")) return;

        // Pick icon based on keywords
        const { iconId, title } = topicTitle(text);

        const params = {
            chat_id: ref.chatId,
            message_thread_id: ref.threadId,
            name: title,
        };
        if (iconId) params.icon_custom_emoji_id = iconId;

        await this.#telegram.call("editForumTopic", params);
        log.debug(`Topic renamed: ${title}`);
    }

    #reapIdle() {
        const now = Date.now();
        for (const [key, conv] of this.#conversations) {
            if (conv.state === "idle" && conv.idleMs > this.#idleReapMs) {
                log.info(`Reaping idle conversation: ${key} (idle ${(conv.idleMs / 1000).toFixed(0)}s)`);
                this.#releaseConversation(conv);
            }
            if (conv.state === "dead") {
                this.#conversations.delete(key);
            }
        }
    }
}

// ── Topic Title & Icon ──────────────────────────────────────

const TOPIC_MAX_LEN = 28;

const TOPIC_ICONS = [
    { id: "5350554349074391003", kw: /\b(code|bug|fix|error|crash|debug|build|deploy|commit|push|merge|refactor|api)\b/i },
    { id: "5309832892262654231", kw: /\b(automat|script|routine|standing|cron|trigger|schedul)/i },
    { id: "5379748062124056162", kw: /\b(alert|alarm|warn|urgent|emergency|critical)/i },
    { id: "5312486108309757006", kw: /\b(home|house|room|light|lamp|switch|door|lock|window|curtain|blind|garage|bedroom|kitchen|living|bathroom)/i },
    { id: "5312016608254762256", kw: /\b(power|energy|electric|outlet|plug|charg|battery|watt)/i },
    { id: "5350305691942788490", kw: /\b(status|dashboard|report|analytic|metric|stat|graph)/i },
    { id: "5350424168615649565", kw: /\b(weather|forecast|rain|humid|temperature|climate|outdoor)/i },
    { id: "5373251851074415873", kw: /\b(note|remind|remember|memo|task|todo|list)\b/i },
    { id: "5309965701241379366", kw: /\b(search|find|look up|research|investigat|compar)/i },
    { id: "5312536423851630001", kw: /\b(idea|suggest|feature|what if|how about)/i },
    { id: "5237889595894414384", kw: /\b(think|reason|explain|why|understand|analy[zs]|opinion)/i },
    { id: "5348227245599105972", kw: /\b(work|meeting|calendar|appointment|office)/i },
    { id: "5350481781306958339", kw: /\b(learn|doc|guide|tutorial|how to|manual)/i },
    { id: "5417915203100613993", kw: null }, // 💬 default
];

const FILLER_RE = /^(hey|hi|hello|yo|ok|okay|please|can you|could you|i need you to|i want you to)\b\s*/i;

function topicTitle(text) {
    // Pick icon
    let iconId = TOPIC_ICONS[TOPIC_ICONS.length - 1].id;
    for (const { id, kw } of TOPIC_ICONS) {
        if (kw && kw.test(text)) { iconId = id; break; }
    }

    // Build short title — strip filler only if result is still meaningful
    let title = text.replace(/\s+/g, " ").trim();
    const stripped = title.replace(FILLER_RE, "").trim();
    if (stripped.length >= 10) title = stripped;

    if (title.length > TOPIC_MAX_LEN) {
        const cut = title.lastIndexOf(" ", TOPIC_MAX_LEN);
        title = title.slice(0, cut > 10 ? cut : TOPIC_MAX_LEN);
    }

    // Capitalize first letter
    if (title.length > 0) {
        title = title[0].toUpperCase() + title.slice(1);
    }

    return { iconId, title };
}
