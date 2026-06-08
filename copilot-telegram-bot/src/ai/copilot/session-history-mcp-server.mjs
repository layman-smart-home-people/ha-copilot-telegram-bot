#!/usr/bin/env node
// MCP server for cross-session history — lets agents query what other agents did.
// Uses node:sqlite (Node 22+) to read the shared session-store.db.
// No npm dependencies.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const COPILOT_HOME = process.env.COPILOT_HOME || "/share/copilot-tools/.copilot";
const DB_PATH = process.env.SESSION_STORE_PATH || join(COPILOT_HOME, "session-store.db");

function log(msg) { process.stderr.write(`[session-history] ${msg}\n`); }

// ── Tool definitions ────────────────────────────────────────

const TOOLS = [
    {
        name: "session_search",
        description: "Search session history across ALL agent sessions. Use this to find what other agents did — cloned repos, code changes, decisions made, tasks completed. Search by keyword in session summaries, checkpoint titles, and user messages.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Search keyword(s). Searches checkpoint titles, overviews, and session summaries. Examples: 'clone repo', 'auth module', 'dashboard'",
                },
                days: {
                    type: "number",
                    description: "How many days back to search (default: 7)",
                },
                limit: {
                    type: "number",
                    description: "Max results to return (default: 10, max: 50)",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "session_list_recent",
        description: "List recent agent sessions with their summaries and checkpoint titles. Use to get an overview of what work has been done recently.",
        inputSchema: {
            type: "object",
            properties: {
                days: {
                    type: "number",
                    description: "How many days back to list (default: 3)",
                },
                limit: {
                    type: "number",
                    description: "Max sessions to return (default: 10, max: 30)",
                },
            },
        },
    },
    {
        name: "session_get_details",
        description: "Get detailed information about a specific session — its checkpoints, recent turns, file changes, and refs. Use after session_search or session_list_recent to dive deeper.",
        inputSchema: {
            type: "object",
            properties: {
                session_id: {
                    type: "string",
                    description: "The session UUID to retrieve details for",
                },
                include_turns: {
                    type: "boolean",
                    description: "Include recent turns/messages (default: true). Set false for just checkpoints.",
                },
                max_turns: {
                    type: "number",
                    description: "Max turns to include (default: 10, max: 50)",
                },
            },
            required: ["session_id"],
        },
    },
];

// ── Database helpers ────────────────────────────────────────

function openDb() {
    if (!existsSync(DB_PATH)) {
        throw new Error(`Session store not found: ${DB_PATH}`);
    }
    return new DatabaseSync(DB_PATH, { open: true });
}

function safeClose(db) {
    try { db?.close(); } catch {}
}

// ── Tool handlers ───────────────────────────────────────────

