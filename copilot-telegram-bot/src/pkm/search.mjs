// ============================================================
// PkmSearch — Search engine for PKM system
// ============================================================
// FTS5 search, buffer search, entity boost, conditional
// prefetch, and deep recall strategy.

import { createLogger } from "../logger.mjs";

const log = createLogger("pkm-search");

// ── Prefetch trigger patterns ──────────────────────────────

const USER_RECALL_PATTERNS = [
    /\b(?:remember|recall|when did|where was|what was|that time|last time)\b/i,
    /\b(?:did I|have I|was there|who was)\b.*\b(?:before|ago|earlier|once)\b/i,
    /\b(?:what did|where did|when did)\b.*\b(?:I|we)\b/i,
    /\b(?:that (?:one|place|restaurant|hotel|person|meeting|day|night))\b/i,
];

const AGENT_OPS_PATTERNS = [
    /\b(?:entity|sensor|light|switch|automation|addon|add-on)\b/i,
    /\b(?:bug|issue|error|broken|fix|wrong|crash)\b/i,
    /\b(?:version|deploy|update|rollback|upgrade)\b/i,
    /\b(?:last time|previously|before|remember when)\b/i,
];

// ── PkmSearch class ────────────────────────────────────────

export class PkmSearch {
    #store;
    #security;

    constructor(store, security) {
        this.#store = store;
        this.#security = security;
    }

    // ── Main search ────────────────────────────────────────

    /**
     * Search memories for a user.
     * Combines buffer search, activation-weighted FTS5 search, optional topic/entity
     * filters, and optional context expansion.
     */
    search(query, {
        userId,
        scope = "user",
        scopeId,
        type,
        dateFrom,
        dateTo,
        tags,
        limit = 7,
        queries,
        topic,
        entity,
        expandContext: doExpand = false,
    } = {}) {
        // Rate limit check
        if (!this.#security.checkSearchRate(userId)) {
            log.warn(`Search rate limit exceeded for user ${userId}`);
            return { results: [], expanded: [], rateLimited: true };
        }

        // Multi-query support: run each query, merge + deduplicate
        const queryList = queries && Array.isArray(queries) && queries.length > 0
            ? queries.slice(0, 5)
            : query ? [query] : [];

        if (queryList.length === 0) return { results: [], expanded: [], rateLimited: false };

        const safeLimit = Number(limit) || 7;
        const results = [];
        let topicNoteIds = null;
        let entityNoteIds = null;

        if (topic) {
            let topicId = topic;
            if (!topic.match(/^[0-9a-f-]{36}$/i)) {
                const resolved = this.#store.resolveTopicName(userId, topic);
                topicId = resolved?.id;
            }
            if (topicId) {
                topicNoteIds = new Set();
                const topicNotes = this.#store.db.prepare(
                    `SELECT id FROM notes WHERE primary_topic_id = ? AND user_id = ?
                     UNION
                     SELECT nt.note_id AS id FROM note_topics nt
                       JOIN notes n ON n.id = nt.note_id
                       WHERE nt.topic_id = ? AND n.user_id = ?`
                ).all(topicId, userId, topicId, userId);
                for (const row of topicNotes) topicNoteIds.add(row.id);
            }
        }

