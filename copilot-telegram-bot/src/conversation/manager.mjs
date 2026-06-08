// ============================================================
// ConversationManager — Routes messages to Conversations
// ============================================================
// Maps scopeKey → Conversation. Handles:
// - Routing incoming messages to the right conversation
// - Lazy creation on first message
// - Idle reaping (conversations inactive > timeout get destroyed)
// - SI (scheduled intelligence) conversation spawning

import { Conversation } from "./conversation.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("conv-mgr");
const REAP_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_REAP_MS = 30 * 60_000; // 30 min

export class ConversationManager {
    #conversations = new Map(); // scopeKey → Conversation
    #pool;                      // ACPPool
    #telegram;                  // TelegramClient
    #config;
    #reapInterval = null;
    #idleReapMs;

    constructor({ pool, telegram, config }) {
        this.#pool = pool;
        this.#telegram = telegram;
        this.#config = config;
        this.#idleReapMs = (config.poolIdleMinutes || 30) * 60_000;
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
            conv = await this.#createConversation(scopeKey, ref, opts);
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
     */
    async destroy(scopeKey) {
        const conv = this.#conversations.get(scopeKey);
        if (!conv) return false;
        this.#releaseConversation(conv);
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

        const conv = new Conversation({
            scopeKey, poolInstance: inst, telegram: this.#telegram, ref,
            config: this.#config,
        });
        this.#setupConvListeners(conv);
        this.#conversations.set(scopeKey, conv);
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

    #releaseConversation(conv) {
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

        // Use raw user text (before enrichment) for a meaningful title
        const firstPrompt = conv.rawUserText || "";
        let title = firstPrompt.replace(/\n/g, " ").trim();
        if (!title) return;

        // Skip commands
        if (title.startsWith("/")) return;

        // Truncate intelligently
        if (title.length > 64) {
            title = title.slice(0, 61) + "…";
        }
        title = `💬 ${title}`;

        await this.#telegram.call("editForumTopic", {
            chat_id: ref.chatId,
            message_thread_id: ref.threadId,
            name: title,
        });
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
