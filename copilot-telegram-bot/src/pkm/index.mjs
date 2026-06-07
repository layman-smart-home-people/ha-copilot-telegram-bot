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

    constructor({ dbPath, agentDir, llmCall }) {
        this.#dbPath = dbPath || "/data/pkm.db";
        this.#agentDir = agentDir || "/config/copilot-telegram-bot";
        this.#llmCall = llmCall || null;
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
        return `PKM: ${count} memories stored. Use pkm_search when the user asks about past events, preferences, or personal facts. ` +
            `Use pkm_write when they ask you to remember something or when you learn something worth keeping. ` +
            `Proactively remember important preferences, decisions, and facts — don't wait to be asked.`;
    }

    getAgentHint() {
        const count = this.#store?.getNoteCount("__agent__") || 0;
        if (count === 0) return null;
        return `You have ${count} notes in your private memory (pkm_agent_search/write/update/delete). ` +
            `Use these proactively: search before tasks, write after completing work, update stale notes, archive outdated ones. ` +
            `Your memories make you smarter over time — maintain them actively.`;
    }

    // ── REST API handler ───────────────────────────────────

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
            // ── User-facing endpoints ──────────────────────

            if (pathname === "/api/pkm/search" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };

                let scope = body.scope || "user";
                let scopeId;

                // In group context, search household memories if user is a member
                if (chatType === "group" || chatType === "supergroup") {
                    const settings = this.#store.getSettings(userId);
                    if (settings?.household_id && this.#store.isHouseholdMember(userId, settings.household_id)) {
                        scope = "household";
                        scopeId = settings.household_id;
                    } else {
                        scope = "user"; // fall back to own memories
                    }
                }

                const { results } = this.#search.search(body.query, {
                    userId, scope, scopeId,
                    type: body.type, dateFrom: body.date_from, dateTo: body.date_to,
                    tags: body.tags, limit: body.limit || 7,
                });
                return { status: 200, data: { results } };
            }

            if (pathname === "/api/pkm/write" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };

                const scope = body.scope || "user";
                if (scope !== "user" && scope !== "household") {
                    return { status: 400, data: { error: "Invalid scope" } };
                }

                // Household write requires membership verification
                let scopeId;
                if (scope === "household") {
                    const settings = this.#store.getSettings(userId);
                    if (!settings?.household_id || !this.#store.isHouseholdMember(userId, settings.household_id)) {
                        return { status: 403, data: { error: "Not a household member" } };
                    }
                    scopeId = settings.household_id;
                }

                const result = this.#store.createNote({
                    userId,
                    chatId: context.chatId,
                    type: body.type || "fact",
                    title: body.title,
                    content: body.content,
                    searchKeywords: body.search_keywords || [],
                    tags: body.tags || [],
                    sourceType: "explicit",
                    confidence: 0.95,
                    importance: 0.6,
                    scope,
                    scopeId,
                });
                return { status: 201, data: result };
            }

            // GET /api/pkm/notes/:id
            if (pathname.startsWith("/api/pkm/notes/") && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                const noteId = decodeURIComponent(pathname.split("/").pop());
                const note = this.#store.getNote(noteId);
                if (!note) return { status: 404, data: { error: "Not found" } };
                // Access control: own notes + household notes (with membership check)
                if (note.user_id !== userId) {
                    if (note.scope !== "household" || !this.#store.isHouseholdMember(userId, note.scope_id)) {
                        return { status: 403, data: { error: "Access denied" } };
                    }
                }
                return { status: 200, data: note };
            }

            // PUT /api/pkm/notes/:id
            if (pathname.startsWith("/api/pkm/notes/") && method === "PUT") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                const noteId = decodeURIComponent(pathname.split("/").pop());
                if (body.archive) {
                    this.#store.updateNote(noteId, userId, { valid_to: new Date().toISOString() });
                } else {
                    this.#store.updateNote(noteId, userId, body);
                }
                return { status: 200, data: { updated: true } };
            }

            // DELETE /api/pkm/notes/:id
            if (pathname.startsWith("/api/pkm/notes/") && method === "DELETE") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                const noteId = decodeURIComponent(pathname.split("/").pop());
                const deleted = this.#store.secureDelete(noteId, userId);
                if (!deleted) return { status: 404, data: { error: "Not found" } };
                return { status: 200, data: { deleted: true, secure: true } };
            }

            if (pathname === "/api/pkm/recent" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const results = this.#store.getRecentNotes(userId, {
                    days: body?.days || 7, limit: body?.limit || 10,
                });
                return { status: 200, data: results };
            }

            if (pathname === "/api/pkm/stats" && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const stats = this.#store.getStats(userId);
                return { status: 200, data: stats };
            }

            if (pathname === "/api/pkm/settings" && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                const settings = this.#store.getSettings(userId);
                return { status: 200, data: settings || { enabled: false } };
            }

            if (pathname === "/api/pkm/settings" && method === "PUT") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.updateSettings(userId, body);
                return { status: 200, data: { updated: true } };
            }

            if (pathname === "/api/pkm/enable" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.enableUser(userId);
                return { status: 200, data: { enabled: true } };
            }

            if (pathname === "/api/pkm/disable" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.disableUser(userId);
                return { status: 200, data: { enabled: false } };
            }

            // ── Agent-private endpoints ────────────────────

            if (pathname === "/api/pkm/agent/search" && method === "POST") {
                const results = this.#search.searchAgent(body.query, {
                    type: body.type, limit: body.limit || 5,
                });
                return { status: 200, data: results };
            }

            if (pathname === "/api/pkm/agent/write" && method === "POST") {
                // Validate against policy language
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
                });
                return { status: 201, data: result };
            }

            // PUT /api/pkm/agent/notes/:id — update agent's own note
            if (pathname.startsWith("/api/pkm/agent/notes/") && method === "PUT") {
                const noteId = decodeURIComponent(pathname.split("/").pop());
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
            }

            // DELETE /api/pkm/agent/notes/:id — delete agent's own note
            if (pathname.startsWith("/api/pkm/agent/notes/") && method === "DELETE") {
                const noteId = decodeURIComponent(pathname.split("/").pop());
                const note = this.#store.getNote(noteId);
                if (!note || note.user_id !== "__agent__") {
                    return { status: 404, data: { error: "Not found or not an agent note" } };
                }
                this.#store.secureDelete(noteId, "__agent__");
                return { status: 200, data: { deleted: true, secure: true } };
            }

            // ── Entity endpoints ───────────────────────────

            if (pathname === "/api/pkm/entities" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const results = this.#store.searchEntities(userId, body.query || "", {
                    limit: body.limit || 10,
                });
                return { status: 200, data: { results } };
            }

            if (pathname.startsWith("/api/pkm/entities/") && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const entityId = decodeURIComponent(pathname.split("/").pop());
                const notes = this.#store.getNotesForEntity(entityId, { userId, limit: 20 });
                return { status: 200, data: { notes } };
            }

            // ── Export endpoint ─────────────────────────────

            if (pathname === "/api/pkm/export" && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const exportData = this.#store.exportUserData(userId);
                return { status: 200, data: exportData };
            }

            // ── Household endpoints ────────────────────────

            if (pathname === "/api/pkm/household/create" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                const name = body.name || "My Household";
                const result = this.#store.createHousehold(userId, name);
                return { status: 201, data: result };
            }

            if (pathname === "/api/pkm/household/join" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#store.isEnabled(userId)) return { status: 403, data: { error: "PKM not enabled" } };
                if (!body.household_id) return { status: 400, data: { error: "household_id required" } };
                this.#store.joinHousehold(userId, body.household_id);
                return { status: 200, data: { joined: true } };
            }

            if (pathname === "/api/pkm/household/leave" && method === "POST") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.leaveHousehold(userId);
                return { status: 200, data: { left: true } };
            }

            if (pathname === "/api/pkm/household" && method === "GET") {
                if (!userId) return { status: 401, data: { error: "No user context" } };
                const settings = this.#store.getSettings(userId);
                if (!settings?.household_id) {
                    return { status: 200, data: { household: null, members: [] } };
                }
                const household = this.#store.getHousehold(settings.household_id);
                const members = this.#store.getHouseholdMembers(settings.household_id);
                return { status: 200, data: { household, members } };
            }

            return { status: 404, data: { error: "Unknown PKM endpoint" } };

        } catch (e) {
            log.error(`PKM API error: ${e.message}`);
            return { status: 500, data: { error: e.message } };
        }
    }
}

export default PkmManager;
