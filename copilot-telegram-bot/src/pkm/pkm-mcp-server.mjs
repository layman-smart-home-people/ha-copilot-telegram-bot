#!/usr/bin/env node
// MCP server for PKM (Personal Knowledge Management) — raw JSON-RPC over stdio (NDJSON framing).
// Exposes 5 consolidated tools that call the bot's REST API.
// Same pattern as si-mcp-server.mjs. No npm dependencies.
// Access control: user_id/scope derived server-side from session context, never from tool params.

import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_BASE = process.env.PKM_API_BASE || "http://localhost:8099";
const COPILOT_HOME = process.env.COPILOT_HOME || "";
const SCOPE_KEY_FILE = COPILOT_HOME ? join(COPILOT_HOME, ".scope-key") : "";

/** Read current scope key from file (written by pool on claim). */
function getScopeKey() {
    if (!SCOPE_KEY_FILE) return null;
    try {
        const key = readFileSync(SCOPE_KEY_FILE, "utf-8").trim();
        return key || null;
    } catch {
        return null;
    }
}

function log(msg) { process.stderr.write(`[pkm-mcp] ${msg}\n`); }

// ── Tool definitions ────────────────────────────────────────

/* ── OLD v1 TOOLS (kept for rollback) ──
const TOOLS_V1 = [
    {
        name: "pkm_search",
        description:
            "Search the user's personal memories using full-text search. Returns ranked results. " +
            "Use when the user asks about past events, preferences, or facts they've mentioned before. " +
            "If few results, try broader terms or synonyms.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query — use natural language" },
                type: { type: "string", enum: ["fact", "preference", "event", "meeting", "health", "journal"], description: "Filter by memory type" },
                date_from: { type: "string", description: "ISO date — only memories after this date" },
                date_to: { type: "string", description: "ISO date — only memories before this date" },
                tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
                limit: { type: "number", description: "Max results (default: 7)" },
            },
            required: ["query"],
        },
    },
    {
        name: "pkm_write",
        description:
            "Save a memory explicitly. Use when the user asks you to remember something specific. " +
            "For shared household decisions, set scope to 'household' (requires confirmation).",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", description: "The memory content — make it factual and self-contained" },
                title: { type: "string", description: "Short summary (10-15 words)" },
                type: { type: "string", enum: ["fact", "preference", "event", "meeting", "health", "journal"], description: "Memory type (default: fact)" },
                tags: { type: "array", items: { type: "string" }, description: "Category tags" },
                scope: { type: "string", enum: ["user", "household"], description: "Memory scope (default: user)" },
            },
            required: ["content"],
        },
    },
    {
        name: "pkm_get",
        description: "Get a specific memory by ID, including linked notes and entities.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory note ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "pkm_update",
        description: "Update an existing memory (title, content, tags). Can also archive a note.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory note ID to update" },
                title: { type: "string", description: "New title" },
                content: { type: "string", description: "New content" },
                tags: { type: "array", items: { type: "string" }, description: "New tags" },
                archive: { type: "boolean", description: "Set to true to archive (deprioritize, not delete)" },
            },
            required: ["id"],
        },
    },
    {
        name: "pkm_recent",
        description: "List recent memories sorted by date. Good for showing what was recently remembered.",
        inputSchema: {
            type: "object",
            properties: {
                days: { type: "number", description: "How many days back (default: 7)" },
                limit: { type: "number", description: "Max results (default: 10)" },
            },
        },
    },
    {
        name: "pkm_stats",
        description: "Get memory store statistics — total count, breakdown by type, extraction health.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "pkm_delete",
        description:
            "Securely delete a memory. Data is forensically unrecoverable after deletion. " +
            "Always confirm with the user before deleting.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory note ID to delete" },
            },
            required: ["id"],
        },
    },
    {
        name: "pkm_settings",
        description: "Get or update PKM settings (window duration, enrichment, notifications).",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["get", "set"], description: "Get or set settings" },
                key: { type: "string", description: "Setting key (for set): window_minutes, enrichment_enabled, notifications_enabled" },
                value: { description: "New value (for set)" },
            },
        },
    },
    // Agent-private tools (invisible to users, agent uses internally)
    {
        name: "pkm_agent_search",
        description:
            "Search YOUR OWN (agent) private memory for operational knowledge. " +
            "Use when you need to recall system facts, past issues, entity names, or deployment history. " +
            "Results are internal — never show raw results to users.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query" },
                type: { type: "string", description: "Filter by type" },
                limit: { type: "number", description: "Max results (default: 5)" },
            },
            required: ["query"],
        },
    },
    {
        name: "pkm_agent_write",
        description:
            "Write to YOUR OWN (agent) private memory. Use after completing tasks, discovering system facts, " +
            "learning from mistakes, or when users provide operational info about the home/system. " +
            "Your memories shape who you are — write thoughtfully.",
        inputSchema: {
            type: "object",
            properties: {
                content: { type: "string", description: "The knowledge to store" },
                title: { type: "string", description: "Short summary" },
                type: { type: "string", enum: ["fact", "reflection", "journal", "preference"], description: "Memory type (default: fact)" },
                tags: { type: "array", items: { type: "string" }, description: "Tags" },
                durability: { type: "string", enum: ["permanent", "normal", "ephemeral"], description: "How long to keep (default: normal)" },
                source_type: { type: "string", enum: ["stated", "inferred"], description: "stated=from user, inferred=your observation (default: inferred)" },
            },
            required: ["content"],
        },
    },
    {
        name: "pkm_agent_update",
        description:
            "Update or archive one of YOUR OWN (agent) private memories. " +
            "Use to correct outdated info, refine notes, or archive stale entries. " +
            "Set archive=true to retire a note without deleting it.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory note ID to update" },
                title: { type: "string", description: "New title" },
                content: { type: "string", description: "New content" },
                tags: { type: "array", items: { type: "string" }, description: "New tags" },
                archive: { type: "boolean", description: "Set to true to archive (soft-retire, not delete)" },
            },
            required: ["id"],
        },
    },
    {
        name: "pkm_agent_delete",
        description:
            "Securely delete one of YOUR OWN (agent) private memories. " +
            "Data is forensically unrecoverable. Use for truly obsolete or incorrect information.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory note ID to delete" },
            },
            required: ["id"],
        },
    },
    {
        name: "pkm_entity_search",
        description:
            "Search memories by person, place, or entity name. Use when the user asks about a specific person " +
            "(e.g. 'what do you know about Daniel?') or place. Returns entity info and linked memories.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Entity name to search for (person, place, company)" },
                limit: { type: "number", description: "Max results (default: 10)" },
            },
            required: ["query"],
        },
    },
    {
        name: "pkm_map",
        description:
            "Get an ASCII overview map of this user's memory structure — like a directory tree. " +
            "Shows memory types, top tags, entities (people/places), timeline, sources, and durability breakdown. " +
            "Use this FIRST when you need to orient yourself in a user's memory space before searching. " +
            "Each user has their own isolated map. Results are scoped to the calling user only.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
];
*/