        if (entity) {
            const entityResults = this.#store.searchEntities(userId, entity, { limit: 5 });
            if (entityResults.length > 0) {
                entityNoteIds = new Set();
                const entityStmt = this.#store.db.prepare(
                    `SELECT en.note_id FROM entity_notes en
                     JOIN notes n ON n.id = en.note_id
                     WHERE en.entity_id = ? AND n.user_id = ?`
                );
                for (const ent of entityResults) {
                    const linkedNotes = entityStmt.all(ent.id, userId);
                    for (const row of linkedNotes) entityNoteIds.add(row.note_id);
                }
            }
        }

        // 1. Buffer search (using first query)
        const bufferResults = this.#searchBuffer(queryList[0], userId);
        results.push(...bufferResults);

        // 2. FTS5 search (for each query in list)
        for (const q of queryList) {
            let ftsResults = this.#store.searchNotes(q, {
                userId, scope, scopeId, type, dateFrom, dateTo, tags, limit: safeLimit + 5,
            });

            if (topicNoteIds) {
                ftsResults = ftsResults.filter(n => topicNoteIds.has(n.id));
            }

            if (entityNoteIds) {
                ftsResults = ftsResults.filter(n => entityNoteIds.has(n.id));
            }

            for (const note of ftsResults) {
                const activation = Number(note.activation) || this.#store.computeActivation(note);
                note.finalScore = Math.abs(note.bm25_score) * activation * (note.confidence || 0.8);
            }

            ftsResults.sort((a, b) => b.finalScore - a.finalScore);
            results.push(...ftsResults);
        }

        // Deduplicate by ID
        const seen = new Set();
        const deduped = results.filter(r => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        });

        // Context expansion (off by default)
        let expandedResults = [];
        if (doExpand) {
            expandedResults = this.expandContext(deduped, userId, 10);
        }

        // Audit log
        this.#store.logEvent(null, userId, "search", {
            query: queryList.join(" | ").substring(0, 200),
            scope,
            resultCount: deduped.length,
            expandedCount: expandedResults.length,
        });

        return {
            results: deduped.slice(0, safeLimit),
            expanded: expandedResults,
            rateLimited: false,
        };
    }

    /** Search current open conversation windows (buffer search) */
    #searchBuffer(query, userId) {
        const windows = this.#store.db.prepare(
            `SELECT * FROM conversation_windows
             WHERE user_id = ? AND extracted = 0 AND closed_at IS NULL AND messages IS NOT NULL`
        ).all(userId);

        const queryLower = query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
        const results = [];

        for (const win of windows) {
            try {
                const messages = JSON.parse(win.messages || "[]");
                for (const msg of messages) {
                    if (!msg.text) continue;
                    const textLower = msg.text.toLowerCase();
                    const matchScore = queryTerms.filter(t => textLower.includes(t)).length;
                    if (matchScore >= Math.max(1, queryTerms.length * 0.4)) {
                        results.push({
                            id: `buffer-${win.id}-${messages.indexOf(msg)}`,
                            title: "(from current conversation)",
                            content: msg.text,
                            type: "buffer",
                            created_at: msg.timestamp || win.last_message_at,
                            confidence: 1.0,
                            finalScore: matchScore * 2, // boost buffer results
                            scope: "user",
                            tags: "[]",
                        });
                    }
                }
            } catch { /* ignore parse errors */ }
        }

        return results;
    }

    // ── Agent search ───────────────────────────────────────

    /**
     * Search agent's own memory.
     * Scoped to agent only, results never shown to users.
     */
    searchAgent(query, { type, limit = 7 } = {}) {
        return this.#store.searchNotes(query, {
            userId: "__agent__",
            scope: "agent",
            type,
            limit,
        });
    }

    // ── Conditional prefetch ───────────────────────────────

    /**
     * Check if a message should trigger user memory prefetch.
     * Returns matching memories or null.
     */
    userPrefetch(message, userId, chatType = "dm") {
        // NEVER prefetch user memories in group context
        if (chatType === "group" || chatType === "supergroup") return null;

        // Check if message looks like a recall query
        if (!USER_RECALL_PATTERNS.some(p => p.test(message))) return null;

        // Search user memories
        const { results } = this.search(message, { userId, scope: "user", limit: 3 });
        if (results.length === 0) return null;

        log.info(`User prefetch triggered: ${results.length} results for "${message.substring(0, 50)}"`);
        return results;
    }

    /**
     * Check if a message should trigger agent memory prefetch.
     * Returns matching memories or null.
     */
    agentPrefetch(message) {
        // Check if message relates to operations/system
        if (!AGENT_OPS_PATTERNS.some(p => p.test(message))) return null;

        const results = this.searchAgent(message, { limit: 3 });
        if (results.length === 0) return null;

        log.info(`Agent prefetch triggered: ${results.length} results for "${message.substring(0, 50)}"`);
        return results;
    }

    expandContext(results, userId, limit = 10) {
        if (!results || results.length === 0) return [];

        const expanded = [];
        const originalIds = new Set(results.map(r => r.id));
        const seen = new Set(originalIds);

        // Take top 3 results, find their neighbors
        for (const result of results.slice(0, 3)) {
            if (result.id?.startsWith("buffer-")) continue; // skip buffer results
            try {
                const neighbors = this.#store.getNeighbors(result.id, userId, { limit: 5 });
                for (const neighbor of neighbors) {
                    if (!seen.has(neighbor.id)) {
                        seen.add(neighbor.id);
                        expanded.push({
                            ...neighbor,
                            _expandedFrom: result.id,
                            _isExpanded: true,
                        });
                    }
                }
            } catch {
                // skip if getNeighbors fails (e.g., buffer result)
            }
        }

        // Sort by activation, limit
        return expanded
            .sort((a, b) => (Number(b.activation) || 0) - (Number(a.activation) || 0))
            .slice(0, limit);
    }

    // ── Deep recall strategy ───────────────────────────────

    /**
     * Progressive search strategy when initial search returns few results.
     * Used by the agent via the deep recall skill.
     * @param {string} query - Original search query
     * @param {object} opts - {userId, scope, limit}
     * @returns {Array} Enhanced results from multiple search strategies
     */
    deepRecall(query, { userId, scope = "user", limit = 7 } = {}) {
        const allResults = [];
        const seen = new Set();

        const addResults = (results) => {
            for (const r of results) {
                if (!seen.has(r.id)) {
                    seen.add(r.id);
                    allResults.push(r);
                }
            }
        };

        // Strategy 1: Original query
        const initial = this.search(query, { userId, scope, limit });
        addResults(initial.results);

        if (allResults.length >= limit) return allResults.slice(0, limit);

        // Strategy 2: Individual terms (broader)
        const terms = query.split(/\s+/).filter(t => t.length > 2);
        for (const term of terms.slice(0, 3)) {
            const r = this.search(term, { userId, scope, limit: 3 });
            addResults(r.results);
        }

        if (allResults.length >= limit) return allResults.slice(0, limit);

        // Strategy 3: Entity search
        const entities = this.#findEntities(query, userId);
        for (const entity of entities) {
            const linkedNotes = this.#store.db.prepare(
                `SELECT n.* FROM notes n
                 JOIN entity_notes en ON en.note_id = n.id
                 WHERE en.entity_id = ? AND n.user_id = ? AND n.scope = ? AND n.valid_to IS NULL
                 LIMIT 5`
            ).all(entity.id, userId, scope);
            for (const note of linkedNotes) {
                note.finalScore = 0.7; // moderate boost
            }
            addResults(linkedNotes);
        }

        if (allResults.length >= limit) return allResults.slice(0, limit);

        // Strategy 4: Type-based if category detected
        const typeGuess = this.#guessType(query);
        if (typeGuess) {
            const r = this.search(query, { userId, scope, type: typeGuess, limit: 5 });
            addResults(r.results);
        }

        return allResults.slice(0, limit);
    }

    /** Find entities matching query terms */
    #findEntities(query, userId) {
        const terms = query.split(/\s+/).filter(t => t.length > 2);
        const results = [];
        for (const term of terms) {
            const entities = this.#store.db.prepare(
                `SELECT * FROM entities WHERE user_id = ? AND (name LIKE ? OR aliases LIKE ?)`
            ).all(userId, `%${term}%`, `%${term}%`);
            results.push(...entities);
        }
        return results;
    }

    /** Guess note type from query content */
    #guessType(query) {
        const q = query.toLowerCase();
        if (/\b(?:ate|food|restaurant|meal|dinner|lunch|breakfast|dish|cook)\b/.test(q)) return "event";
        if (/\b(?:meet|meeting|met with|discussed|call with)\b/.test(q)) return "meeting";
        if (/\b(?:prefer|like|hate|love|favourite|favorite)\b/.test(q)) return "preference";
        if (/\b(?:bp|weight|sleep|health|exercise|workout|run|gym)\b/.test(q)) return "health";
        return null;
    }

    // ── Prefetch pattern checks (exported for testing) ─────

    static isRecallQuery(text) {
        return USER_RECALL_PATTERNS.some(p => p.test(text));
    }

    static isOpsQuery(text) {
        return AGENT_OPS_PATTERNS.some(p => p.test(text));
    }
}

export default PkmSearch;
