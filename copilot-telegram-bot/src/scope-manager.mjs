import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { ChatHistory } from "./history.mjs";
import { ScopeState } from "./scope-state.mjs";

export class ScopeManager {
    #scopes = new Map();
    #persistPath;
    #log;
    #dirty = false;
    #flushTimer = null;
    #forumChatIds = new Set();
    #defaultAllowAll = false;
    #maxDmScopes = 30;
    #maxGroupScopes = 20;
    #activeKey = null;

    constructor({ persistPath, defaultAllowAll = false, log }) {
        this.#persistPath = persistPath;
        this.#defaultAllowAll = !!defaultAllowAll;
        this.#log = typeof log === "function" ? log : console.log;
        this.#load();
    }

    /**
     * Resolve scope key from a conversation ref.
     * @param {{ chatId: string|number, userId: string|number, threadId?: string|number|null, chatType?: string|null }} ref
     */
    resolveKey(ref) {
        if (ref.threadId && this.isForumChat(ref.chatId)) {
            return `forum:${ref.chatId}:${ref.threadId}`;
        }
        if (ref.chatType === "group" || ref.chatType === "supergroup") {
            return `group:${ref.chatId}`;
        }
        return `dm:${ref.userId}`;
    }

    /**
     * Get or create a scope.
     * @param {string} scopeKey
     * @returns {ScopeState}
     */
    getOrCreate(scopeKey) {
        let scope = this.#scopes.get(scopeKey);
        if (scope) {
            this.#ensureHistory(scope);
            scope.touch();
            return scope;
        }

        this.#evictIfNeeded(scopeKey);

        scope = new ScopeState(scopeKey);
        scope.allowAll = this.#defaultAllowAll;
        this.#ensureHistory(scope);
        this.#scopes.set(scopeKey, scope);
        this.#markDirty();
        return scope;
    }

    /**
     * Get scope without creating.
     * @param {string} scopeKey
     * @returns {ScopeState|null}
     */
    get(scopeKey) {
        const scope = this.#scopes.get(scopeKey) || null;
        if (scope) this.#ensureHistory(scope);
        return scope;
    }

    /**
     * Delete a scope.
     * @param {string} scopeKey
     */
    delete(scopeKey) {
        const scope = this.#scopes.get(scopeKey);
        if (!scope) return false;

        scope.reset();
        this.#scopes.delete(scopeKey);
        if (this.#activeKey === scopeKey) {
            this.#activeKey = null;
        }
        this.#markDirty();
        return true;
    }

    /**
     * Delete all scopes for a given chat ID.
     * @param {string|number} chatId
     */
    deleteByChat(chatId) {
        const chatToken = String(chatId);
        let removed = 0;

        for (const [key, scope] of this.#scopes) {
            if (key !== `group:${chatToken}` && !key.startsWith(`forum:${chatToken}:`)) continue;
            scope.reset();
            this.#scopes.delete(key);
            if (this.#activeKey === key) {
                this.#activeKey = null;
            }
            removed++;
        }

        const forumFlagRemoved = this.#forumChatIds.delete(chatToken);
        if (removed > 0 || forumFlagRemoved) {
            this.#markDirty();
            this.#log(`Deleted ${removed} scope(s) for chat ${chatToken}${forumFlagRemoved ? " and cleared forum state" : ""}`);
        }
        return removed;
    }

    /**
     * Delete DM scope for a user.
     * @param {string|number} userId
     */
    deleteByUser(userId) {
        const removed = this.delete(`dm:${userId}`);
        if (removed) {
            this.#log(`Deleted DM scope for user ${userId}`);
        }
        return removed;
    }

    setForumChat(chatId) {
        this.#forumChatIds.add(String(chatId));
        this.#markDirty();
    }

    /**
     * @param {string|number} chatId
     * @returns {boolean}
     */
    isForumChat(chatId) {
        return this.#forumChatIds.has(String(chatId));
    }

    /**
     * Check if this is the management topic (General) in a forum.
     * @param {{ chatId: string|number, threadId?: string|number|null }} ref
     * @returns {boolean}
     */
    isManagementTopic(ref) {
        if (!this.isForumChat(ref.chatId)) return false;
        return !ref.threadId || ref.threadId === ref.chatId;
    }

