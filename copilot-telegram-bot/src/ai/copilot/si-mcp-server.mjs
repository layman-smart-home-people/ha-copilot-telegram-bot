#!/usr/bin/env node
// MCP server for Standing Instructions — raw JSON-RPC over stdio (NDJSON framing).
// Exposes CRUD tools that call the bot's REST API (single source of truth for validation).
// No npm dependencies.

import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_BASE = process.env.SI_API_BASE || "http://localhost:8099";
const COPILOT_HOME = process.env.COPILOT_HOME || "";
const SCOPE_KEY_FILE = COPILOT_HOME ? join(COPILOT_HOME, ".scope-key") : "";

/** Read current scope key from file (written by pool on claim). */
function getScopeKey() {
    if (!SCOPE_KEY_FILE) return null;
    try {
        const key = readFileSync(SCOPE_KEY_FILE, "utf8").trim();
        return key || null;
    } catch { return null; }
}

function log(msg) { process.stderr.write(`[si-mcp] ${msg}\n`); }

// ── Tool definitions ────────────────────────────────────────

const TRIGGER_SCHEMA = {
    type: "object",
    description: "When to fire. Set 'type' and the relevant fields for that type.",
    properties: {
        type: {
            type: "string",
            enum: ["state_change", "cron", "timer"],
            description: "Trigger type: state_change (entity state), cron (schedule), or timer (one-time fire_at)",
        },
        entity_id: {
            description: "Entity ID(s) to watch (state_change). String or array of strings.",
        },
        to: { type: "string", description: "Target state value (state_change). Example: 'on', 'home'" },
        from: { type: "string", description: "Previous state value (state_change)" },
        above: { type: "number", description: "Numeric threshold — fires when state goes above this (state_change)" },
        below: { type: "number", description: "Numeric threshold — fires when state goes below this (state_change)" },
        attribute: { type: "string", description: "Watch a specific attribute instead of state (state_change)" },
        expression: { type: "string", description: "5-field cron expression (cron). Example: '0 6 * * *' = daily at 6am" },
        fire_at: { type: "string", description: "ISO 8601 timestamp to fire at (timer). Example: '2026-06-06T18:00:00+08:00'" },
    },
    required: ["type"],
};

const ACTION_SCHEMA = {
    description: "What to do when triggered. Single action object OR array of action objects for multi-action sequences.",
    properties: {
        type: {
            type: "string",
            enum: ["wake_agent", "notify", "ha_service", "evaluate"],
            description: "Action type: wake_agent (start agent conversation), notify (send Telegram message), ha_service (call HA service), evaluate (evaluate HA Jinja2 template, optionally check condition, send notification)",
        },
        prompt: { type: "string", description: "Agent prompt (wake_agent)" },
        silent: { type: "boolean", description: "If true, run autonomously — no Telegram notifications unless agent calls notify_user (wake_agent only)" },
        message: { type: "string", description: "Notification text (notify, ha_service, evaluate). For evaluate, use {{ result }} to include template output." },
        domain: { type: "string", description: "HA service domain (ha_service). Example: 'light'" },
        service: { type: "string", description: "HA service name (ha_service). Example: 'turn_on'" },
        data: { type: "object", description: "Service call data (ha_service). Example: {entity_id: 'light.bedroom'}" },
        template: { type: "string", description: "Jinja2 template to evaluate via HA API (evaluate). Example: \"{{ states('sensor.temperature') }}\"" },
        condition: { type: "string", description: "Optional Jinja2 condition template (evaluate). Must render to 'true'/'True'/'1' to pass. Use {{ result }} to reference main template output." },
    },
    required: ["type"],
};

const CONDITION_SCHEMA = {
    type: "object",
    description: "A condition to check before executing actions. Types: state (exact entity state match), numeric_state (above/below thresholds), time (time range), and/or/not (combinators for nesting).",
    properties: {
        type: {
            type: "string",
            enum: ["state", "numeric_state", "time", "and", "or", "not"],
            description: "Condition type",
        },
        entity_id: { type: "string", description: "Entity to check (state, numeric_state)" },
        state: { type: "string", description: "Required state value (state). Example: 'home', 'on'" },
        above: { type: "number", description: "Value must be above this (numeric_state)" },
        below: { type: "number", description: "Value must be below this (numeric_state)" },
        after: { type: "string", description: "Time must be after this (time). Format: HH:MM or HH:MM:SS" },
        before: { type: "string", description: "Time must be before this (time). Format: HH:MM or HH:MM:SS" },
        conditions: {
            type: "array",
            description: "Nested conditions (and/or/not). 'not' requires exactly 1 element.",
            items: { type: "object" },
        },
    },
    required: ["type"],
};