const TOOLS = [
    {
        name: "remember",
        description:
            "Save a memory. Just provide the content — title, type, tags, and keywords are generated automatically. " +
            "Use pinned=true for core identity facts that should always be in your context. " +
            "Use scope='agent' for your own private notes. " +
            "Your pinned memories define who you are — maintain them actively.",
        inputSchema: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The memory to save — a factual, self-contained statement. Examples: " +
                        "\"Alice's birthday is March 15\", \"User prefers dark roast coffee\", " +
                        "\"Had dinner at Maison with Bob, he loved the grouper\"",
                },
                scope: {
                    type: "string",
                    enum: ["user", "agent", "household"],
                    description: "Memory scope (default: user). 'agent' for private notes, 'household' for shared.",
                },
                pinned: {
                    type: "boolean",
                    description: "If true, this memory is always loaded into your context (core memory). Use for identity, key facts, instructions. Default: false.",
                },
                title: { type: "string", description: "Optional — auto-generated if omitted" },
                type: { type: "string", enum: ["fact", "preference", "event", "meeting", "health", "journal", "reflection", "identity", "skill", "instruction"], description: "Optional — auto-classified if omitted" },
                importance: { type: "number", description: "Optional 0-1 — auto-estimated if omitted" },
            },
            required: ["content"],
        },
    },
    {
        name: "recall",
        description:
            "Search memories using natural language. Entity-aware: automatically finds and includes " +
            "notes linked to mentioned people, places, and organizations. " +
            "Use scope='agent' to search your own private notes.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Natural language search query. Examples: " +
                        "\"Alice's preferences\", \"restaurants we visited\", \"health measurements\"",
                },
                scope: {
                    type: "string",
                    enum: ["user", "agent", "household"],
                    description: "Search scope (default: user)",
                },
                limit: { type: "number", description: "Max results (default: 7)" },
            },
            required: ["query"],
        },
    },
    {
        name: "memory_admin",
        description:
            "Advanced memory management: get/update/delete notes, pin/unpin core memory, navigate topics, manage collections, " +
            "dream (deep maintenance: harvest sessions, curate, infer new facts), " +
            "view stats, link notes, run maintenance. Use remember/recall for everyday operations.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: [
                        "get", "update", "delete", "link", "pin", "unpin", "dream",
                        "map", "browse", "context", "timeline",
                        "stats", "settings", "topic_create", "topic_move", "topic_merge", "maintain",
                        "collection_create", "collection_add", "collection_query", "collection_list",
                        "entity_search",
                    ],
                    description: "Action to perform.",
                },
                scope: { type: "string", enum: ["user", "agent", "household"], description: "Scope (default: user)" },
                id: { type: "string", description: "[get/update/delete/context] Note ID" },
                content: { type: "string", description: "[update] New content" },
                title: { type: "string", description: "[update/collection_create/collection_add] Title/name" },
                tags: { type: "array", items: { type: "string" }, description: "[update] New tags" },
                archive: { type: "boolean", description: "[update] Soft-retire" },
                source_id: { type: "string", description: "[link/topic_merge] Source ID" },
                target_id: { type: "string", description: "[link/topic_merge] Target ID" },
                relation: { type: "string", description: "[link] Relation type" },
                topic_id: { type: "string", description: "[browse/topic_move] Topic ID" },
                sort: { type: "string", enum: ["activation", "date", "title"], description: "[browse] Sort order" },
                period: { type: "string", enum: ["week", "month", "year"], description: "[timeline] Grouping" },
                name: { type: "string", description: "[topic_create/collection_create] Name" },
                parent_id: { type: "string", description: "[topic_create] Parent topic ID" },
                icon: { type: "string", description: "[topic_create] Emoji icon" },
                description: { type: "string", description: "[topic_create/collection_create] Description" },
                new_parent_id: { type: "string", description: "[topic_move] New parent" },
                settings_action: { type: "string", enum: ["get", "set"], description: "[settings]" },
                key: { type: "string", description: "[settings:set] Setting key" },
                value: { description: "[settings:set] New value" },
                collection_id: { type: "string", description: "[collection_add/query] Collection ID" },
                schema: { type: "object", description: "[collection_create] Schema" },
                data: { type: "object", description: "[collection_add] Item data" },
                filter: { type: "object", description: "[collection_query] Filter" },
                sort_by: { type: "string", description: "[collection_query] Sort field" },
                item_id: { type: "string", description: "[collection item ops] Item ID" },
                query: { type: "string", description: "[entity_search] Entity name query" },
                synthesize: { type: "boolean", description: "[dream] If true, also infer new facts and form concepts from existing memories. Default: false" },
                limit: { type: "number", description: "Max results" },
            },
            required: ["action"],
        },
    },
];
// ── API call helper ─────────────────────────────────────────

function apiCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: { "Content-Type": "application/json" },
            timeout: 15000,
        };
        // Pass scope key for user context resolution
        const scopeKey = getScopeKey();
        if (scopeKey) {
            options.headers["X-Scope-Key"] = scopeKey;
        }

        const req = http.request(options, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString();
                let data = null;
                if (raw.length > 0) {
                    try { data = JSON.parse(raw); } catch { data = raw; }
                }
                resolve({ status: res.statusCode, data });
            });
        });

        req.on("error", (err) => reject(err));
        req.on("timeout", () => { req.destroy(); reject(new Error("PKM API request timed out")); });

        if (body != null) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// ── Tool handlers ───────────────────────────────────────────

function ok(text) {
    return { content: [{ type: "text", text }] };
}

function err(text) {
    return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

/**
 * Render structured memory data as an ASCII directory tree.
 * @param {object} data — from getMemoryMap()
 * @returns {string}
 */
function renderMemoryMap(data) {
    const pad = (label, count, width = 24) => {
        const dots = Math.max(2, width - label.length - String(count).length);
        return `${label} ${"·".repeat(dots)} ${count}`;
    };

    const lines = [];
    const total = data.total || 0;
    const archived = data.archived || 0;
    const uncategorized = data.uncategorized || 0;

    lines.push(`📚 Memory Map  (${total} active, ${archived} archived)`);
    lines.push("│");

    const tree = data.topicTree || [];
    if (tree.length) {
        lines.push("├── 🌳 Topics");
        const renderTopic = (topic, prefix, isLast) => {
            const branch = isLast ? "└──" : "├──";
            const icon = topic.icon || "📁";
            lines.push(`${prefix}${branch} ${icon} ${pad(topic.name, topic.note_count || 0)}`);
            const children = topic.children || [];
            const childPrefix = prefix + (isLast ? "    " : "│   ");
            children.forEach((child, i) => {
                renderTopic(child, childPrefix, i === children.length - 1);
            });
        };
        tree.forEach((topic, i) => {
            renderTopic(topic, "│   ", i === tree.length - 1);
        });
        if (uncategorized > 0) {
            lines.push(`│   └── 📋 ${pad("Uncategorized", uncategorized)}`);
        }
    } else {
        lines.push("├── 🌳 Topics (none — memories are uncategorized)");
    }
    lines.push("│");

    const types = data.byType || [];
    if (types.length) {
        lines.push("├── 📂 By Type");
        types.forEach((t, i) => {
            const branch = i < types.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(t.type || "unknown", t.cnt)}`);
        });
    }
    lines.push("│");

    const collections = data.collections || [];
    if (collections.length) {
        lines.push("├── 📦 Collections");
        collections.forEach((c, i) => {
            const branch = i < collections.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(c.name, `${c.item_count} items`)}`);
        });
        lines.push("│");
    }

    const entities = data.entities || [];
    if (entities.length) {
        lines.push(`├── 👤 Entities (${entities.length})`);
        entities.forEach((e, i) => {
            const branch = i < entities.length - 1 ? "├──" : "└──";
            const typeLabel = e.type ? ` [${e.type}]` : "";
            lines.push(`│   ${branch} ${pad(e.name + typeLabel, `${e.note_count} linked`)}`);
        });
        lines.push("│");
    }

    const bridges = data.bridges || [];
    if (bridges.length) {
        lines.push("├── 🌉 Cross-Topic Bridges");
        bridges.forEach((b, i) => {
            const branch = i < bridges.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${b.topic1_name} ↔ ${b.topic2_name} (${b.shared_count} shared)`);
        });
        lines.push("│");
    }

    const months = data.byMonth || [];
    if (months.length) {
        lines.push("├── 📅 Timeline");
        months.forEach((m, i) => {
            const branch = i < months.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(m.month, m.cnt)}`);
        });
        lines.push("│");
    }

    if (data.household) {
        lines.push(`└── 🏠 Household: ${data.household.name}`);
        lines.push(`    ├── ${pad("members", data.household.members)}`);
        lines.push(`    └── ${pad("shared memories", data.household.sharedMemories)}`);
    } else if (lines[lines.length - 1] === "│") {
        lines.pop();
    }

    return lines.join("\n");
}