function handleTool(name, args) {
    const db = openDb();
    try {
        switch (name) {
            case "session_search":
                return searchSessions(db, args);
            case "session_list_recent":
                return listRecentSessions(db, args);
            case "session_get_details":
                return getSessionDetails(db, args);
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    } finally {
        safeClose(db);
    }
}

function searchSessions(db, { query, days = 7, limit = 10 }) {
    limit = Math.min(Math.max(limit || 10, 1), 50);
    const cutoff = daysAgo(days);
    const pattern = `%${query}%`;

    // Search checkpoints (richest data)
    const checkpointHits = db.prepare(`
        SELECT DISTINCT s.id as session_id, s.created_at,
               c.title as checkpoint_title, 
               substr(c.overview, 1, 300) as overview,
               c.checkpoint_number
        FROM checkpoints c
        JOIN sessions s ON c.session_id = s.id
        WHERE s.created_at > ?
          AND (c.title LIKE ? OR c.overview LIKE ? OR c.work_done LIKE ?)
        ORDER BY s.created_at DESC
        LIMIT ?
    `).all(cutoff, pattern, pattern, pattern, limit);

    // Search turns (user messages)
    const turnHits = db.prepare(`
        SELECT DISTINCT s.id as session_id, s.created_at,
               substr(t.user_message, 1, 200) as message_preview,
               t.turn_index
        FROM turns t
        JOIN sessions s ON t.session_id = s.id
        WHERE s.created_at > ?
          AND t.user_message LIKE ?
        ORDER BY t.timestamp DESC
        LIMIT ?
    `).all(cutoff, pattern, limit);

    const results = { checkpoints: checkpointHits, turns: turnHits };
    const text = formatSearchResults(query, results);
    return { content: [{ type: "text", text }] };
}

function listRecentSessions(db, { days = 3, limit = 10 } = {}) {
    limit = Math.min(Math.max(limit || 10, 1), 30);
    const cutoff = daysAgo(days);

    const sessions = db.prepare(`
        SELECT s.id, s.cwd, s.created_at, s.updated_at
        FROM sessions s
        WHERE s.created_at > ?
        ORDER BY s.created_at DESC
        LIMIT ?
    `).all(cutoff, limit);

    // Enrich with checkpoint titles
    for (const sess of sessions) {
        const checkpoints = db.prepare(`
            SELECT checkpoint_number, title 
            FROM checkpoints 
            WHERE session_id = ? 
            ORDER BY checkpoint_number
        `).all(sess.id);
        sess.checkpoints = checkpoints;

        const turnCount = db.prepare(
            `SELECT count(*) as n FROM turns WHERE session_id = ?`
        ).get(sess.id);
        sess.turn_count = turnCount.n;
    }

    const text = formatSessionList(sessions);
    return { content: [{ type: "text", text }] };
}

function getSessionDetails(db, { session_id, include_turns = true, max_turns = 10 }) {
    max_turns = Math.min(Math.max(max_turns || 10, 1), 50);

    const session = db.prepare(
        `SELECT * FROM sessions WHERE id = ?`
    ).get(session_id);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${session_id}` }], isError: true };
    }

    // Checkpoints
    const checkpoints = db.prepare(`
        SELECT checkpoint_number, title, 
               substr(overview, 1, 500) as overview,
               substr(work_done, 1, 500) as work_done,
               substr(next_steps, 1, 500) as next_steps,
               created_at
        FROM checkpoints 
        WHERE session_id = ? 
        ORDER BY checkpoint_number
    `).all(session_id);

    // File changes
    const files = db.prepare(`
        SELECT file_path, tool_name, turn_index 
        FROM session_files 
        WHERE session_id = ? 
        ORDER BY first_seen_at
    `).all(session_id);

    // Refs (commits, PRs, issues)
    const refs = db.prepare(`
        SELECT ref_type, ref_value, turn_index 
        FROM session_refs 
        WHERE session_id = ? 
        ORDER BY created_at
    `).all(session_id);

    // Recent turns (user messages only, truncated)
    let turns = [];
    if (include_turns) {
        turns = db.prepare(`
            SELECT turn_index, 
                   substr(user_message, 1, 300) as user_message,
                   substr(assistant_response, 1, 500) as assistant_response,
                   timestamp
            FROM turns 
            WHERE session_id = ? 
            ORDER BY turn_index DESC 
            LIMIT ?
        `).all(session_id, max_turns).reverse();
    }

    const text = formatSessionDetails({ session, checkpoints, files, refs, turns });
    return { content: [{ type: "text", text }] };
}

// ── Formatting helpers ──────────────────────────────────────

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
}

function formatSearchResults(query, { checkpoints, turns }) {
    const lines = [`## Session Search: "${query}"\n`];

    if (checkpoints.length) {
        lines.push(`### Checkpoint matches (${checkpoints.length}):`);
        for (const c of checkpoints) {
            lines.push(`- **[${c.session_id.slice(0, 8)}]** ${c.checkpoint_title || "(untitled)"}`);
            if (c.overview) lines.push(`  ${c.overview.slice(0, 200)}`);
            lines.push(`  _${c.created_at}_`);
        }
    }

    if (turns.length) {
        lines.push(`\n### Turn matches (${turns.length}):`);
        for (const t of turns) {
            const preview = cleanPreview(t.message_preview);
            lines.push(`- **[${t.session_id.slice(0, 8)}]** turn ${t.turn_index}: ${preview}`);
        }
    }

    if (!checkpoints.length && !turns.length) {
        lines.push("No results found.");
    }

    return lines.join("\n");
}

function formatSessionList(sessions) {
    if (!sessions.length) return "No recent sessions found.";

    const lines = [`## Recent Sessions (${sessions.length})\n`];
    for (const s of sessions) {
        const titles = s.checkpoints?.map(c => c.title).filter(Boolean).join(" → ") || "(no checkpoints)";
        lines.push(`**${s.id.slice(0, 8)}** — ${s.turn_count} turns — ${s.created_at}`);
        lines.push(`  📋 ${titles}`);
    }
    return lines.join("\n");
}

function formatSessionDetails({ session, checkpoints, files, refs, turns }) {
    const lines = [`## Session ${session.id}\n`];
    lines.push(`- **Created**: ${session.created_at}`);
    lines.push(`- **CWD**: ${session.cwd || "/config"}`);

    if (checkpoints.length) {
        lines.push(`\n### Checkpoints (${checkpoints.length}):`);
        for (const c of checkpoints) {
            lines.push(`\n#### ${c.checkpoint_number}. ${c.title || "(untitled)"}`);
            if (c.overview) lines.push(c.overview);
            if (c.work_done) lines.push(`\n**Work done:** ${c.work_done}`);
            if (c.next_steps) lines.push(`\n**Next steps:** ${c.next_steps}`);
        }
    }

    if (files.length) {
        lines.push(`\n### Files changed (${files.length}):`);
        for (const f of files) lines.push(`- \`${f.file_path}\` (${f.tool_name || "edit"})`);
    }

    if (refs.length) {
        lines.push(`\n### Refs:`);
        for (const r of refs) lines.push(`- ${r.ref_type}: ${r.ref_value}`);
    }

    if (turns.length) {
        lines.push(`\n### Recent turns (${turns.length}):`);
        for (const t of turns) {
            const msg = cleanPreview(t.user_message);
            lines.push(`\n**Turn ${t.turn_index}** (${t.timestamp}):`);
            lines.push(`User: ${msg}`);
            if (t.assistant_response) {
                lines.push(`Agent: ${cleanPreview(t.assistant_response)}`);
            }
        }
    }

    return lines.join("\n");
}

function cleanPreview(text) {
    if (!text) return "(empty)";
    // Strip bot metadata prefix for readability
    return text
        .replace(/\[Bot configuration[^\]]*\]\s*/g, "")
        .replace(/\[Via Telegram\]\s*/g, "")
        .replace(/\[Sender:[^\]]*\]\s*/g, "")
        .replace(/\[📌[^\]]*\]\s*/g, "")
        .replace(/\[Replying to[^\]]*\]\s*/g, "")
        .trim()
        .slice(0, 200);
}

