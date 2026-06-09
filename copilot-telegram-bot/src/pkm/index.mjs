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
        log.info("Starting memory system...");

        this.#security = new PkmSecurity();
        this.#store = new PkmStore(this.#dbPath);
        this.#store.open();
        this.#extractor = new PkmExtractor(this.#store, this.#security);
        this.#search = new PkmSearch(this.#store, this.#security);

        // Bootstrap core memory from .md files (first-use only, idempotent)
        this.#store.bootstrapCoreMemory(this.#agentDir);

        // Legacy: also bootstrap agent archival memory from MEMORY.md daily logs
        this.#store.bootstrapAgentMemory(this.#agentDir);

        if (this.#llmCall) {
            this.#extractor.startTimer(this.#llmCall);
        } else {
            this.#extractor.startHousekeepingTimer();
        }

        this.#setupRoutes();

        log.info("Memory system started");
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
        this.#extractor?.stopTimer();
        if (fn) {
            this.#extractor?.startTimer(fn);
        }
    }

    // ── Dream mode (deep memory maintenance) ──────────────

    /**
     * Run "dream" mode — comprehensive memory maintenance with LLM.
     * 9 phases: harvest → curate → contradictions → merge → synthesize+infer →
     *           staleness → entity mapping → proactive suggestions → compact
     */
    async dream(userId, llmCall, { synthesize = false } = {}) {
        if (!this.#store || !llmCall) throw new Error("Memory system or LLM not available");
        const r = { harvested: 0, curated: 0, contradictions: 0, merged: 0, synthesized: 0, stale: 0, entities: 0, suggestions: 0, compacted: 0 };
        let phase = 0;

        const fetchNotes = () => this.#store.db.prepare(
            `SELECT id, type, title, content, importance, pinned, durability, activation,
                    confidence, source_type, tags, created_at
             FROM notes WHERE user_id = ? AND valid_to IS NULL
             ORDER BY activation DESC LIMIT 60`
        ).all(userId);

        const noteDump = (notes, charLimit = 200) => notes.map(n =>
            `[${n.type}] ${n.title || "(untitled)"}: ${n.content?.substring(0, charLimit)}`
        ).join("\n");

        // ── Phase 1: Harvest sessions ──────────────────────
        log.info(`[dream] Phase ${++phase}: harvest for ${userId}`);
        for (const win of this.#store.getAllStaleWindows(0)) {
            if (userId !== "__agent__" && win.user_id !== userId) continue;
            this.#store.closeWindow(win.id);
            try { r.harvested += (await this.#extractor.extractWindow(win, llmCall)).length; } catch {}
        }
        for (const win of this.#store.db.prepare(
            "SELECT * FROM conversation_windows WHERE extracted = 0 AND closed_at IS NOT NULL"
        ).all()) {
            if (userId !== "__agent__" && win.user_id !== userId) continue;
            try { r.harvested += (await this.#extractor.extractWindow(win, llmCall)).length; } catch {}
        }

        // ── Phase 2: Curate (pin/unpin/archive) ────────────
        log.info(`[dream] Phase ${++phase}: curate for ${userId}`);
        let notes = fetchNotes();
        if (notes.length > 0) {
            const noteList = notes.map((n, i) => {
                const pin = n.pinned ? "📌" : "  ";
                const title = n.title || "(untitled)";
                const act = typeof n.activation === "number" ? n.activation.toFixed(2) : "?";
                return `${i + 1}. [${pin}] [${n.type}] "${title}"\n   ${n.content?.substring(0, 120)}\n   imp=${n.importance} act=${act} dur=${n.durability} age=${n.created_at?.substring(0, 10)}`;
            }).join("\n");

            try {
                const resp = await llmCall(`Review this memory store. For each, decide: PIN / UNPIN / ARCHIVE / KEEP.
Return JSON: [{"id":"...","action":"PIN|UNPIN|ARCHIVE|KEEP","reason":"..."}]. Only non-KEEP entries. Return [] if fine.

MEMORIES:\n${noteList}`);
                for (const { id, action } of this.#parseDreamResponse(resp)) {
                    try {
                        if (action === "PIN") { this.#store.pinNote(id, userId); r.curated++; }
                        else if (action === "UNPIN") { this.#store.unpinNote(id, userId); r.curated++; }
                        else if (action === "ARCHIVE") { this.#store.updateNote(id, userId, { valid_to: new Date().toISOString() }); r.curated++; }
                    } catch {}
                }
            } catch (e) { log.warn(`[dream] Curate failed: ${e.message}`); }
        }

        // ── Phase 3: Contradiction resolution ──────────────
        log.info(`[dream] Phase ${++phase}: contradictions for ${userId}`);
        notes = fetchNotes();
        if (notes.length >= 3) {
            try {
                const resp = await llmCall(`Find CONTRADICTIONS in these memories — facts that conflict with each other.
For each contradiction, pick the one to KEEP (more recent/reliable) and the one to ARCHIVE.
Return JSON: [{"keep_id":"...","archive_id":"...","reason":"..."}]. Return [] if none.

MEMORIES:\n${notes.map((n, i) => `${i + 1}. [${n.type}] "${n.title}" — ${n.content?.substring(0, 150)} (id:${n.id} created:${n.created_at?.substring(0, 10)})`).join("\n")}`);
                for (const { archive_id } of this.#parseDreamResponse(resp)) {
                    try { this.#store.updateNote(archive_id, userId, { valid_to: new Date().toISOString() }); r.contradictions++; } catch {}
                }
            } catch (e) { log.warn(`[dream] Contradictions failed: ${e.message}`); }
        }

        // ── Phase 4: Memory merging ────────────────────────
        log.info(`[dream] Phase ${++phase}: merge similar for ${userId}`);
        notes = fetchNotes();
        if (notes.length >= 5) {
            try {
                const resp = await llmCall(`Find groups of SIMILAR memories that can be merged into single richer notes.
Only merge if 3+ memories cover the same topic and merging loses no important detail.
Return JSON: [{"merge_ids":["id1","id2","id3"],"merged_content":"combined fact","merged_title":"title","type":"fact|preference|event"}]. Return [] if nothing to merge.

MEMORIES:\n${notes.map((n, i) => `${i + 1}. [${n.type}] "${n.title}" — ${n.content?.substring(0, 150)} (id:${n.id})`).join("\n")}`);
                for (const group of this.#parseDreamResponse(resp)) {
                    if (!group.merge_ids?.length || !group.merged_content) continue;
                    try {
                        const enriched = autoEnrich(group.merged_content, { title: group.merged_title, type: group.type });
                        this.#store.createNote({
                            userId, type: enriched.type, title: enriched.title, content: group.merged_content,
                            searchKeywords: enriched.searchKeywords, tags: [...enriched.tags, "merged"],
                            sourceType: "merged", confidence: 0.9, importance: 0.7, durability: "normal",
                            scope: userId === "__agent__" ? "agent" : "user", topics: enriched.topics,
                        });
                        for (const id of group.merge_ids) {
                            try { this.#store.updateNote(id, userId, { valid_to: new Date().toISOString() }); } catch {}
                        }
                        r.merged++;
                    } catch {}
                }
            } catch (e) { log.warn(`[dream] Merge failed: ${e.message}`); }
        }

        // ── Phase 5: Synthesize + Infer ────────────────────
        if (synthesize) {
            log.info(`[dream] Phase ${++phase}: synthesize+infer for ${userId}`);
            notes = fetchNotes();
            if (notes.length >= 5) {
                try {
                    const resp = await llmCall(`You are dreaming — reflecting on memories to form new knowledge.

## SYNTHESIZE: find patterns across memories → higher-level abstractions
## INFER: deduce new facts from logical relationships
- Transitive: "X is brother" + "X's mother is Y" → "Y is likely my mother"
- Behavioral: 5 late-night messages → "night owl"
- Contextual: "hosting vegetarian Friday" → "need veggie options"

Confidence: HIGH(0.85+)=axiomatic, MEDIUM(0.6-0.84)=probable, LOW(0.4-0.59)=needs confirmation.
Return JSON: [{"title":"...","content":"...","type":"fact|preference|reflection","importance":0-1,"confidence":0-1,"needs_confirmation":bool,"reasoning":"..."}]
Max 7 outputs. Return [] if nothing.

MEMORIES:\n${noteDump(notes)}`);
                    for (const fact of this.#parseDreamResponse(resp)) {
                        if (!fact.content) continue;
                        try {
                            const enriched = autoEnrich(fact.content, { title: fact.title, type: fact.type || "reflection", importance: fact.importance });
                            this.#store.createNote({
                                userId, type: enriched.type, title: enriched.title, content: fact.content,
                                searchKeywords: enriched.searchKeywords,
                                tags: [...enriched.tags, "synthesized", ...(fact.needs_confirmation ? ["needs_confirmation"] : [])],
                                metadata: fact.reasoning ? { reasoning: fact.reasoning } : null,
                                sourceType: fact.needs_confirmation ? "inferred_unconfirmed" : "inferred",
                                confidence: fact.confidence || 0.6, importance: fact.importance || 0.6,
                                durability: "normal", scope: userId === "__agent__" ? "agent" : "user", topics: enriched.topics,
                            });
                            r.synthesized++;
                        } catch {}
                    }
                } catch (e) { log.warn(`[dream] Synthesize failed: ${e.message}`); }
            }
        }

        // ── Phase 6: Staleness detection ───────────────────
        log.info(`[dream] Phase ${++phase}: staleness check for ${userId}`);
        notes = fetchNotes();
        const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString();
        const staleNotes = notes.filter(n => n.created_at < sixMonthsAgo && n.durability !== "permanent" && !n.pinned);
        if (staleNotes.length > 0) {
            try {
                const resp = await llmCall(`These memories are over 6 months old. Which might be OUTDATED?
Flag memories where facts may have changed (addresses, jobs, preferences).
Don't flag permanent truths (birthdays, family identity, historical events).
Return JSON: [{"id":"...","reason":"why it might be stale"}]. Return [] if all valid.

OLD MEMORIES:\n${staleNotes.map((n, i) => `${i + 1}. [${n.type}] "${n.title}" — ${n.content?.substring(0, 150)} (id:${n.id} created:${n.created_at?.substring(0, 10)})`).join("\n")}`);
                for (const { id } of this.#parseDreamResponse(resp)) {
                    try {
                        const note = this.#store.getNote(id);
                        if (note) {
                            const tags = JSON.parse(note.tags || "[]");
                            if (!tags.includes("needs_confirmation")) {
                                tags.push("needs_confirmation");
                                this.#store.updateNote(id, userId, { tags: JSON.stringify(tags) });
                                r.stale++;
                            }
                        }
                    } catch {}
                }
            } catch (e) { log.warn(`[dream] Staleness failed: ${e.message}`); }
        }

        // ── Phase 7: Entity relationship mapping ───────────
        log.info(`[dream] Phase ${++phase}: entity relationships for ${userId}`);
        const entities = this.#store.searchEntities(userId, "", { limit: 20 });
        if (entities.length >= 2) {
            try {
                const entityList = entities.map(e => `${e.name} [${e.type || "?"}] (${e.note_count} notes, id:${e.id})`).join("\n");
                const resp = await llmCall(`Given these entities from a user's memory, identify RELATIONSHIPS between them.
Deduce: family, professional, social, geographic relationships.
Return JSON: [{"entity1":"name","entity2":"name","relationship":"wife_of|brother_of|colleague_of|lives_in|works_at|friend_of|...","confidence":0-1}]
Return [] if no clear relationships.

ENTITIES:\n${entityList}\n\nMEMORY CONTEXT:\n${noteDump(notes, 100)}`);
                for (const rel of this.#parseDreamResponse(resp)) {
                    if (!rel.entity1 || !rel.entity2 || !rel.relationship) continue;
                    try {
                        const e1 = entities.find(e => e.name.toLowerCase() === rel.entity1.toLowerCase());
                        const e2 = entities.find(e => e.name.toLowerCase() === rel.entity2.toLowerCase());
                        if (e1 && e2) {
                            const content = `${rel.entity1} is ${rel.relationship.replace(/_/g, " ")} ${rel.entity2}`;
                            const enriched = autoEnrich(content, { type: "fact", importance: 0.7 });
                            this.#store.createNote({
                                userId, type: "fact", title: content, content,
                                searchKeywords: enriched.searchKeywords, tags: ["relationship", "entity_link"],
                                sourceType: rel.confidence >= 0.85 ? "inferred" : "inferred_unconfirmed",
                                confidence: rel.confidence || 0.6, importance: 0.7, durability: "permanent",
                                scope: userId === "__agent__" ? "agent" : "user",
                            });
                            r.entities++;
                        }
                    } catch {}
                }
            } catch (e) { log.warn(`[dream] Entity mapping failed: ${e.message}`); }
        }

        // ── Phase 8: Proactive suggestions ─────────────────
        log.info(`[dream] Phase ${++phase}: proactive suggestions for ${userId}`);
        notes = fetchNotes();
        if (notes.length >= 3) {
            try {
                const today = new Date().toISOString().substring(0, 10);
                const resp = await llmCall(`Today is ${today}. Review these memories for ACTIONABLE insights:
- Upcoming dates (birthdays, anniversaries, deadlines within 14 days)
- Incomplete promises or goals the user mentioned
- Routine patterns the agent should be aware of
Return JSON: [{"suggestion":"what to do","urgency":"high|medium|low","trigger":"date|goal|pattern","detail":"context"}]
Max 5. Return [] if nothing actionable.

MEMORIES:\n${noteDump(notes)}`);
                for (const s of this.#parseDreamResponse(resp)) {
                    if (!s.suggestion) continue;
                    try {
                        this.#store.createNote({
                            userId, type: "journal",
                            title: `💡 ${s.suggestion.substring(0, 60)}`,
                            content: `[Proactive: ${s.trigger || "insight"}] ${s.suggestion}${s.detail ? ` — ${s.detail}` : ""}`,
                            tags: JSON.stringify(["proactive", "dream_suggestion", s.urgency || "medium"]),
                            sourceType: "dream_suggestion", confidence: 0.5,
                            importance: s.urgency === "high" ? 0.9 : 0.6,
                            durability: "ephemeral",
                            scope: userId === "__agent__" ? "agent" : "user",
                        });
                        r.suggestions++;
                    } catch {}
                }
            } catch (e) { log.warn(`[dream] Suggestions failed: ${e.message}`); }
        }

        // ── Phase 9: Compact ───────────────────────────────
        log.info(`[dream] Phase ${++phase}: compact for ${userId}`);
        this.#store.decayAllActivations(userId);
        r.compacted = this.#store.purgeOldRawMessages(7);
        this.#store.purgeOldAuditLogs(90);
        this.#store.invalidateMapCache(userId);

        log.info(`[dream] Complete for ${userId}: ${JSON.stringify(r)}`);
        return r;
    }

    /** Parse LLM dream response — expects JSON array */
    #parseDreamResponse(response) {
        if (!response || typeof response !== "string") return [];
        try {
            const match = response.match(/\[[\s\S]*\]/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                return Array.isArray(parsed) ? parsed.filter(a =>
                    a.id || a.content || a.merge_ids || a.archive_id || a.entity1 || a.suggestion
                ) : [];
            }
        } catch {}
        return [];
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

    /**
     * Get core memory block for injection into first message.
     * Returns formatted agent identity + pinned memories.
     * Replaces the old file-based IDENTITY.md + MEMORY.md loading.
     */
    getCoreMemoryBlock() {
        const notes = this.#store?.getCoreMemory("__agent__", 4000) || [];
        if (notes.length === 0) return null;

        const sections = notes.map(n => {
            const label = n.type === "identity" ? "## Identity"
                : n.type === "instruction" ? "## Instructions"
                : n.type === "skill" ? "## Capabilities"
                : `## ${n.title || "Memory"}`;
            return `${label}\n${n.content}`;
        });

        // Add memory-as-identity framing
        sections.push([
            "## Memory System",
            "Your pinned memories define who you are — they are always loaded into your context.",
            "Your ability to edit your own memory is what gives you continuity across conversations.",
            "Use `remember(content, {pinned: true})` to add to your core identity.",
            "Use `recall(query)` to search your full memory. Use `memory_admin({action: \"pin\"})` to manage.",
            "Maintaining your memory maintains your identity — keep it accurate and current.",
        ].join("\n"));

        return sections.join("\n\n---\n\n");
    }

    /**
     * Get user-specific pinned memories for injection.
     */
    getUserCoreMemory(userId) {
        if (!this.#store?.isEnabled(userId)) return null;
        const notes = this.#store.getCoreMemory(String(userId), 2000);
        if (notes.length === 0) return null;

        const lines = notes.map(n =>
            `[${n.type}] ${n.title || ""}: ${n.content}`
        );
        return this.#security.frameRetrievedMemories(
            notes.map(n => ({ ...n, type: n.type || "fact" })),
            "user_core"
        );
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
                    pinned: !!body.pinned,
                });

                // Process entities (link to entities table)
                if (enriched.entities.length > 0) {
                    this.#store.processEntities(result.id, userId, enriched.entities);
                }

                return { status: 201, data: { id: result.id, title: enriched.title, type: enriched.type, pinned: !!body.pinned } };
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
            ["POST:/api/pkm/dream", async (body = {}, ctx = {}) => {
                const userId = body.scope === "agent" ? "__agent__" : ctx?.userId;
                if (!userId) return { status: 401, data: { error: "No user context" } };
                if (!this.#llmCall) return { status: 503, data: { error: "LLM not available for dream mode" } };
                // Synthesize: use explicit param, fall back to per-user setting
                let doSynthesize = body.synthesize;
                if (doSynthesize === undefined && userId !== "__agent__") {
                    const settings = this.#store.getSettings(userId);
                    doSynthesize = settings?.dream_synthesize === 1;
                }
                try {
                    const results = await this.dream(userId, this.#llmCall, {
                        synthesize: !!doSynthesize,
                    });
                    return { status: 200, data: results };
                } catch (e) {
                    return { status: 500, data: { error: e.message } };
                }
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
                const source = this.#store.getNote(body.source_id);
                const target = this.#store.getNote(body.target_id);
                if (!source || source.user_id !== ctx.userId) return { status: 403, data: { error: "Source note not owned by you" } };
                if (!target || target.user_id !== ctx.userId) return { status: 403, data: { error: "Target note not owned by you" } };
                this.#store.db.prepare(
                    "INSERT OR IGNORE INTO note_links (source_id, target_id, relation, created_at) VALUES (?, ?, ?, ?)"
                ).run(body.source_id, body.target_id, body.relation || "related", new Date().toISOString());
                return { status: 201, data: { linked: true } };
            }],
            ["POST:/api/pkm/pin", (body = {}, ctx = {}) => {
                if (!body.id) return { status: 400, data: { error: "id required" } };
                // Allow agent-scope pinning without user context
                const note = this.#store.getNote(body.id);
                if (!note) return { status: 404, data: { error: "Not found" } };
                const userId = note.scope === "agent" ? "__agent__" : ctx.userId;
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.pinNote(body.id, userId);
                return { status: 200, data: { pinned: true } };
            }],
            ["POST:/api/pkm/unpin", (body = {}, ctx = {}) => {
                if (!body.id) return { status: 400, data: { error: "id required" } };
                const note = this.#store.getNote(body.id);
                if (!note) return { status: 404, data: { error: "Not found" } };
                const userId = note.scope === "agent" ? "__agent__" : ctx.userId;
                if (!userId) return { status: 401, data: { error: "No user context" } };
                this.#store.unpinNote(body.id, userId);
                return { status: 200, data: { unpinned: true } };
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
