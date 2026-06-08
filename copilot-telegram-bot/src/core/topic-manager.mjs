// ============================================================
// TopicManager — DM Topic lifecycle for private chat threads
// ============================================================
// Creates and persists operator-curated topics in private chats.
// Provides name→threadId resolution for routing (SI bridge, etc.).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("topic-mgr");
const PERSIST_PATH = "/data/dm-topics.json";

export class TopicManager {
    #telegram;
    #config;
    /** @type {Map<string, Array<{name: string, threadId: number}>>} chatId → topics */
    #topics = new Map();
    #operatorThreadIds = new Set(); // thread IDs we created (never auto-rename)

    constructor({ telegram, config }) {
        this.#telegram = telegram;
        this.#config = config;
        this.#load();
    }

    // ── Public API ───────────────────────────────────────────

    /**
     * Ensure all configured topics exist for a given chat.
     * Creates missing topics and persists the mapping.
     * @param {number|string} chatId
     */
    async ensureTopics(chatId) {
        const chatKey = String(chatId);
        const desired = this.#config.dmTopics || [];
        if (desired.length === 0) return;

        const existing = this.#topics.get(chatKey) || [];
        const existingNames = new Set(existing.map(t => t.name));
        let created = 0;

        for (const name of desired) {
            if (existingNames.has(name)) continue;

            try {
                const result = await this.#telegram.call("createForumTopic", {
                    chat_id: chatId,
                    name,
                });
                const threadId = result?.message_thread_id;
                if (threadId) {
                    existing.push({ name, threadId });
                    this.#operatorThreadIds.add(threadId);
                    created++;
                    log.info(`Created topic "${name}" → thread ${threadId} in chat ${chatKey}`);
                }
            } catch (err) {
                log.warn(`Failed to create topic "${name}" in chat ${chatKey}: ${err.message}`);
            }
        }

        if (created > 0) {
            this.#topics.set(chatKey, existing);
            this.#save();
        }
    }

    /**
     * Get all topics for a chat.
     * @param {number|string} chatId
     * @returns {Array<{name: string, threadId: number}>|null}
     */
    getTopics(chatId) {
        return this.#topics.get(String(chatId)) || null;
    }

    /**
     * Resolve a topic name to a threadId.
     * @param {number|string} chatId
     * @param {string} topicName — exact or partial match
     * @returns {number|null} threadId or null
     */
    resolveThreadId(chatId, topicName) {
        const topics = this.#topics.get(String(chatId));
        if (!topics) return null;

        // Exact match first
        const exact = topics.find(t => t.name === topicName);
        if (exact) return exact.threadId;

        // Case-insensitive match
        const lower = topicName.toLowerCase();
        const ci = topics.find(t => t.name.toLowerCase() === lower);
        if (ci) return ci.threadId;

        // Partial match (topic name contains search term, stripping emoji)
        const stripEmoji = (s) => s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();
        const stripped = stripEmoji(lower);
        if (stripped) {
            const partial = topics.find(t =>
                stripEmoji(t.name.toLowerCase()).includes(stripped)
            );
            if (partial) return partial.threadId;
        }

        return null;
    }

    /**
     * Resolve a threadId to its topic name.
     * @param {number|string} chatId
     * @param {number} threadId
     * @returns {string|null}
     */
    resolveTopicName(chatId, threadId) {
        const topics = this.#topics.get(String(chatId));
        if (!topics) return null;
        const topic = topics.find(t => t.threadId === threadId);
        return topic?.name || null;
    }

    /**
     * Check if a threadId is an operator-curated topic (not user-created).
     * @param {number} threadId
     * @returns {boolean}
     */
    isOperatorTopic(threadId) {
        return this.#operatorThreadIds.has(threadId);
    }

    /**
     * Register an ad-hoc (user-created) topic.
     * @param {number|string} chatId
     * @param {string} name
     * @param {number} threadId
     */
    registerTopic(chatId, name, threadId) {
        const chatKey = String(chatId);
        const existing = this.#topics.get(chatKey) || [];
        if (existing.some(t => t.threadId === threadId)) return;
        existing.push({ name, threadId });
        this.#topics.set(chatKey, existing);
        this.#save();
    }

    /**
     * Rename a topic (e.g., auto-rename after first exchange).
     * Only renames non-operator topics.
     * @param {number|string} chatId
     * @param {number} threadId
     * @param {string} newName
     */
    async renameTopic(chatId, threadId, newName) {
        if (this.isOperatorTopic(threadId)) return false;

        const chatKey = String(chatId);
        const topics = this.#topics.get(chatKey);
        if (!topics) return false;

        const topic = topics.find(t => t.threadId === threadId);
        if (!topic) return false;

        try {
            await this.#telegram.call("editForumTopic", {
                chat_id: chatId,
                message_thread_id: threadId,
                name: newName.slice(0, 128),
            });
            topic.name = newName.slice(0, 128);
            this.#save();
            return true;
        } catch (err) {
            log.warn(`Failed to rename topic ${threadId}: ${err.message}`);
            return false;
        }
    }

    // ── Persistence ──────────────────────────────────────────

    #load() {
        try {
            if (!existsSync(PERSIST_PATH)) return;
            const data = JSON.parse(readFileSync(PERSIST_PATH, "utf8"));

            if (data && typeof data === "object") {
                for (const [chatId, topics] of Object.entries(data)) {
                    if (Array.isArray(topics)) {
                        this.#topics.set(chatId, topics);
                        // Rebuild operator set from configured topic names
                        const configured = new Set(this.#config.dmTopics || []);
                        for (const t of topics) {
                            if (configured.has(t.name)) {
                                this.#operatorThreadIds.add(t.threadId);
                            }
                        }
                    }
                }
                log.info(`Loaded ${this.#topics.size} chat(s) with DM topics from disk`);
            }
        } catch (err) {
            log.error(`Topic load error: ${err.message}`);
        }
    }

    #save() {
        try {
            const data = {};
            for (const [chatId, topics] of this.#topics) {
                data[chatId] = topics;
            }
            const tmp = PERSIST_PATH + ".tmp";
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, PERSIST_PATH);
        } catch (err) {
            log.error(`Topic save error: ${err.message}`);
        }
    }
}
