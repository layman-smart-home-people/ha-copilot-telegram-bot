#!/usr/bin/env node
// MCP server for PKM (Personal Knowledge Management) — raw JSON-RPC over stdio (NDJSON framing).
// Exposes 10 tools (8 user-facing + 2 agent-private) that call the bot's REST API.
// Same pattern as si-mcp-server.mjs. No npm dependencies.
// Access control: user_id/scope derived server-side from session context, never from tool params.

import http from "node:http";

const API_BASE = process.env.PKM_API_BASE || "http://localhost:8099";
const SCOPE_KEY = process.env.TG_UX_SCOPE_KEY || null;

function log(msg) { process.stderr.write(`[pkm-mcp] ${msg}\n`); }

// ── Tool definitions ────────────────────────────────────────

const TOOLS = [
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

    lines.push(`📚 Memory Map  (${total} active, ${archived} archived)`);
    lines.push("│");

    // Types
    const types = data.byType || [];
    if (types.length) {
        lines.push("├── 📂 By Type");
        types.forEach((t, i) => {
            const branch = i < types.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(t.type || "unknown", t.cnt)}`);
        });
    } else {
        lines.push("├── 📂 By Type (empty)");
    }
    lines.push("│");

    // Tags
    const tags = data.byTag || [];
    if (tags.length) {
        lines.push("├── 🏷️  Top Tags");
        tags.forEach((t, i) => {
            const branch = i < tags.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad("#" + t.tag, t.cnt)}`);
        });
    } else {
        lines.push("├── 🏷️  Tags (none yet)");
    }
    lines.push("│");

    // Entities
    const entities = data.entities || [];
    if (entities.length) {
        lines.push(`├── 👤 Entities (${entities.length})`);
        entities.forEach((e, i) => {
            const branch = i < entities.length - 1 ? "├──" : "└──";
            const typeLabel = e.type ? ` [${e.type}]` : "";
            lines.push(`│   ${branch} ${pad(e.name + typeLabel, e.note_count + " linked")}`);
        });
    } else {
        lines.push("├── 👤 Entities (none yet)");
    }
    lines.push("│");

    // Timeline
    const months = data.byMonth || [];
    if (months.length) {
        lines.push("├── 📅 Timeline");
        months.forEach((m, i) => {
            const branch = i < months.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(m.month, m.cnt)}`);
        });
    } else {
        lines.push("├── 📅 Timeline (empty)");
    }
    lines.push("│");

    // Sources
    const sources = data.bySource || [];
    if (sources.length) {
        lines.push("├── 🔍 Sources");
        sources.forEach((s, i) => {
            const branch = i < sources.length - 1 ? "├──" : "└──";
            lines.push(`│   ${branch} ${pad(s.source_type || "unknown", s.cnt)}`);
        });
    } else {
        lines.push("├── 🔍 Sources (none)");
    }
    lines.push("│");

    // Durability
    const dur = data.byDurability || [];
    if (dur.length) {
        const isLast = !data.household;
        const mainBranch = isLast ? "└──" : "├──";
        lines.push(`${mainBranch} 💎 Durability`);
        dur.forEach((d, i) => {
            const prefix = isLast ? "    " : "│   ";
            const branch = i < dur.length - 1 ? "├──" : "└──";
            lines.push(`${prefix}${branch} ${pad(d.durability || "normal", d.cnt)}`);
        });
    }

    // Household
    if (data.household) {
        lines.push("│");
        lines.push(`└── 🏠 Household: ${data.household.name}`);
        lines.push(`    ├── ${pad("members", data.household.members)}`);
        lines.push(`    └── ${pad("shared memories", data.household.sharedMemories)}`);
    }

    return lines.join("\n");
}

async function handleTool(name, args) {
    try {
        switch (name) {
            case "pkm_search": {
                const { query, ...filters } = args || {};
                if (!query) return err("query is required");
                const { status, data } = await apiCall("POST", "/api/pkm/search", { query, ...filters });
                if (status === 200) {
                    if (!data?.results?.length) return ok("No memories found matching that query.");
                    const lines = data.results.map((r, i) =>
                        `${i + 1}. [${r.type}] ${r.title || "(untitled)"}\n   ${r.content?.substring(0, 200)}\n   📅 ${r.created_at?.substring(0, 10)} | ID: ${r.id}`
                    );
                    return ok(`Found ${data.results.length} memories:\n\n${lines.join("\n\n")}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_write": {
                const { content, ...opts } = args || {};
                if (!content) return err("content is required");
                const { status, data } = await apiCall("POST", "/api/pkm/write", { content, ...opts });
                if (status === 201 || status === 200) {
                    return ok(`📝 Memory saved: ${data?.title || "(untitled)"}\nID: ${data?.id}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_get": {
                const { id } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("GET", `/api/pkm/notes/${encodeURIComponent(id)}`);
                if (status === 200) return ok(JSON.stringify(data, null, 2));
                if (status === 404) return err("Memory not found");
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_update": {
                const { id, ...updates } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("PUT", `/api/pkm/notes/${encodeURIComponent(id)}`, updates);
                if (status === 200) return ok(`✅ Memory updated: ${id}`);
                if (status === 404) return err("Memory not found");
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_recent": {
                const { days, limit } = args || {};
                const { status, data } = await apiCall("POST", "/api/pkm/recent", { days, limit });
                if (status === 200) {
                    if (!data?.length) return ok("No recent memories.");
                    const lines = data.map(r =>
                        `• ${r.created_at?.substring(0, 10)} [${r.type}] ${r.title || "(untitled)"}`
                    );
                    return ok(`Recent memories:\n\n${lines.join("\n")}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_stats": {
                const { status, data } = await apiCall("GET", "/api/pkm/stats");
                if (status === 200) {
                    const typeStr = data.byType
                        ? Object.entries(data.byType).map(([k, v]) => `  ${k}: ${v}`).join("\n")
                        : "  (none)";
                    return ok(`📊 Memory Statistics:\n\nTotal: ${data.total}\n\nBy type:\n${typeStr}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_delete": {
                const { id } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("DELETE", `/api/pkm/notes/${encodeURIComponent(id)}`);
                if (status === 200 || status === 204) return ok(`🗑️ Memory securely deleted: ${id}`);
                if (status === 404) return err("Memory not found");
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_settings": {
                const { action, key, value } = args || {};
                if (action === "set" && key) {
                    const { status, data } = await apiCall("PUT", "/api/pkm/settings", { [key]: value });
                    if (status === 200) return ok(`✅ Setting updated: ${key} = ${value}`);
                    return err(data?.error || `API error (${status})`);
                }
                // Default: get settings
                const { status, data } = await apiCall("GET", "/api/pkm/settings");
                if (status === 200) return ok(JSON.stringify(data, null, 2));
                return err(data?.error || `API error (${status})`);
            }

            // Agent-private tools
            case "pkm_agent_search": {
                const { query, type, limit } = args || {};
                if (!query) return err("query is required");
                const { status, data } = await apiCall("POST", "/api/pkm/agent/search", { query, type, limit });
                if (status === 200) {
                    if (!data?.length) return ok("No relevant knowledge found in your memory.");
                    const lines = data.map((r, i) =>
                        `${i + 1}. [${r.type}] ${r.title || ""}: ${r.content?.substring(0, 300)}`
                    );
                    return ok(lines.join("\n\n"));
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_agent_write": {
                const { content, ...opts } = args || {};
                if (!content) return err("content is required");
                const { status, data } = await apiCall("POST", "/api/pkm/agent/write", { content, ...opts });
                if (status === 201 || status === 200) {
                    return ok(`📝 Noted in your memory: ${data?.title || "(stored)"}\nID: ${data?.id}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_agent_update": {
                const { id, ...updates } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("PUT", `/api/pkm/agent/notes/${encodeURIComponent(id)}`, updates);
                if (status === 200) return ok(`✅ Agent memory updated: ${id}`);
                if (status === 404) return err("Memory not found (or not an agent note)");
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_agent_delete": {
                const { id } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("DELETE", `/api/pkm/agent/notes/${encodeURIComponent(id)}`);
                if (status === 200) return ok(`🗑️ Agent memory securely deleted: ${id}`);
                if (status === 404) return err("Memory not found (or not an agent note)");
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_entity_search": {
                const { query, limit } = args || {};
                if (!query) return err("query is required");
                const { status, data } = await apiCall("POST", "/api/pkm/entities", { query, limit });
                if (status === 200) {
                    if (!data?.results?.length) return ok("No entities found matching that name.");
                    const lines = [];
                    for (const e of data.results) {
                        lines.push(`👤 **${e.name}** (${e.type || "unknown"}) — ${e.note_count} linked memories\n   ID: ${e.id}`);
                    }
                    return ok(`Found ${data.results.length} entities:\n\n${lines.join("\n\n")}`);
                }
                return err(data?.error || `API error (${status})`);
            }

            case "pkm_map": {
                const { status, data } = await apiCall("GET", "/api/pkm/map");
                if (status === 200) {
                    return ok(renderMemoryMap(data));
                }
                return err(data?.error || `API error (${status})`);
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
        serverInfo: { name: "pkm-tools", version: "1.1.0" },
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
