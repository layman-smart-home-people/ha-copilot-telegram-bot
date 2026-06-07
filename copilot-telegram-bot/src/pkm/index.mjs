// ============================================================
// PkmManager — Main coordinator for the PKM system
// ============================================================
// Initializes store, security, extractor, and search modules.
// Provides REST API handler for MCP server calls.
// Manages lifecycle (start, stop, maintenance timer).

import { PkmStore } from "./store.mjs";
import { PkmSecurity } from "./security.mjs";
import { PkmExtractor } from "./extractor.mjs";
import { PkmSearch } from "./search.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("pkm");

export class PkmManager {
    #store;
    #security;
    #extractor;
    #search;
    #dbPath;
    #agentDir;
    #llmCall;
    #routes;
    #prefixRoutes;

    constructor({ dbPath, agentDir, llmCall }) {
        this.#dbPath = dbPath || "/data/pkm.db";
        this.#agentDir = agentDir || "/config/copilot-telegram-bot";
        this.#llmCall = llmCall || null;
        this.#routes = new Map();
        this.#prefixRoutes = [];
    }

    get store() { return this.#store; }
    get search() { return this.#search; }
    get extractor() { return this.#extractor; }
    get security() { return this.#security; }

    // ── Lifecycle ──────────────────────────────────────────

    start() {
        log.info("Starting PKM system...");

        this.#security = new PkmSecurity();
        this.#store = new PkmStore(this.#dbPath);
        this.#store.open();
        this.#extractor = new PkmExtractor(this.#store, this.#security);
        this.#search = new PkmSearch(this.#store, this.#security);

        // Bootstrap agent memory from MEMORY.md if first run
        this.#store.bootstrapAgentMemory(this.#agentDir);

        // Start background maintenance timer
        if (this.#llmCall) {
            this.#extractor.startTimer(this.#llmCall);
        }

        this.#setupRoutes();

        log.info("PKM system started");
        return this;
    }

    stop() {
        log.info("Stopping PKM system...");
        this.#extractor?.stopTimer();
        this.#store?.close();
        log.info("PKM system stopped");
    }

    setLlmCall(fn) {
        this.#llmCall = fn;
        // Restart timer with LLM function
        this.#extractor?.stopTimer();
        if (fn) {
            this.#extractor?.startTimer(fn);
        }
    }

    // ── Message tracking (called by bridge) ────────────────

    trackMessage(userId, chatId, text, role = "user") {
        return this.#extractor?.trackMessage(userId, chatId, text, role);
    }

    // ── Prefetch (called by prompt builder) ────────────────

    getUserPrefetch(message, userId, chatType = "dm") {
        const results = this.#search?.userPrefetch(message, userId, chatType);
        if (!results) return null;
        return this.#security.frameRetrievedMemories(results, "user_pkm");
    }

    getAgentPrefetch(message) {
        const results = this.#search?.agentPrefetch(message);
        if (!results) return null;
        return this.#security.frameRetrievedMemories(results, "agent_pkm");
    }

    // ── System hint (called by prompt builder) ─────────────

    getSystemHint(userId) {
        if (!this.#store?.isEnabled(userId)) return null;
        const count = this.#store.getNoteCount(userId);
        return `PKM: ${count} memories stored. Use pkm_navigate({action:"map"}) to see the topic tree overview before searching. ` +
            `Use pkm_search when the user asks about past events, preferences, or personal facts. ` +
            `Use pkm_memory({action:"write"}) to save new memories. ` +
            `Proactively remember important preferences, decisions, and facts — don't wait to be asked.`;
    }

    getAgentHint() {
        const count = this.#store?.getNoteCount("__agent__") || 0;
        if (count === 0) return null;
        return `You have ${count} notes in your private memory. ` +
            `Use pkm_search({scope:"agent"}) to search, pkm_memory({action:"write", scope:"agent"}) to write, ` +
            `pkm_memory({action:"update", scope:"agent"}) to update. ` +
            `Your memories make you smarter over time — maintain them actively.`;
    }

    // ── REST API handler ───────────────────────────────────

    #setupRoutes() {
        const requireUser = (ctx) => {
            if (!ctx?.userId) throw Object.assign(new Error("No user context"), { status: 401 });
            if (!this.#store.isEnabled(ctx.userId)) throw Object.assign(new Error("PKM not enabled"), { status: 403 });
        };

        this.#routes = new Map([
            ["POST:/api/pkm/search", (body = {}, ctx = {}) => {
                requireUser(ctx);

                let scope = body.scope || "user";
                let scopeId;

                if (scope === "household") {
                    const settings = this.#store.getSettings(ctx.userId);
                    if (!settings?.household_id || !this.#store.isHouseholdMember(ctx.userId, settings.household_id)) {
                        return { status: 403, data: { error: "Not a household member" } };
                    }
                    scopeId = settings.household_id;
                } else if (scope !== "user") {
                    return { status: 400, data: { error: "Invalid scope" } };
                } else if ((ctx.chatType === "group" || ctx.chatType === "supergroup") && !body.scope) {
                    const settings = this.#store.getSettings(ctx.userId);
                    if (settings?.household_id && this.#store.isHouseholdMember(ctx.userId, settings.household_id)) {
                        scope = "household";
                        scopeId = settings.household_id;
                    }
                }

                const limit = Number(body.limit) || 7;
                let { results } = this.#search.search(body.query, {
                    userId: ctx.userId,
                    scope,
                    scopeId,
                    type: body.type,
                    dateFrom: body.date_from,
                    dateTo: body.date_to,
                    tags: body.tags,
                    limit: body.topic ? Math.max(limit * 3, limit + 10) : limit,
                });

                if (body.topic) {
                    const topic = this.#store.resolveTopicName(ctx.userId, body.topic);
                    if (!topic) return { status: 200, data: { results: [] } };
                    const topicNotes = this.#store.browseTopicNotes(topic.id, ctx.userId, {
                        sort: "activation",
                        limit: Math.max(limit * 5, 100),
                        includeSecondary: true,
                    });
                    const topicNoteIds = new Set(topicNotes.map(note => note.id));
                    results = results.filter(note => topicNoteIds.has(note.id)).slice(0, limit);
                }

                return { status: 200, data: { results } };
            }],
            ["POST:/api/pkm/write", (body = {}, ctx = {}) => {
                requireUser(ctx);

                const scope = body.scope || "user";
                if (scope !== "user" && scope !== "household") {
                    return { status: 400, data: { error: "Invalid scope" } };
                }

                let scopeId;
                if (scope === "household") {
                    const settings = this.#store.getSettings(ctx.userId);
                    if (!settings?.household_id || !this.#store.isHouseholdMember(ctx.userId, settings.household_id)) {
                        return { status: 403, data: { error: "Not a household member" } };
                    }
                    scopeId = settings.household_id;
                }

                const result = this.#store.createNote({
                    userId: ctx.userId,
                    chatId: ctx.chatId,
                    type: body.type || "fact",
                    title: body.title,
                    content: body.content,
                    searchKeywords: body.search_keywords || [],
                    tags: body.tags || [],
                    sourceType: "explicit",
                    confidence: 0.95,
                    importance: typeof body.importance === "number" ? body.importance : 0.6,
                    scope,
                    scopeId,
                    topics: body.topics,
                });
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/recent", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const results = this.#store.getRecentNotes(ctx.userId, {
                    days: body.days || 7,
                    limit: body.limit || 10,
                });
                return { status: 200, data: results };
            }],
            ["GET:/api/pkm/stats", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const stats = this.#store.getStats(ctx.userId);
                return { status: 200, data: stats };
            }],
            ["GET:/api/pkm/map", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const map = this.#store.getMemoryMap(ctx.userId);
                return { status: 200, data: map };
            }],
            ["GET:/api/pkm/settings", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                const settings = this.#store.getSettings(ctx.userId);
                return { status: 200, data: settings || { enabled: false } };
            }],
            ["PUT:/api/pkm/settings", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                this.#store.updateSettings(ctx.userId, body);
                return { status: 200, data: { updated: true } };
            }],
            ["POST:/api/pkm/enable", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                this.#store.enableUser(ctx.userId);
                return { status: 200, data: { enabled: true } };
            }],
            ["POST:/api/pkm/disable", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                this.#store.disableUser(ctx.userId);
                return { status: 200, data: { enabled: false } };
            }],
            ["POST:/api/pkm/agent/search", (body = {}) => {
                const results = this.#search.searchAgent(body.query, {
                    type: body.type,
                    limit: body.limit || 5,
                });
                return { status: 200, data: results };
            }],
            ["POST:/api/pkm/agent/write", (body = {}) => {
                const classification = this.#security.classifyAgentWrite(body.content);
                const confidence = classification.suggestedConfidence;
                const sourceType = body.source_type || (classification.isPolicyLanguage ? "user_stated_policy" : "inferred");

                const result = this.#store.createNote({
                    userId: "__agent__",
                    type: body.type || "fact",
                    title: body.title,
                    content: body.content,
                    searchKeywords: body.search_keywords || [],
                    tags: body.tags || [],
                    sourceType,
                    confidence,
                    durability: body.durability || "normal",
                    importance: classification.isPolicyLanguage ? 0.3 : 0.6,
                    scope: "agent",
                    topics: body.topics,
                });
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/entities", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const results = this.#store.searchEntities(ctx.userId, body.query || "", {
                    limit: body.limit || 10,
                });
                return { status: 200, data: { results } };
            }],
            ["GET:/api/pkm/export", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const exportData = this.#store.exportUserData(ctx.userId);
                return { status: 200, data: exportData };
            }],
            ["POST:/api/pkm/household/create", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const name = body.name || "My Household";
                const result = this.#store.createHousehold(ctx.userId, name);
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/household/join", (body = {}, ctx = {}) => {
                requireUser(ctx);
                if (!body.household_id) return { status: 400, data: { error: "household_id required" } };
                this.#store.joinHousehold(ctx.userId, body.household_id);
                return { status: 200, data: { joined: true } };
            }],
            ["POST:/api/pkm/household/leave", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                this.#store.leaveHousehold(ctx.userId);
                return { status: 200, data: { left: true } };
            }],
            ["GET:/api/pkm/household", (body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                const settings = this.#store.getSettings(ctx.userId);
                if (!settings?.household_id) {
                    return { status: 200, data: { household: null, members: [] } };
                }
                const household = this.#store.getHousehold(settings.household_id);
                const members = this.#store.getHouseholdMembers(settings.household_id);
                return { status: 200, data: { household, members } };
            }],
            ["POST:/api/pkm/navigate/browse", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const notes = this.#store.browseTopicNotes(body.topic_id, ctx.userId, {
                    sort: body.sort,
                    limit: body.limit,
                    includeSecondary: body.include_secondary,
                });
                return { status: 200, data: { results: notes } };
            }],
            ["POST:/api/pkm/navigate/context", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const neighbors = this.#store.getNeighbors(body.note_id, ctx.userId, { limit: body.limit });
                return { status: 200, data: { results: neighbors } };
            }],
            ["POST:/api/pkm/navigate/timeline", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const timeline = this.#store.getTimeline(ctx.userId, { period: body.period, limit: body.limit });
                return { status: 200, data: { results: timeline } };
            }],
            ["POST:/api/pkm/collection/create", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const result = this.#store.createCollection(ctx.userId, {
                    name: body.name,
                    schema: body.schema,
                    description: body.description,
                    topicId: body.topic_id,
                });
                return { status: 201, data: result };
            }],
            ["GET:/api/pkm/collections", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const collections = this.#store.getCollections(ctx.userId);
                return { status: 200, data: { results: collections } };
            }],
            ["POST:/api/pkm/collection/add", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const result = this.#store.addCollectionItem(ctx.userId, body.collection_id, body.data, body.title);
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/collection/query", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const results = this.#store.queryCollection(body.collection_id, ctx.userId, {
                    filter: body.filter,
                    sortBy: body.sort_by,
                    limit: body.limit,
                });
                return { status: 200, data: { results } };
            }],
            ["POST:/api/pkm/topics/create", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const result = this.#store.createTopic(ctx.userId, body.name, {
                    parentId: body.parent_id,
                    icon: body.icon,
                    description: body.description,
                });
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/topics/move", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const result = this.#store.moveTopic(body.topic_id, body.new_parent_id || null, ctx.userId);
                return { status: 200, data: result };
            }],
            ["POST:/api/pkm/topics/merge", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const moved = this.#store.mergeTopics(body.source_id, body.target_id, ctx.userId);
                return { status: 200, data: { merged: true, notes_moved: moved } };
            }],
            ["POST:/api/pkm/link", (body = {}, ctx = {}) => {
                requireUser(ctx);
                this.#store.db.prepare(
                    "INSERT OR IGNORE INTO note_links (source_id, target_id, relation, created_at) VALUES (?, ?, ?, ?)"
                ).run(body.source_id, body.target_id, body.relation || "related", new Date().toISOString());
                return { status: 201, data: { linked: true } };
            }],
            ["POST:/api/pkm/maintain", (body = {}, ctx = {}) => {
                requireUser(ctx);
                this.#store.decayAllActivations(ctx.userId);
                this.#store.invalidateMapCache(ctx.userId);
                return { status: 200, data: { maintained: true } };
            }],
        ]);

        this.#prefixRoutes = [
            [{ method: "GET", prefix: "/api/pkm/notes/" }, (noteId, body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                const note = this.#store.getNote(noteId);
                if (!note) return { status: 404, data: { error: "Not found" } };
                if (note.user_id !== ctx.userId) {
                    if (note.scope !== "household" || !this.#store.isHouseholdMember(ctx.userId, note.scope_id)) {
                        return { status: 403, data: { error: "Access denied" } };
                    }
                }
                return { status: 200, data: note };
            }],
            [{ method: "PUT", prefix: "/api/pkm/notes/" }, (noteId, body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                if (body.archive) {
                    this.#store.updateNote(noteId, ctx.userId, { valid_to: new Date().toISOString() });
                } else {
                    this.#store.updateNote(noteId, ctx.userId, body);
                }
                return { status: 200, data: { updated: true } };
            }],
            [{ method: "DELETE", prefix: "/api/pkm/notes/" }, (noteId, body = {}, ctx = {}) => {
                if (!ctx?.userId) return { status: 401, data: { error: "No user context" } };
                const deleted = this.#store.secureDelete(noteId, ctx.userId);
                if (!deleted) return { status: 404, data: { error: "Not found" } };
                return { status: 200, data: { deleted: true, secure: true } };
            }],
            [{ method: "PUT", prefix: "/api/pkm/agent/notes/" }, (noteId, body = {}) => {
                const note = this.#store.getNote(noteId);
                if (!note || note.user_id !== "__agent__") {
                    return { status: 404, data: { error: "Not found or not an agent note" } };
                }
                if (body.archive) {
                    this.#store.updateNote(noteId, "__agent__", { valid_to: new Date().toISOString() });
                } else {
                    this.#store.updateNote(noteId, "__agent__", body);
                }
                return { status: 200, data: { updated: true } };
            }],
            [{ method: "DELETE", prefix: "/api/pkm/agent/notes/" }, (noteId) => {
                const note = this.#store.getNote(noteId);
                if (!note || note.user_id !== "__agent__") {
                    return { status: 404, data: { error: "Not found or not an agent note" } };
                }
                this.#store.secureDelete(noteId, "__agent__");
                return { status: 200, data: { deleted: true, secure: true } };
            }],
            [{ method: "GET", prefix: "/api/pkm/entities/" }, (entityId, body = {}, ctx = {}) => {
                requireUser(ctx);
                const notes = this.#store.getNotesForEntity(entityId, { userId: ctx.userId, limit: 20 });
                return { status: 200, data: { notes } };
            }],
            [{ method: "PUT", prefix: "/api/pkm/collection/item/" }, (itemId, body = {}, ctx = {}) => {
                requireUser(ctx);
                this.#store.updateCollectionItem(itemId, ctx.userId, body.data);
                return { status: 200, data: { updated: true } };
            }],
            [{ method: "DELETE", prefix: "/api/pkm/collection/item/" }, (itemId, body = {}, ctx = {}) => {
                requireUser(ctx);
                this.#store.removeCollectionItem(itemId, ctx.userId);
                return { status: 200, data: { deleted: true } };
            }],
        ];
    }

    /**
     * Handle PKM REST API requests from the MCP server.
     * @param {string} method - HTTP method
     * @param {string} pathname - URL path (e.g. /api/pkm/search)
     * @param {object} body - Request body (parsed JSON)
     * @param {object} context - { userId, chatId, chatType } from session
     * @returns {{ status: number, data: any }}
     */
    handleApi(method, pathname, body, context) {
        const { userId, chatType } = context || {};

        try {
            const routeKey = `${method}:${pathname}`;

            const handler = this.#routes.get(routeKey);
            if (handler) return handler(body, context);

            for (const [pattern, h] of this.#prefixRoutes) {
                if (pathname.startsWith(pattern.prefix) && method === pattern.method) {
                    const param = decodeURIComponent(pathname.slice(pattern.prefix.length));
                    return h(param, body, context);
                }
            }

            return { status: 404, data: { error: "Unknown PKM endpoint" } };
        } catch (e) {
            log.error(`PKM API error: ${e.message}`);
            return { status: e.status || 500, data: { error: e.message } };
        }
    }
}

export default PkmManager;
