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
import { autoEnrich, scanMessage } from "./enrichment.mjs";
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

        // Start background maintenance — housekeeping always, extraction only with LLM
        if (this.#llmCall) {
            this.#extractor.startTimer(this.#llmCall);
        } else {
            this.#extractor.startHousekeepingTimer();
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
        return `[Memory: ${count} stored] ` +
            `Use remember("fact") to save. Use recall("query") to search. ` +
            `Proactively save preferences, decisions, and personal details — confirm briefly: "Noted ✓"`;
    }

    getAgentHint() {
        const count = this.#store?.getNoteCount("__agent__") || 0;
        if (count === 0) return null;
        return `[Agent memory: ${count} notes] Use remember/recall with scope="agent" for your private operational notes.`;
    }

    // ── Smart prefetch (called by prompt builder) ──────────

    /**
     * Broader prefetch: scan every message for entities/keywords,
     * count matching memories, return awareness hint.
     * Replaces the old narrow recall-pattern-only prefetch.
     */
    getSmartPrefetch(message, userId, chatType = "dm") {
        if (!this.#store?.isEnabled(userId)) return null;
        // Never prefetch in group context
        if (chatType === "group" || chatType === "supergroup") return null;

        const { entities, keywords } = scanMessage(message);
        if (entities.length === 0 && keywords.length === 0) return null;

        const hints = [];

        // Check entity matches
        for (const entityName of entities.slice(0, 3)) {
            try {
                const matches = this.#store.searchEntities(String(userId), entityName, { limit: 1 });
                if (matches.length > 0) {
                    const ent = matches[0];
                    hints.push(`${ent.name}: ${ent.note_count} memories`);
                }
            } catch { /* non-fatal */ }
        }

        // If entities found, also do a quick search for top results
        if (hints.length > 0 || keywords.length > 0) {
            const searchQuery = [...entities, ...keywords.slice(0, 3)].join(" ");
            try {
                const { results } = this.#search.search(searchQuery, {
                    userId: String(userId), scope: "user", limit: 3,
                });
                if (results.length > 0) {
                    // Track access for ranking
                    for (const r of results) {
                        if (r.id) try { this.#store.trackAccess(r.id); } catch {}
                    }
                    return this.#security.frameRetrievedMemories(results, "user_pkm");
                }
            } catch { /* non-fatal */ }
        }

        // If we found entity matches but no search results, return awareness hint
        if (hints.length > 0) {
            return `[Memory hints — use recall() for details: ${hints.join("; ")}]`;
        }

        return null;
    }

    // ── REST API handler ───────────────────────────────────

    #setupRoutes() {
        const requireUser = (ctx) => {
            if (!ctx?.userId) throw Object.assign(new Error("No user context"), { status: 401 });
            if (!this.#store.isEnabled(ctx.userId)) throw Object.assign(new Error("PKM not enabled"), { status: 403 });
        };

        this.#routes = new Map([
            // ── Simplified tools ───────────────────────────────
            ["POST:/api/pkm/remember", (body = {}, ctx = {}) => {
                const scope = body.scope || "user";
                const isAgent = scope === "agent";

                if (!isAgent) requireUser(ctx);

                if (!body.content) return { status: 400, data: { error: "content is required" } };

                // Auto-enrich: generate title, type, tags, keywords, entities, importance, durability
                const enriched = autoEnrich(body.content, {
                    title: body.title,
                    type: body.type,
                    tags: body.tags,
                    importance: body.importance,
                    durability: body.durability,
                });

                const userId = isAgent ? "__agent__" : ctx.userId;
                let scopeId;
                if (scope === "household") {
                    const settings = this.#store.getSettings(ctx.userId);
                    if (!settings?.household_id || !this.#store.isHouseholdMember(ctx.userId, settings.household_id)) {
                        return { status: 403, data: { error: "Not a household member" } };
                    }
                    scopeId = settings.household_id;
                }

                const result = this.#store.createNote({
                    userId,
                    chatId: ctx.chatId || null,
                    type: enriched.type,
                    title: enriched.title,
                    content: body.content,
                    searchKeywords: enriched.searchKeywords,
                    tags: enriched.tags,
                    metadata: enriched.entities.length ? { entities: enriched.entities } : null,
                    sourceType: "explicit",
                    confidence: 0.95,
                    importance: enriched.importance,
                    durability: enriched.durability,
                    scope: isAgent ? "agent" : scope,
                    scopeId,
                    topics: enriched.topics,
                });

                // Process entities (link to entities table)
                if (enriched.entities.length > 0) {
                    this.#store.processEntities(result.id, userId, enriched.entities);
                }

                return { status: 201, data: { id: result.id, title: enriched.title, type: enriched.type } };
            }],

            ["POST:/api/pkm/recall", (body = {}, ctx = {}) => {
                const scope = body.scope || "user";
                const isAgent = scope === "agent";

                if (!isAgent) requireUser(ctx);
                if (!body.query) return { status: 400, data: { error: "query is required" } };

                const userId = isAgent ? "__agent__" : String(ctx.userId);

                if (isAgent) {
                    const results = this.#search.searchAgent(body.query, { limit: body.limit || 7 });
                    return { status: 200, data: { results } };
                }

                // Entity-aware search: scan query for entities, enrich results
                const scan = scanMessage(body.query);
                const entityNoteIds = new Set();

                // Find notes linked to mentioned entities
                for (const entityName of scan.entities.slice(0, 3)) {
                    try {
                        const matches = this.#store.searchEntities(userId, entityName, { limit: 3 });
                        for (const ent of matches) {
                            const linked = this.#store.getNotesForEntity(ent.id, { userId, limit: 5 });
                            for (const note of linked) entityNoteIds.add(note.id);
                        }
                    } catch { /* non-fatal */ }
                }

                // FTS5 search
                const { results, expanded } = this.#search.search(body.query, {
                    userId,
                    scope,
                    limit: (body.limit || 7) + 3, // fetch extra to merge with entity results
                    expandContext: true,
                });

                // Merge entity-linked notes that weren't in FTS results
                const resultIds = new Set(results.map(r => r.id));
                const extraNotes = [];
                for (const noteId of entityNoteIds) {
                    if (!resultIds.has(noteId)) {
                        const note = this.#store.getNote(noteId);
                        if (note && !note.valid_to && note.user_id === userId) {
                            note.finalScore = 0.6;
                            note._entityLinked = true;
                            extraNotes.push(note);
                        }
                    }
                }

                const merged = [...results, ...extraNotes]
                    .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
                    .slice(0, body.limit || 7);

                // Track access
                for (const r of merged) {
                    if (r.id) try { this.#store.trackAccess(r.id); } catch {}
                }

                return { status: 200, data: { results: merged, expanded } };
            }],

            // ── Original routes (kept for backward compat) ────
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

                const { results, expanded } = this.#search.search(body.query, {
                    userId: ctx.userId,
                    scope,
                    scopeId,
                    type: body.type,
                    dateFrom: body.date_from,
                    dateTo: body.date_to,
                    tags: body.tags,
                    limit: body.limit || 7,
                    queries: body.queries,
                    topic: body.topic,
                    entity: body.entity,
                    expandContext: body.expand_context,
                });

                // Track access on returned results — powers activation/decay ranking
                for (const r of results) {
                    if (r.id) try { this.#store.trackAccess(r.id); } catch {}
                }

                return { status: 200, data: { results, expanded } };
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
            ["POST:/api/pkm/household/invite", (body = {}, ctx = {}) => {
                requireUser(ctx);
                const settings = this.#store.getSettings(ctx.userId);
                if (!settings?.household_id) return { status: 400, data: { error: "Not in a household" } };
                const result = this.#store.createHouseholdInvite(ctx.userId, settings.household_id, body.expires_hours);
                return { status: 201, data: result };
            }],
            ["POST:/api/pkm/household/join", (body = {}, ctx = {}) => {
                requireUser(ctx);
                if (!body.household_id) return { status: 400, data: { error: "household_id required" } };
                if (!body.invite_token) return { status: 400, data: { error: "invite_token required" } };
                this.#store.joinHousehold(ctx.userId, body.household_id, body.invite_token);
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
                // Validate both notes belong to the calling user
                const source = this.#store.getNote(body.source_id);
                const target = this.#store.getNote(body.target_id);
                if (!source || source.user_id !== ctx.userId) return { status: 403, data: { error: "Source note not owned by you" } };
                if (!target || target.user_id !== ctx.userId) return { status: 403, data: { error: "Target note not owned by you" } };
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