const TOOLS = [
    {
        name: "si_create",
        description:
            "Create a new standing instruction. The bot validates all fields and auto-generates id, created_at, etc. " +
            "Returns the full instruction object on success, or a validation error.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Optional custom ID (kebab-case recommended). If omitted, a UUID is auto-generated. Useful for chain_enable references." },
                description: { type: "string", description: "Human-readable description of what this instruction does" },
                trigger: TRIGGER_SCHEMA,
                action: ACTION_SCHEMA,
                conditions: {
                    type: "array",
                    items: CONDITION_SCHEMA,
                    description: "Optional conditions checked after trigger match, before action execution. Top level is implicit AND. Use {type:'or', conditions:[...]} for OR logic. Omit or null = always execute.",
                },
                action_mode: {
                    type: "string",
                    enum: ["sequential", "parallel"],
                    description: "How to execute multiple actions (default: sequential). Only relevant when action is an array.",
                },
                continue_on_error: {
                    type: "boolean",
                    description: "If true, continue executing remaining actions when one fails (default: false).",
                },
                enabled: { type: "boolean", description: "Whether to activate immediately (default: true)" },
                cooldown_seconds: { type: "number", description: "Minimum seconds between firings (default: 300). Set 0 to fire every time." },
                one_shot: { type: "boolean", description: "Auto-disable after first firing (default: false). Use for reminders/timers." },
                expires_at: { type: "string", description: "ISO 8601 timestamp — auto-disable after this time. Null = never expires." },
                max_triggers: { type: "number", description: "Auto-disable after N firings. Null = unlimited." },
                notes: { type: "string", description: "Freeform notes passed to chained instructions" },
                chain_enable: {
                    type: "array",
                    items: { type: "string" },
                    description: "Instruction IDs to enable when this one fires",
                },
            },
            required: ["description", "trigger", "action"],
        },
    },
    {
        name: "si_list",
        description: "List all standing instructions with their current state (enabled, trigger count, last fired, etc).",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "si_get",
        description: "Get a single standing instruction by ID.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Instruction ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "si_update",
        description:
            "Update an existing standing instruction. Only include fields you want to change. " +
            "The bot validates the merged result.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Instruction ID to update" },
                description: { type: "string" },
                trigger: TRIGGER_SCHEMA,
                action: ACTION_SCHEMA,
                conditions: { type: "array", items: CONDITION_SCHEMA, description: "Replace conditions (null to remove)" },
                action_mode: { type: "string", enum: ["sequential", "parallel"] },
                continue_on_error: { type: "boolean" },
                enabled: { type: "boolean" },
                cooldown_seconds: { type: "number" },
                one_shot: { type: "boolean" },
                expires_at: { type: "string" },
                max_triggers: { type: "number" },
                notes: { type: "string" },
                chain_enable: { type: "array", items: { type: "string" } },
            },
            required: ["id"],
        },
    },
    {
        name: "si_delete",
        description: "Delete a standing instruction by ID.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Instruction ID to delete" },
            },
            required: ["id"],
        },
    },
    {
        name: "si_toggle",
        description: "Enable or disable a standing instruction.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Instruction ID" },
                action: {
                    type: "string",
                    enum: ["enable", "disable", "toggle"],
                    description: "Action to take (default: toggle)",
                },
            },
            required: ["id"],
        },
    },
    {
        name: "si_reconnect",
        description: "Force reconnect the HA WebSocket event listener used by standing instructions. Use when the WS connection is stale or disconnected (e.g. after HA core restart).",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "dispatch_to_agent",
        description:
            "Delegate to a full-capability agent (Sonnet/Opus). " +
            "ALWAYS use this unless the request is a single greeting, state read, or device command. " +
            "If you need >1 tool call, any reasoning, or are unsure — dispatch immediately. " +
            "The dispatched agent sends its response directly to the user. " +
            "Include ALL relevant context in the prompt — the dispatched agent has no conversation history. " +
            "Returns immediately.",
        inputSchema: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Complete, self-contained task description with all context the agent needs",
                },
                description: {
                    type: "string",
                    description: "Short description for tracking (e.g., 'Research OpenClaw comparison')",
                },
                model: {
                    type: "string",
                    enum: ["standard", "reasoning"],
                    description: "Model tier: standard (Sonnet, default) or reasoning (Opus, for very complex tasks)",
                },
            },
            required: ["prompt", "description"],
        },
    },
];

function apiCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        };

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
        req.on("timeout", () => { req.destroy(); reject(new Error("API request timed out")); });

        if (body != null) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// ── Tool handlers ───────────────────────────────────────────