    get activeScope() {
        return this.#activeKey ? this.#scopes.get(this.#activeKey) || null : null;
    }

    /**
     * @param {string} scopeKey
     */
    setActive(scopeKey) {
        this.#activeKey = scopeKey;
    }

    clearActive() {
        this.#activeKey = null;
    }

    /**
     * @param {string} scopeKey
     * @returns {boolean}
     */
    needsSwitch(scopeKey) {
        return this.#activeKey !== scopeKey;
    }

    #evictIfNeeded(newKey) {
        const pool = newKey.startsWith("dm:") ? "dm" : "group";
        const limit = pool === "dm" ? this.#maxDmScopes : this.#maxGroupScopes;

        let count = 0;
        for (const key of this.#scopes.keys()) {
            if (pool === "dm" && key.startsWith("dm:")) count++;
            else if (pool !== "dm" && !key.startsWith("dm:")) count++;
        }

        if (count < limit) return;

        let oldest = null;
        let oldestTime = Infinity;
        for (const [key, scope] of this.#scopes) {
            const inPool = pool === "dm" ? key.startsWith("dm:") : !key.startsWith("dm:");
            if (!inPool || key === this.#activeKey) continue;
            if (scope.lastActivity < oldestTime) {
                oldest = key;
                oldestTime = scope.lastActivity;
            }
        }

        if (!oldest) return;

        this.#log(`Evicting LRU scope: ${oldest} (last active: ${new Date(oldestTime).toISOString()})`);
        const scope = this.#scopes.get(oldest);
        scope.reset();
        this.#scopes.delete(oldest);
        if (this.#activeKey === oldest) {
            this.#activeKey = null;
        }
        this.#markDirty();
    }

    #markDirty() {
        this.#dirty = true;
        if (this.#flushTimer) return;

        this.#flushTimer = setTimeout(() => this.flush(), 30000);
        this.#flushTimer.unref?.();
    }

    flush() {
        if (this.#flushTimer) {
            clearTimeout(this.#flushTimer);
            this.#flushTimer = null;
        }
        if (!this.#dirty) return;

        try {
            const data = {
                scopes: Array.from(this.#scopes.values()).map(scope => scope.toJSON()),
                forumChatIds: Array.from(this.#forumChatIds),
            };
            const tmp = this.#persistPath + ".tmp";
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, this.#persistPath);
            this.#dirty = false;
        } catch (err) {
            this.#log(`Scope persist error: ${err.message}`);
        }
    }

    #load() {
        try {
            if (!existsSync(this.#persistPath)) return;
            const data = JSON.parse(readFileSync(this.#persistPath, "utf8"));

            if (Array.isArray(data.forumChatIds)) {
                for (const id of data.forumChatIds) {
                    this.#forumChatIds.add(String(id));
                }
            }

            if (Array.isArray(data.scopes)) {
                for (const entry of data.scopes) {
                    const scope = ScopeState.fromJSON(entry);
                    scope.allowAll = scope.allowAll || this.#defaultAllowAll;
                    this.#ensureHistory(scope);
                    this.#scopes.set(scope.key, scope);
                }
            }

            this.#log(`Loaded ${this.#scopes.size} scopes from disk`);
        } catch (err) {
            this.#log(`Scope load error: ${err.message}`);
        }
    }

    #ensureHistory(scope) {
        if (!scope.history) {
            scope.history = new ChatHistory(50);
        }
        return scope;
    }

    get size() {
        return this.#scopes.size;
    }

    stats() {
        let dm = 0;
        let group = 0;
        let forum = 0;

        for (const key of this.#scopes.keys()) {
            if (key.startsWith("dm:")) dm++;
            else if (key.startsWith("group:")) group++;
            else if (key.startsWith("forum:")) forum++;
        }

        return { dm, group, forum, total: this.#scopes.size };
    }

    list() {
        return Array.from(this.#scopes.values()).map(scope => ({
            key: scope.key,
            sessionId: scope.sessionId,
            model: scope.model,
            mode: scope.mode,
            lastActivity: scope.lastActivity,
            createdAt: scope.createdAt,
        }));
    }

    shutdown() {
        this.flush();
        if (this.#flushTimer) {
            clearTimeout(this.#flushTimer);
            this.#flushTimer = null;
        }
    }
}