async function handleTool(name, args) {
    try {
        switch (name) {
            // ── remember: simplified write ──────────────────
            case "remember": {
                const { content, scope, title, type, importance, pinned } = args || {};
                if (!content) return err("content is required");
                const payload = { content, scope, title, type, importance, pinned };
                const { status, data } = await apiCall("POST", "/api/pkm/remember", payload);
                if (status === 201 || status === 200) {
                    const pin = data?.pinned ? " 📌" : "";
                    return ok(`📝 Remembered: ${data?.title || "(untitled)"}${pin}\nType: ${data?.type || "fact"} | ID: ${data?.id}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            // ── recall: simplified search ───────────────────
            case "recall": {
                const { query, scope = "user", limit } = args || {};
                if (!query) return err("query is required");
                const { status, data } = await apiCall("POST", "/api/pkm/recall", { query, scope, limit });
                if (status === 200) {
                    const results = Array.isArray(data) ? data : data?.results;
                    const expanded = data?.expanded;
                    if (!results?.length) return ok("No memories found.");
                    const lines = results.map((note, i) => {
                        const linked = note._entityLinked ? " 🔗" : "";
                        return `${i + 1}. [${note.type}] ${note.title || "(untitled)"}${linked}\n   ${note.content?.substring(0, 200) || ""}\n   📅 ${note.created_at?.substring(0, 10)} | ID: ${note.id}`;
                    });
                    let text = `Found ${results.length} memories:\n\n${lines.join("\n\n")}`;
                    if (expanded?.length) {
                        const expLines = expanded.map((note, i) =>
                            `${i + 1}. [${note.type}] ${note.title || "(untitled)"}\n   ${note.content?.substring(0, 200) || ""}`
                        );
                        text += `\n\n── Related ──\n\n${expLines.join("\n\n")}`;
                    }
                    return ok(text);
                }
                return err(data?.error || `API error (${status})`);
            }

            // ── memory_admin: all other operations ──────────
            case "memory_admin": {
                const { action, scope = "user" } = args || {};
                if (!action) return err("action is required");
                const isAgent = scope === "agent";

                // get/update/delete/link
                if (action === "get") {
                    const { id } = args || {};
                    if (!id) return err("id is required");
                    const { status, data } = await apiCall("GET", `/api/pkm/notes/${encodeURIComponent(id)}`);
                    if (status === 200) return ok(JSON.stringify(data, null, 2));
                    if (status === 404) return err("Memory not found");
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "update") {
                    const { id, title, content, tags, archive } = args || {};
                    if (!id) return err("id is required");
                    const path = isAgent ? `/api/pkm/agent/notes/${encodeURIComponent(id)}` : `/api/pkm/notes/${encodeURIComponent(id)}`;
                    const { status, data } = await apiCall("PUT", path, { title, content, tags, archive });
                    if (status === 200) return ok(`✅ Updated: ${id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "delete") {
                    const { id } = args || {};
                    if (!id) return err("id is required");
                    const path = isAgent ? `/api/pkm/agent/notes/${encodeURIComponent(id)}` : `/api/pkm/notes/${encodeURIComponent(id)}`;
                    const { status, data } = await apiCall("DELETE", path);
                    if (status === 200 || status === 204) return ok(`🗑️ Deleted: ${id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "link") {
                    const { source_id, target_id, relation } = args || {};
                    if (!source_id || !target_id) return err("source_id and target_id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/link", { source_id, target_id, relation });
                    if (status === 201 || status === 200) return ok("🔗 Linked");
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "pin") {
                    const { id } = args || {};
                    if (!id) return err("id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/pin", { id });
                    if (status === 200) return ok(`📌 Pinned to core memory: ${id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "unpin") {
                    const { id } = args || {};
                    if (!id) return err("id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/unpin", { id });
                    if (status === 200) return ok(`📌 Unpinned from core memory: ${id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "dream") {
                    const { synthesize } = args || {};
                    const { status, data } = await apiCall("POST", "/api/pkm/dream", { scope, synthesize });
                    if (status === 200) {
                        const r = data;
                        const parts = [`🌙 Dream complete`];
                        if (r.harvested) parts.push(`📥 Harvested: ${r.harvested} memories from sessions`);
                        if (r.curated) parts.push(`🧹 Curated: ${r.curated} memories pinned/unpinned/archived`);
                        if (r.contradictions) parts.push(`⚔️ Contradictions: ${r.contradictions} resolved`);
                        if (r.merged) parts.push(`🔗 Merged: ${r.merged} groups consolidated`);
                        if (r.synthesized) parts.push(`💡 Synthesized: ${r.synthesized} new inferred facts`);
                        if (r.stale) parts.push(`⏳ Stale: ${r.stale} flagged for confirmation`);
                        if (r.entities) parts.push(`👤 Entities: ${r.entities} relationships mapped`);
                        if (r.suggestions) parts.push(`💭 Suggestions: ${r.suggestions} proactive insights`);
                        if (r.compacted) parts.push(`🗜️ Compacted: ${r.compacted} old sessions cleaned`);
                        return ok(parts.join("\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }

                // navigate: map, browse, context, timeline
                if (action === "map") {
                    const { status, data } = await apiCall("GET", "/api/pkm/map");
                    if (status === 200) return ok(renderMemoryMap(data));
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "browse") {
                    const { topic_id, sort, limit } = args || {};
                    if (!topic_id) return err("topic_id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/browse", { topic_id, sort, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No notes in topic.");
                        return ok(data.results.map((n, i) => `${i + 1}. [${n.type}] ${n.title || "(untitled)"}\n   📅 ${n.created_at?.substring(0, 10)} | ID: ${n.id}`).join("\n\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "context") {
                    const { id, limit } = args || {};
                    if (!id) return err("id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/context", { note_id: id, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No related notes.");
                        return ok(data.results.map((n, i) => `${i + 1}. [${n.type}] ${n.title || "(untitled)"}\n   via ${n.relation_source} | ID: ${n.id}`).join("\n\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "timeline") {
                    const { period, limit } = args || {};
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/timeline", { period, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No timeline data.");
                        return ok(data.results.map((e, i) => `${i + 1}. ${e.period} — ${e.noteCount} notes`).join("\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }

                // stats, settings, topics, maintenance
                if (action === "stats") {
                    const { status, data } = await apiCall("GET", "/api/pkm/stats");
                    if (status === 200) {
                        const typeStr = data.byType ? Object.entries(data.byType).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (none)";
                        return ok(`📊 Total: ${data.total}\n\nBy type:\n${typeStr}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "settings") {
                    const { settings_action, key, value } = args || {};
                    if (settings_action === "set") {
                        if (!key) return err("key required");
                        const { status, data } = await apiCall("PUT", "/api/pkm/settings", { [key]: value });
                        if (status === 200) return ok(`✅ ${key} = ${value}`);
                        return err(data?.error || `API error (${status})`);
                    }
                    const { status, data } = await apiCall("GET", "/api/pkm/settings");
                    if (status === 200) return ok(JSON.stringify(data, null, 2));
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "topic_create") {
                    const { name, parent_id, icon, description } = args || {};
                    if (!name) return err("name required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/create", { name, parent_id, icon, description });
                    if (status === 201 || status === 200) return ok(`📁 Topic: ${data?.name || name} | ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "topic_move") {
                    const { topic_id, new_parent_id } = args || {};
                    if (!topic_id) return err("topic_id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/move", { topic_id, new_parent_id });
                    if (status === 200) return ok(`✅ Moved: ${topic_id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "topic_merge") {
                    const { source_id, target_id } = args || {};
                    if (!source_id || !target_id) return err("source_id and target_id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/merge", { source_id, target_id });
                    if (status === 200) return ok(`✅ Merged: ${source_id} → ${target_id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "maintain") {
                    const { status, data } = await apiCall("POST", "/api/pkm/maintain");
                    if (status === 200) return ok("🛠️ Maintenance complete");
                    return err(data?.error || `API error (${status})`);
                }

                // collections
                if (action === "collection_create") {
                    const { name, schema, description, topic_id } = args || {};
                    if (!name || !schema) return err("name and schema required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/create", { name, schema, description, topic_id });
                    if (status === 201 || status === 200) return ok(`📦 Collection: ${data?.name || name} | ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "collection_add") {
                    const { collection_id, data: itemData, title } = args || {};
                    if (!collection_id || !itemData) return err("collection_id and data required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/add", { collection_id, data: itemData, title });
                    if (status === 201 || status === 200) return ok(`📝 Added: ${title || "(untitled)"} | ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "collection_query") {
                    const { collection_id, filter, sort_by, limit } = args || {};
                    if (!collection_id) return err("collection_id required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/query", { collection_id, filter, sort_by, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No items matched.");
                        return ok(data.results.map((item, i) => `${i + 1}. ${item.title || "(untitled)"} | ID: ${item.id}`).join("\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }
                if (action === "collection_list") {
                    const { status, data } = await apiCall("GET", "/api/pkm/collections");
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No collections.");
                        return ok(data.results.map((c, i) => `${i + 1}. ${c.name} (${c.item_count} items) | ID: ${c.id}`).join("\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }

                // entity search
                if (action === "entity_search") {
                    const { query, limit } = args || {};
                    if (!query) return err("query required");
                    const { status, data } = await apiCall("POST", "/api/pkm/entities", { query, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No entities found.");
                        return ok(data.results.map((e, i) => `${i + 1}. ${e.name}${e.type ? ` [${e.type}]` : ""} — ${e.note_count} notes | ID: ${e.id}`).join("\n"));
                    }
                    return err(data?.error || `API error (${status})`);
                }

                return err(`Unknown action: ${action}`);
            }

            // Backward compatibility: route old tool names to new handlers
            case "pkm_memory": return handleTool("memory_admin", { ...args, action: args?.action === "write" ? null : args?.action });
            case "pkm_search": return handleTool("recall", { query: args?.query, scope: args?.scope, limit: args?.limit });
            case "pkm_navigate": return handleTool("memory_admin", args);
            case "pkm_collection": return handleTool("memory_admin", { ...args, action: `collection_${args?.action}` });
            case "pkm_manage": return handleTool("memory_admin", args);

            default:
                return err(`Unknown tool: ${name}`);
        }
    } catch (e) {
        log.error(`Tool ${name} error: ${e.message}`);
        return err(e.message);
    }
}

// ── JSON-RPC handlers ───────────────────────────────────────

let clientProtocolVersion = "2025-11-25";

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handleInitialize(id, params) {
    if (params?.protocolVersion) clientProtocolVersion = params.protocolVersion;
    send(id, {
        protocolVersion: clientProtocolVersion,
        serverInfo: { name: "memory", version: "4.0.0" },
        capabilities: { tools: {} },
    });
}

function handleToolsList(id) {
    send(id, { tools: TOOLS });
}

async function handleToolsCall(id, params) {
    if (!params || typeof params !== "object") {
        sendError(id, -32602, "Invalid params");
        return;
    }
    const { name, arguments: args } = params;
    pendingCalls++;
    try {
        const result = await handleTool(name, args || {});
        send(id, result);
    } catch (e) {
        send(id, err(e.message));
    } finally {
        pendingCalls--;
        checkExit();
    }
}

// ── Stdio NDJSON framing ────────────────────────────────────

function handleMessage(msg) {
    if (msg.id === undefined || msg.id === null) return;

    switch (msg.method) {
        case "initialize":
            handleInitialize(msg.id, msg.params);
            break;
        case "tools/list":
            handleToolsList(msg.id);
            break;
        case "tools/call":
            handleToolsCall(msg.id, msg.params);
            break;
        default:
            sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}

let lineBuf = "";
const MAX_BUF = 1024 * 1024;
let pendingCalls = 0;
let stdinEnded = false;

function checkExit() {
    if (stdinEnded && pendingCalls === 0) process.exit(0);
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
    lineBuf += chunk;
    if (lineBuf.length > MAX_BUF) {
        process.stderr.write("pkm-mcp: line buffer exceeded 1MB, resetting\n");
        lineBuf = "";
        return;
    }
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            handleMessage(JSON.parse(line));
        } catch { /* skip malformed */ }
    }
});
process.stdin.on("end", () => {
    stdinEnded = true;
    checkExit();
});
process.stdin.on("error", () => process.exit(1));
process.stdout.on("error", () => process.exit(1));