async function handleTool(name, args) {
    try {
        switch (name) {
            case "si_create": {
                const { description, trigger, action, ...rest } = args || {};
                const body = { description, trigger, action, ...rest };
                const { status, data } = await apiCall("POST", "/api/instructions", body);
                if (status === 201) {
                    return ok(`✅ Created instruction: ${data.id}\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Validation error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_list": {
                const { status, data } = await apiCall("GET", "/api/instructions");
                if (status === 200) {
                    if (!Array.isArray(data) || data.length === 0) {
                        return ok("No standing instructions registered.");
                    }
                    const summary = data.map((i) => {
                        const status = i.enabled ? "✅" : "⏸️";
                        const fired = i.trigger_count > 0 ? ` | fired: ${i.trigger_count}` : "";
                        const expires = i.expires_at ? ` | expires: ${i.expires_at}` : "";
                        return `${status} [${i.id}] ${i.description}${fired}${expires}`;
                    }).join("\n");
                    return ok(`${data.length} instruction(s):\n\n${summary}\n\nFull data:\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_get": {
                const { id } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("GET", `/api/instructions/${encodeURIComponent(id)}`);
                if (status === 200) return ok(JSON.stringify(data, null, 2));
                if (status === 404) return err(`Instruction not found: ${id}`);
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_update": {
                const { id, ...updates } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("PUT", `/api/instructions/${encodeURIComponent(id)}`, updates);
                if (status === 200) {
                    return ok(`✅ Updated instruction: ${id}\n\n${JSON.stringify(data, null, 2)}`);
                }
                if (status === 404) return err(`Instruction not found: ${id}`);
                return err(`Validation error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_delete": {
                const { id } = args || {};
                if (!id) return err("id is required");
                const { status, data } = await apiCall("DELETE", `/api/instructions/${encodeURIComponent(id)}`);
                if (status === 204) return ok(`🗑️ Deleted instruction: ${id}`);
                if (status === 404) return err(`Instruction not found: ${id}`);
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_toggle": {
                const { id, action: act = "toggle" } = args || {};
                if (!id) return err("id is required");
                const validActions = new Set(["enable", "disable", "toggle"]);
                if (!validActions.has(act)) return err(`Invalid action: ${act}. Must be one of: enable, disable, toggle`);
                const { status, data } = await apiCall("POST", `/api/instructions/${encodeURIComponent(id)}/${encodeURIComponent(act)}`);
                if (status === 200) {
                    const state = data.enabled ? "enabled ✅" : "disabled ⏸️";
                    return ok(`Instruction ${id} is now ${state}`);
                }
                if (status === 404) return err(`Instruction not found: ${id}`);
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "si_reconnect": {
                const { status, data } = await apiCall("POST", "/api/standing/reconnect");
                if (status === 200) {
                    const state = data.connected ? "🟢 connected" : "🟡 reconnecting";
                    return ok(`🔄 HA WebSocket reconnect initiated — ${state}`);
                }
                return err(`Reconnect failed (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "dispatch_to_agent": {
                const { prompt, description: desc, model: m } = args || {};
                if (!prompt) return err("prompt is required");
                if (!desc) return err("description is required");
                const body = { prompt, description: desc };
                if (m) body.model = m;
                const callerScope = getScopeKey();
                if (callerScope) body.scopeKey = callerScope;
                const { status, data } = await apiCall("POST", "/api/dispatch", body);
                if (status === 200 || status === 202) {
                    return ok(`✅ Dispatched: "${desc}"\nModel: ${body.model || "(user default)"}\nThe full agent will send its response to the user directly.`);
                }
                return err(`Dispatch failed (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            default:
                return err(`Unknown tool: ${name}`);
        }
    } catch (e) {
        log(`Tool error: ${e.message}`);
        if (e.message?.includes("ECONNREFUSED")) {
            return err("Bot API is unavailable (connection refused). The bot may be starting up. Do NOT fall back to editing /data/standing_instructions.json — wait and retry.");
        }
        return err(`API call failed: ${e.message}`);
    }
}

function ok(text) {
    return { content: [{ type: "text", text }] };
}

function err(text) {
    return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ── JSON-RPC helpers ────────────────────────────────────────

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// ── Request handlers ────────────────────────────────────────

let clientProtocolVersion = "2025-11-25";

function handleInitialize(id, params) {
    if (params?.protocolVersion) clientProtocolVersion = params.protocolVersion;
    send(id, {
        protocolVersion: clientProtocolVersion,
        serverInfo: { name: "standing-instructions", version: "2.0.0" },
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
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
        sendError(id, -32602, `Unknown tool: ${name}`);
        return;
    }
    log(`${name} called`);
    pendingCalls++;
    try {
        const result = await handleTool(name, args || {});
        send(id, result);
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
        process.stderr.write("si-mcp: line buffer exceeded 1MB, resetting\n");
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

log("Standing Instructions MCP server started");
