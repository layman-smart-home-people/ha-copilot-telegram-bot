#!/usr/bin/env node
// MCP server for PKM (Personal Knowledge Management) — raw JSON-RPC over stdio (NDJSON framing).
// Exposes 5 consolidated tools that call the bot's REST API.
// Same pattern as si-mcp-server.mjs. No npm dependencies.
// Access control: user_id/scope derived server-side from session context, never from tool params.

import http from "node:http";

const API_BASE = process.env.PKM_API_BASE || "http://localhost:8099";
const SCOPE_KEY = process.env.TG_UX_SCOPE_KEY || null;

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
        name: "pkm_memory",
        description:
            "Read, write, update, delete, or link memories. " +
            "Use scope='agent' for your own private operational notes. " +
            "Use scope='household' for shared family memories (requires membership).",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["write", "update", "delete", "get", "link"],
                    description: "Action to perform. write: save new memory. update: modify existing. delete: secure delete. get: retrieve by ID. link: link two notes.",
                },
                scope: {
                    type: "string",
                    enum: ["user", "agent", "household"],
                    description: "Memory scope (default: user). 'agent' for your private notes, 'household' for shared.",
                },
                content: { type: "string", description: "[write] The memory content — factual and self-contained" },
                title: { type: "string", description: "[write/update] Short summary (10-15 words)" },
                type: { type: "string", enum: ["fact", "preference", "event", "meeting", "health", "journal", "reflection"], description: "[write] Memory type (default: fact)" },
                tags: { type: "array", items: { type: "string" }, description: "[write/update] Category tags" },
                search_keywords: { type: "array", items: { type: "string" }, description: "[write] Keywords for search discoverability" },
                topics: { type: "array", items: { type: "string" }, description: "[write] Topic names to assign (max 2)" },
                importance: { type: "number", description: "[write] 0-1 importance score" },
                durability: { type: "string", enum: ["permanent", "normal", "ephemeral"], description: "[write] How long to keep (default: normal)" },
                id: { type: "string", description: "[update/delete/get] Memory note ID" },
                archive: { type: "boolean", description: "[update] Set true to archive (soft-retire)" },
                source_id: { type: "string", description: "[link] Source note ID" },
                target_id: { type: "string", description: "[link] Target note ID" },
                relation: { type: "string", description: "[link] Relation type (default: related)" },
            },
            required: ["action"],
        },
    },
    {
        name: "pkm_navigate",
        description:
            "Navigate the user's memory structure. " +
            "map: overview of topic tree + stats. browse: list notes in a topic. " +
            "context: find related notes (neighbors). timeline: notes grouped by period.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["map", "browse", "context", "timeline"],
                    description: "map: topic tree overview. browse: notes in a topic. context: neighbors of a note. timeline: time-grouped notes.",
                },
                scope: { type: "string", enum: ["user", "agent"], description: "Whose memories to navigate (default: user)" },
                topic_id: { type: "string", description: "[browse] Topic ID to browse" },
                sort: { type: "string", enum: ["activation", "date", "title"], description: "[browse] Sort order (default: activation)" },
                include_secondary: { type: "boolean", description: "[browse] Include notes with secondary topic assignment (default: true)" },
                note_id: { type: "string", description: "[context] Note ID to find neighbors for" },
                period: { type: "string", enum: ["week", "month", "year"], description: "[timeline] Grouping period (default: week)" },
                limit: { type: "number", description: "Max results" },
            },
            required: ["action"],
        },
    },
    {
        name: "pkm_search",
        description:
            "Search memories using full-text search with optional filters. " +
            "Supports entity search via entity_query parameter. " +
            "Use scope='agent' to search your own private notes.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query — use natural language" },
                entity_query: { type: "string", description: "Search by entity (person/place) name instead of full-text" },
                scope: { type: "string", enum: ["user", "agent", "household"], description: "Search scope (default: user)" },
                type: { type: "string", enum: ["fact", "preference", "event", "meeting", "health", "journal", "reflection"], description: "Filter by memory type" },
                topic: { type: "string", description: "Filter by topic name" },
                date_from: { type: "string", description: "ISO date — only memories after this" },
                date_to: { type: "string", description: "ISO date — only memories before this" },
                tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
                limit: { type: "number", description: "Max results (default: 7)" },
                queries: { type: "array", items: { type: "string" }, description: "Multiple queries (1-5) — results merged and deduplicated. Use instead of query for broader recall." },
                entity: { type: "string", description: "Filter results to notes linked to this entity name" },
                expand_context: { type: "boolean", description: "If true, also return related notes (neighbors of top results). Default: false" },
            },
        },
    },
    {
        name: "pkm_collection",
        description:
            "Manage structured data collections (e.g., reading lists, recipes, workout logs). " +
            "Collections have schemas and queryable items.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["create", "add", "query", "update", "remove", "list"],
                    description: "create: new collection. add: add item. query: search items. update: modify item. remove: delete item. list: all collections.",
                },
                name: { type: "string", description: "[create] Collection name" },
                schema: { type: "object", description: "[create] Schema definition (field names + types)" },
                description: { type: "string", description: "[create] Collection description" },
                topic_id: { type: "string", description: "[create] Link to a topic" },
                collection_id: { type: "string", description: "[add/query] Collection ID" },
                data: { type: "object", description: "[add/update] Item data matching schema" },
                title: { type: "string", description: "[add] Item title" },
                filter: { type: "object", description: "[query] Filter by field values" },
                sort_by: { type: "string", description: "[query] Sort by field name" },
                item_id: { type: "string", description: "[update/remove] Item (note) ID" },
                limit: { type: "number", description: "[query] Max results" },
            },
            required: ["action"],
        },
    },
    {
        name: "pkm_manage",
        description:
            "System management: stats, settings, topic management, and maintenance. " +
            "Topic actions create/move/merge topics in the hierarchy.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["stats", "settings", "topic_create", "topic_move", "topic_merge", "maintain"],
                    description: "stats: memory stats. settings: get/set PKM config. topic_create/move/merge: manage topics. maintain: run maintenance.",
                },
                settings_action: { type: "string", enum: ["get", "set"], description: "[settings] Get or set" },
                key: { type: "string", description: "[settings:set] Setting key" },
                value: { description: "[settings:set] New value" },
                name: { type: "string", description: "[topic_create] Topic name" },
                parent_id: { type: "string", description: "[topic_create/topic_move] Parent topic ID (null for root)" },
                icon: { type: "string", description: "[topic_create] Emoji icon" },
                description: { type: "string", description: "[topic_create] Topic description" },
                topic_id: { type: "string", description: "[topic_move/topic_merge] Topic ID" },
                new_parent_id: { type: "string", description: "[topic_move] New parent (null for root)" },
                source_id: { type: "string", description: "[topic_merge] Source topic to merge from" },
                target_id: { type: "string", description: "[topic_merge] Target topic to merge into" },
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
        if (SCOPE_KEY) {
            options.headers["X-Scope-Key"] = SCOPE_KEY;
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
            case "pkm_memory": {
                const { action, scope = "user" } = args || {};
                if (!action) return err("action is required");

                if (action === "write") {
                    const { content, title, type, tags, search_keywords, topics, importance, durability } = args || {};
                    if (!content) return err("content is required");
                    const path = scope === "agent" ? "/api/pkm/agent/write" : "/api/pkm/write";
                    const payload = scope === "agent"
                        ? { content, title, type, tags, search_keywords, durability, source_type: args?.source_type, topics }
                        : { content, title, type, tags, search_keywords, scope, topics, importance };
                    const { status, data } = await apiCall("POST", path, payload);
                    if (status === 201 || status === 200) {
                        return ok(`📝 Memory saved: ${title || data?.title || "(untitled)"}
ID: ${data?.id}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

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
                    const path = scope === "agent"
                        ? `/api/pkm/agent/notes/${encodeURIComponent(id)}`
                        : `/api/pkm/notes/${encodeURIComponent(id)}`;
                    const { status, data } = await apiCall("PUT", path, { title, content, tags, archive });
                    if (status === 200) return ok(`✅ Memory updated: ${id}`);
                    if (status === 404) return err("Memory not found");
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "delete") {
                    const { id } = args || {};
                    if (!id) return err("id is required");
                    const path = scope === "agent"
                        ? `/api/pkm/agent/notes/${encodeURIComponent(id)}`
                        : `/api/pkm/notes/${encodeURIComponent(id)}`;
                    const { status, data } = await apiCall("DELETE", path);
                    if (status === 200 || status === 204) return ok(`🗑️ Memory securely deleted: ${id}`);
                    if (status === 404) return err("Memory not found");
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "link") {
                    const { source_id, target_id, relation } = args || {};
                    if (!source_id || !target_id) return err("source_id and target_id are required");
                    const { status, data } = await apiCall("POST", "/api/pkm/link", { source_id, target_id, relation });
                    if (status === 201 || status === 200) return ok("🔗 Notes linked");
                    return err(data?.error || `API error (${status})`);
                }

                return err(`Unsupported pkm_memory action: ${action}`);
            }

            case "pkm_navigate": {
                const { action } = args || {};
                if (!action) return err("action is required");

                if (action === "map") {
                    const { status, data } = await apiCall("GET", "/api/pkm/map");
                    if (status === 200) return ok(renderMemoryMap(data));
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "browse") {
                    const { topic_id, sort, include_secondary, limit } = args || {};
                    if (!topic_id) return err("topic_id is required");
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/browse", { topic_id, sort, include_secondary, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No notes found in that topic.");
                        const lines = data.results.map((note, i) =>
                            `${i + 1}. [${note.type}] ${note.title || "(untitled)"}
   📅 ${note.created_at?.substring(0, 10)} | ID: ${note.id}`
                        );
                        return ok(`Topic notes:\n\n${lines.join("\n\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "context") {
                    const { note_id, limit } = args || {};
                    if (!note_id) return err("note_id is required");
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/context", { note_id, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No related notes found.");
                        const lines = data.results.map((note, i) =>
                            `${i + 1}. [${note.type}] ${note.title || "(untitled)"}
   via ${note.relation_source} | activation: ${note.activation ?? 0} | ID: ${note.id}`
                        );
                        return ok(`Related notes:\n\n${lines.join("\n\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "timeline") {
                    const { period, limit } = args || {};
                    const { status, data } = await apiCall("POST", "/api/pkm/navigate/timeline", { period, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No timeline data available.");
                        const lines = data.results.map((entry, i) =>
                            `${i + 1}. ${entry.period} — ${entry.noteCount} notes${entry.types?.length ? ` (${entry.types.join(", ")})` : ""}`
                        );
                        return ok(`Timeline:\n\n${lines.join("\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                return err(`Unsupported pkm_navigate action: ${action}`);
            }

            case "pkm_search": {
                const { entity_query, query, queries, entity, expand_context, scope = "user", type, topic, date_from, date_to, tags, limit } = args || {};

                if (entity_query) {
                    const { status, data } = await apiCall("POST", "/api/pkm/entities", { query: entity_query, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No entities found matching that name.");
                        const lines = data.results.map((entity, i) =>
                            `${i + 1}. ${entity.name}${entity.type ? ` [${entity.type}]` : ""}
   ${entity.note_count} linked notes | ID: ${entity.id}`
                        );
                        return ok(`Found ${data.results.length} entities:\n\n${lines.join("\n\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                if (!query && (!queries || !queries.length)) return err("query or queries is required");
                const path = scope === "agent" ? "/api/pkm/agent/search" : "/api/pkm/search";
                const payload = scope === "agent"
                    ? { query, type, limit }
                    : { query, queries, type, date_from, date_to, tags, limit, topic, entity, scope, expand_context };
                const { status, data } = await apiCall("POST", path, payload);
                if (status === 200) {
                    const results = Array.isArray(data) ? data : data?.results;
                    const expanded = data?.expanded;
                    if (!results?.length) return ok("No memories found matching that query.");
                    const lines = results.map((note, i) =>
                        `${i + 1}. [${note.type}] ${note.title || "(untitled)"}
   ${note.content?.substring(0, 200) || ""}
   📅 ${note.created_at?.substring(0, 10)} | ID: ${note.id}`
                    );
                    let text = `Found ${results.length} memories:\n\n${lines.join("\n\n")}`;
                    if (expanded?.length) {
                        const expLines = expanded.map((note, i) =>
                            `${i + 1}. [${note.type}] ${note.title || "(untitled)"}
   ${note.content?.substring(0, 200) || ""}
   📅 ${note.created_at?.substring(0, 10)} | from: ${note._expandedFrom}`
                        );
                        text += `\n\n── Related (expanded context) ──\n\n${expLines.join("\n\n")}`;
                    }
                    return ok(text);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_collection": {
                const { action } = args || {};
                if (!action) return err("action is required");

                if (action === "create") {
                    const { name, schema, description, topic_id } = args || {};
                    if (!name || !schema) return err("name and schema are required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/create", { name, schema, description, topic_id });
                    if (status === 201 || status === 200) return ok(`📦 Collection created: ${data?.name || name}
ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "add") {
                    const { collection_id, data: itemData, title } = args || {};
                    if (!collection_id || !itemData) return err("collection_id and data are required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/add", { collection_id, data: itemData, title });
                    if (status === 201 || status === 200) return ok(`📝 Collection item added: ${title || "(untitled)"}
ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "query") {
                    const { collection_id, filter, sort_by, limit } = args || {};
                    if (!collection_id) return err("collection_id is required");
                    const { status, data } = await apiCall("POST", "/api/pkm/collection/query", { collection_id, filter, sort_by, limit });
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No collection items matched.");
                        const lines = data.results.map((item, i) =>
                            `${i + 1}. ${item.title || "(untitled)"}
   ID: ${item.id}`
                        );
                        return ok(`Collection results:\n\n${lines.join("\n\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "update") {
                    const { item_id, data: itemData } = args || {};
                    if (!item_id || !itemData) return err("item_id and data are required");
                    const { status, data } = await apiCall("PUT", `/api/pkm/collection/item/${encodeURIComponent(item_id)}`, { data: itemData });
                    if (status === 200) return ok(`✅ Collection item updated: ${item_id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "remove") {
                    const { item_id } = args || {};
                    if (!item_id) return err("item_id is required");
                    const { status, data } = await apiCall("DELETE", `/api/pkm/collection/item/${encodeURIComponent(item_id)}`);
                    if (status === 200 || status === 204) return ok(`🗑️ Collection item removed: ${item_id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "list") {
                    const { status, data } = await apiCall("GET", "/api/pkm/collections");
                    if (status === 200) {
                        if (!data?.results?.length) return ok("No collections found.");
                        const lines = data.results.map((collection, i) =>
                            `${i + 1}. ${collection.name}
   ${collection.item_count} items | ID: ${collection.id}`
                        );
                        return ok(`Collections:\n\n${lines.join("\n\n")}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                return err(`Unsupported pkm_collection action: ${action}`);
            }

            case "pkm_manage": {
                const { action } = args || {};
                if (!action) return err("action is required");

                if (action === "stats") {
                    const { status, data } = await apiCall("GET", "/api/pkm/stats");
                    if (status === 200) {
                        const typeStr = data.byType
                            ? Object.entries(data.byType).map(([key, value]) => `  ${key}: ${value}`).join("\n")
                            : "  (none)";
                        return ok(`📊 Memory Statistics:

Total: ${data.total}

By type:
${typeStr}`);
                    }
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "settings") {
                    const { settings_action, key, value } = args || {};
                    if (settings_action === "set") {
                        if (!key) return err("key is required");
                        const { status, data } = await apiCall("PUT", "/api/pkm/settings", { [key]: value });
                        if (status === 200) return ok(`✅ Setting updated: ${key} = ${value}`);
                        return err(data?.error || `API error (${status})`);
                    }
                    const { status, data } = await apiCall("GET", "/api/pkm/settings");
                    if (status === 200) return ok(JSON.stringify(data, null, 2));
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "topic_create") {
                    const { name, parent_id, icon, description } = args || {};
                    if (!name) return err("name is required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/create", { name, parent_id, icon, description });
                    if (status === 201 || status === 200) return ok(`📁 Topic created: ${data?.name || name}
ID: ${data?.id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "topic_move") {
                    const { topic_id, new_parent_id } = args || {};
                    if (!topic_id) return err("topic_id is required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/move", { topic_id, new_parent_id });
                    if (status === 200) return ok(`✅ Topic moved: ${topic_id}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "topic_merge") {
                    const { source_id, target_id } = args || {};
                    if (!source_id || !target_id) return err("source_id and target_id are required");
                    const { status, data } = await apiCall("POST", "/api/pkm/topics/merge", { source_id, target_id });
                    if (status === 200) return ok(`✅ Topics merged: ${source_id} → ${target_id}${data?.notes_moved != null ? `
Notes moved: ${data.notes_moved}` : ""}`);
                    return err(data?.error || `API error (${status})`);
                }

                if (action === "maintain") {
                    const { status, data } = await apiCall("POST", "/api/pkm/maintain");
                    if (status === 200) return ok("🛠️ Maintenance complete");
                    return err(data?.error || `API error (${status})`);
                }

                return err(`Unsupported pkm_manage action: ${action}`);
            }

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
        serverInfo: { name: "memory", version: "3.0.0" },
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