// ── MCP protocol plumbing ───────────────────────────────────

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

let clientProtocolVersion = "2025-11-25";

function handleInitialize(id, params) {
    if (params?.protocolVersion) clientProtocolVersion = params.protocolVersion;
    send(id, {
        protocolVersion: clientProtocolVersion,
        serverInfo: { name: "session-history", version: "1.0.0" },
        capabilities: { tools: {} },
    });
}

function handleToolsList(id) {
    send(id, { tools: TOOLS });
}

function handleToolsCall(id, params) {
    if (!params || typeof params !== "object") {
        sendError(id, -32602, "Invalid params");
        return;
    }
    const { name, arguments: args } = params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
        sendError(id, -32602, `Unknown tool: ${name}`);
        return;
    }
    log(`${name} called`);
    pendingCalls++;
    try {
        const result = handleTool(name, args || {});
        send(id, result);
    } catch (err) {
        log(`${name} error: ${err.message}`);
        send(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
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
        process.stderr.write("session-history: line buffer exceeded 1MB, resetting\n");
        lineBuf = "";
        return;
    }
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            handleMessage(JSON.parse(line));
        } catch (e) {
            log(`Parse error: ${e.message}`);
        }
    }
});

process.stdin.on("end", () => {
    stdinEnded = true;
    checkExit();
});

log(`Session History MCP server started (db: ${DB_PATH})`);
