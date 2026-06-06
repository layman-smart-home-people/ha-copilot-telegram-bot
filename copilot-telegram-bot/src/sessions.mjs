// ============================================================
// SessionManager — Forum Topic ↔ ACP Session Mapping
// ============================================================
// Maps Telegram forum topics to ACP sessions. Manages lifecycle
// of topics and session switching.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { refKey } from "./transport.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger("session");

export class SessionManager {
    #persistPath;
    #sessions = new Map();   // "chatId:threadId" → SessionEntry
    #activeKey = null;       // Currently active session key
    #managementThreadId = null;
    #forumChatId = null;     // The supergroup chat ID for forum mode

    /**
     * @typedef {Object} SessionEntry
     * @property {string} sessionId   - ACP session ID
     * @property {string} title       - Human-readable title
     * @property {string} createdAt   - ISO timestamp
     * @property {boolean} active     - Whether the session is active (not closed)
     * @property {boolean} createdByBot - Whether the bot created this topic
     * @property {number} chatId
     * @property {number|null} threadId
     */

    constructor({ persistPath }) {
        this.#persistPath = persistPath;
        this.#load();
    }

    get activeKey() { return this.#activeKey; }
    get forumChatId() { return this.#forumChatId; }
    get managementThreadId() { return this.#managementThreadId; }

    /**
     * Set the forum chat ID (supergroup with topics).
     */
    setForumChat(chatId, managementThreadId = null) {
        this.#forumChatId = chatId;
        this.#managementThreadId = managementThreadId;
        this.#save();
    }

    /**
     * Check if a ref points to the management topic.
     */
    isManagementTopic(ref) {
        if (!this.#forumChatId) return false;
        if (ref.chatId !== this.#forumChatId) return false;
        // General topic: threadId is null/undefined or matches configured management thread
        if (!ref.threadId) return true;
        if (this.#managementThreadId && ref.threadId === this.#managementThreadId) return true;
        return false;
    }

    /**
     * Check if this is a forum chat message.
     */
    isForumChat(chatId) {
        return this.#forumChatId != null && chatId === this.#forumChatId;
    }

    /**
     * Register a new session for a topic.
     */
    register(ref, sessionId, title, createdByBot = true) {
        const key = refKey(ref);
        this.#sessions.set(key, {
            sessionId,
            title,
            createdAt: new Date().toISOString(),
            active: true,
            createdByBot,
            chatId: ref.chatId,
            threadId: ref.threadId,
        });
        this.#activeKey = key;
        this.#save();
        log.info(`Registered ${key} → ${sessionId} "${title}"`);
    }

    /**
     * Get session entry for a ref.
     */
    getSession(ref) {
        return this.#sessions.get(refKey(ref)) || null;
    }

    /**
     * Get session by key string.
     */
    getByKey(key) {
        return this.#sessions.get(key) || null;
    }

    /**
     * Get the currently active session key.
     */
    getActiveSession() {
        if (!this.#activeKey) return null;
        return this.#sessions.get(this.#activeKey) || null;
    }

    /**
     * Check if a ref needs a session switch (different from active).
     */
    needsSwitch(ref) {
        const key = refKey(ref);
        const session = this.#sessions.get(key);
        if (!session) return false; // No session for this ref
        return this.#activeKey !== key;
    }

    /**
     * Set the active session to a given ref.
     */
    setActive(ref) {
        const key = refKey(ref);
        this.#activeKey = key;
        this.#save();
    }

    /**
     * Mark a session as inactive (closed).
     */
    closeSession(ref) {
        const key = refKey(ref);
        const session = this.#sessions.get(key);
        if (session) {
            session.active = false;
            if (this.#activeKey === key) this.#activeKey = null;
            this.#save();
            log.info(`Closed ${key}`);
        }
    }

    /**
     * Remove a session mapping entirely.
     */
    deleteSession(ref) {
        const key = refKey(ref);
        if (this.#activeKey === key) this.#activeKey = null;
        this.#sessions.delete(key);
        this.#save();
        log.info(`Deleted ${key}`);
    }

    /**
     * List all sessions.
     */
    listSessions() {
        return Array.from(this.#sessions.entries()).map(([key, entry]) => ({
            key,
            ...entry,
            isCurrent: key === this.#activeKey,
        }));
    }

    /**
     * List active sessions only.
     */
    listActiveSessions() {
        return this.listSessions().filter(s => s.active);
    }

    /**
     * Reconcile sessions on startup — remove entries for topics that no longer exist.
     * Called with a list of valid thread IDs from the forum.
     */
    reconcile(validThreadIds) {
        const validSet = new Set(validThreadIds.map(Number));
        let removed = 0;
        for (const [key, entry] of this.#sessions) {
            if (entry.threadId && !validSet.has(entry.threadId)) {
                this.#sessions.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            log.info(`Reconciled: removed ${removed} stale session(s)`);
            this.#save();
        }
    }

    // --- Persistence ---

    #load() {
        if (!existsSync(this.#persistPath)) return;
        try {
            const data = JSON.parse(readFileSync(this.#persistPath, "utf-8"));
            if (data.version !== 1) {
                log.warn(`Unknown persistence version: ${data.version}`);
                return;
            }
            this.#forumChatId = data.forumChatId || null;
            this.#managementThreadId = data.managementThreadId || null;
            this.#activeKey = data.activeKey || null;
            for (const [key, entry] of Object.entries(data.sessions || {})) {
                this.#sessions.set(key, entry);
            }
            log.info(`Loaded ${this.#sessions.size} session(s), forum chat: ${this.#forumChatId || "none"}`);
        } catch (err) {
            log.error(`Failed to load ${this.#persistPath}: ${err.message}`);
        }
    }

    #save() {
        const data = {
            version: 1,
            forumChatId: this.#forumChatId,
            managementThreadId: this.#managementThreadId,
            activeKey: this.#activeKey,
            sessions: Object.fromEntries(this.#sessions),
        };
        const tmp = this.#persistPath + ".tmp";
        try {
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, this.#persistPath);
        } catch (err) {
            log.error(`Failed to save: ${err.message}`);
        }
    }
}
