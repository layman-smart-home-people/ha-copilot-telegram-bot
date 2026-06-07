#!/usr/bin/env node
// MCP server for RBAC management — raw JSON-RPC over stdio (NDJSON framing).
// Exposes role/user/permission tools that call the bot's REST API.
// Same pattern as si-mcp-server.mjs. No npm dependencies.

import http from "node:http";

const API_BASE = process.env.RBAC_API_BASE || "http://localhost:8099";

function log(msg) { process.stderr.write(`[rbac-mcp] ${msg}\n`); }

// ── Tool definitions ────────────────────────────────────────

const TOOLS = [
    {
        name: "rbac_list_roles",
        description:
            "List all roles with their capabilities, inheritance, and rank. " +
            "Shows both built-in (owner, admin, member, guest) and custom roles.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "rbac_get_role",
        description: "Get a single role's full details including effective capabilities (resolved through inheritance).",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Role name (e.g., 'admin', 'member', 'deacon')" },
            },
            required: ["name"],
        },
    },
    {
        name: "rbac_create_role",
        description:
            "Create a custom role. Role names must be lowercase alphanumeric with - or _. " +
            "Rank must be 1-99 (100 is reserved for owner). Use 'inherits' to inherit capabilities from another role.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Role name (lowercase, e.g., 'deacon', 'tech-lead')" },
                rank: { type: "number", description: "Role rank (1-99). Higher rank = more authority. Determines delegation boundaries." },
                inherits: { type: "string", description: "Optional parent role to inherit capabilities from (e.g., 'member')" },
                capabilities: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of capabilities to grant. Valid: entity:read, entity:search, entity:control:safe, entity:control:sensitive, automation:read, automation:write, dashboard:read, dashboard:write, si:manage:own, si:manage:all, user:manage, role:manage, system:manage, dev:tools, agent:memory, background:task, reminder:manage",
                },
                icon: { type: "string", description: "Optional emoji icon for the role (e.g., '⛪')" },
                description: { type: "string", description: "Optional human-readable description" },
            },
            required: ["name", "rank"],
        },
    },
    {
        name: "rbac_update_role",
        description: "Update an existing role. Only include fields you want to change. Cannot modify the owner role.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Role name to update" },
                rank: { type: "number", description: "New rank (1-99)" },
                inherits: { type: "string", description: "New parent role (null to remove inheritance)" },
                capabilities: { type: "array", items: { type: "string" }, description: "New capabilities list (replaces existing)" },
                icon: { type: "string", description: "New icon" },
                description: { type: "string", description: "New description" },
            },
            required: ["name"],
        },
    },
    {
        name: "rbac_delete_role",
        description: "Delete a custom role. Fails if any users are still assigned to it or other roles inherit from it. Cannot delete built-in roles.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Role name to delete" },
            },
            required: ["name"],
        },
    },
    {
        name: "rbac_list_users",
        description: "List all paired users with their roles, effective capabilities, and expiry status.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "rbac_get_user",
        description: "Get a single user's details including role, effective capabilities, and expiry.",
        inputSchema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "User's Telegram chat ID" },
            },
            required: ["userId"],
        },
    },
    {
        name: "rbac_set_user_role",
        description: "Assign a role to a user. If the user doesn't exist, creates a new user entry. Delegation rules apply: you can only assign roles with rank below your own.",
        inputSchema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "User's Telegram chat ID" },
                role: { type: "string", description: "Role to assign (e.g., 'member', 'admin', 'deacon')" },
                displayName: { type: "string", description: "Optional display name for the user" },
                expiresAt: { type: "string", description: "Optional ISO 8601 expiry timestamp. User loses access after this time." },
            },
            required: ["userId", "role"],
        },
    },
    {
        name: "rbac_revoke_user",
        description: "Revoke a user's access entirely. Cannot revoke pre-approved admin (owner) users.",
        inputSchema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "User's Telegram chat ID" },
            },
            required: ["userId"],
        },
    },
    {
        name: "rbac_check_permission",
        description:
            "Debug tool: check whether a user is allowed to perform a specific capability or use a specific tool. " +
            "Returns allow/deny with reason. Useful for testing RBAC configuration.",
        inputSchema: {
            type: "object",
            properties: {
                userId: { type: "string", description: "User's Telegram chat ID" },
                capability: { type: "string", description: "Capability to check (e.g., 'entity:control:safe'). Use this OR toolName." },
                entityId: { type: "string", description: "Optional entity ID for per-entity override checks (e.g., 'light.bedroom')" },
                toolName: { type: "string", description: "Tool name to check (e.g., 'ha_call_service'). Use this OR capability." },
                toolArgs: { type: "object", description: "Optional tool arguments for domain-based checks (e.g., {domain: 'light', entity_id: 'light.bedroom'})" },
            },
            required: ["userId"],
        },
    },
    {
        name: "rbac_create_invite",
        description:
            "Generate an invite token that auto-pairs new users with a specific role. " +
            "Share the token via /start invite_TOKEN deep link. Cannot create invites for the owner role.",
        inputSchema: {
            type: "object",
            properties: {
                role: { type: "string", description: "Role to assign when invite is used (e.g., 'guest', 'member')" },
                expiresAt: { type: "string", description: "Optional ISO 8601 timestamp — invite link expires after this time" },
                roleExpiresAt: { type: "string", description: "Optional ISO 8601 timestamp — user's access expires after this time (even after using invite)" },
                createdBy: { type: "string", description: "Who created this invite (for audit)" },
            },
            required: ["role"],
        },
    },
    {
        name: "rbac_list_overrides",
        description:
            "List per-entity access overrides. Overrides grant or deny specific capabilities on specific entities " +
            "(e.g., deny 'entity:control:safe' on 'lock.*' for role 'guest'). Supports optional filters.",
        inputSchema: {
            type: "object",
            properties: {
                entity_id: { type: "string", description: "Filter by entity ID or domain wildcard (e.g., 'light.bedroom', 'climate.*')" },
                target_type: { type: "string", enum: ["user", "role"], description: "Filter by target type" },
                target_id: { type: "string", description: "Filter by target ID (role name or user ID)" },
            },
        },
    },
    {
        name: "rbac_set_override",
        description:
            "Add or update a per-entity access override. Overrides let you grant or deny specific capabilities " +
            "on specific entities for a role or user. Deny always wins over base role capabilities. " +
            "Entity can be a specific ID (light.bedroom) or domain wildcard (climate.*).",
        inputSchema: {
            type: "object",
            properties: {
                entity_id: { type: "string", description: "Entity ID or domain wildcard (e.g., 'light.bedroom', 'lock.*')" },
                target_type: { type: "string", enum: ["user", "role"], description: "Whether this override applies to a user or role" },
                target_id: { type: "string", description: "Role name (e.g., 'guest') or user ID (e.g., '12345')" },
                grants: { type: "array", items: { type: "string" }, description: "Capabilities to grant on this entity" },
                denies: { type: "array", items: { type: "string" }, description: "Capabilities to deny on this entity (deny wins over base role)" },
            },
            required: ["entity_id", "target_type", "target_id"],
        },
    },
    {
        name: "rbac_delete_override",
        description: "Remove a per-entity access override.",
        inputSchema: {
            type: "object",
            properties: {
                entity_id: { type: "string", description: "Entity ID or domain wildcard" },
                target_type: { type: "string", enum: ["user", "role"], description: "Target type" },
                target_id: { type: "string", description: "Role name or user ID" },
            },
            required: ["entity_id", "target_type", "target_id"],
        },
    },
    {
        name: "rbac_get_audit_log",
        description:
            "View the RBAC audit log — records of all permission changes (role grants, revokes, overrides, invites). " +
            "Supports pagination and filtering. Newest entries first.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Max entries to return (default: 20, max: 200)" },
                offset: { type: "number", description: "Skip this many entries (for pagination)" },
                event: { type: "string", description: "Filter by event type: ROLE_GRANT, ROLE_REVOKE, ROLE_CREATE, ROLE_UPDATE, ROLE_DELETE, ROLE_EXPIRE, OVERRIDE_ADD, OVERRIDE_REMOVE, INVITE_CREATE, INVITE_USE" },
                actor: { type: "string", description: "Filter by actor (user ID or 'system')" },
                target: { type: "string", description: "Filter by target (user ID, role name, etc.)" },
            },
        },
    },
];

// ── REST API helpers ────────────────────────────────────────

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
            case "rbac_list_roles": {
                const { status, data } = await apiCall("GET", "/api/rbac/roles");
                if (status === 200) {
                    if (!Array.isArray(data) || data.length === 0) {
                        return ok("No roles defined.");
                    }
                    const summary = data.map(r => {
                        const icon = r.icon || "";
                        const caps = (r.effectiveCapabilities || []).length;
                        const inherit = r.inherits ? ` (inherits: ${r.inherits})` : "";
                        return `${icon} **${r.name}** — rank ${r.rank}${inherit} — ${caps} capabilities`;
                    }).join("\n");
                    return ok(`${data.length} role(s):\n\n${summary}\n\nFull data:\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_get_role": {
                const { name: roleName } = args || {};
                if (!roleName) return err("name is required");
                const { status, data } = await apiCall("GET", `/api/rbac/roles/${encodeURIComponent(roleName)}`);
                if (status === 200) return ok(JSON.stringify(data, null, 2));
                if (status === 404) return err(`Role not found: ${roleName}`);
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_create_role": {
                const { name: roleName, rank, inherits, capabilities, icon, description } = args || {};
                if (!roleName) return err("name is required");
                if (rank === undefined) return err("rank is required");
                const body = { name: roleName, rank, inherits, capabilities, icon, description };
                const { status, data } = await apiCall("POST", "/api/rbac/roles", body);
                if (status === 201) {
                    return ok(`✅ Created role: ${roleName} (rank ${rank})\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_update_role": {
                const { name: roleName, ...updates } = args || {};
                if (!roleName) return err("name is required");
                const { status, data } = await apiCall("PUT", `/api/rbac/roles/${encodeURIComponent(roleName)}`, updates);
                if (status === 200) {
                    return ok(`✅ Updated role: ${roleName}\n\n${JSON.stringify(data, null, 2)}`);
                }
                if (status === 404) return err(`Role not found: ${roleName}`);
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_delete_role": {
                const { name: roleName } = args || {};
                if (!roleName) return err("name is required");
                const { status, data } = await apiCall("DELETE", `/api/rbac/roles/${encodeURIComponent(roleName)}`);
                if (status === 204) return ok(`🗑️ Deleted role: ${roleName}`);
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_list_users": {
                const { status, data } = await apiCall("GET", "/api/rbac/users");
                if (status === 200) {
                    if (!Array.isArray(data) || data.length === 0) {
                        return ok("No users registered.");
                    }
                    const summary = data.map(u => {
                        const expired = u.expiresAt && new Date(u.expiresAt) < new Date() ? " ⚠️ EXPIRED" : "";
                        const name = u.displayName || u.username || u.userId;
                        return `👤 ${name} — role: ${u.role}${expired}`;
                    }).join("\n");
                    return ok(`${data.length} user(s):\n\n${summary}\n\nFull data:\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_get_user": {
                const { userId } = args || {};
                if (!userId) return err("userId is required");
                const { status, data } = await apiCall("GET", `/api/rbac/users/${encodeURIComponent(userId)}`);
                if (status === 200) return ok(JSON.stringify(data, null, 2));
                if (status === 404) return err(`User not found: ${userId}`);
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_set_user_role": {
                const { userId, role, displayName, expiresAt } = args || {};
                if (!userId) return err("userId is required");
                if (!role) return err("role is required");
                const body = { role, displayName, expiresAt };
                const { status, data } = await apiCall("PUT", `/api/rbac/users/${encodeURIComponent(userId)}/role`, body);
                if (status === 200) {
                    return ok(`✅ User ${userId} assigned role: ${role}\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_revoke_user": {
                const { userId } = args || {};
                if (!userId) return err("userId is required");
                const { status, data } = await apiCall("DELETE", `/api/rbac/users/${encodeURIComponent(userId)}`);
                if (status === 204) return ok(`🗑️ Revoked user: ${userId}`);
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_check_permission": {
                const { userId, capability, entityId, toolName, toolArgs } = args || {};
                if (!userId) return err("userId is required");
                const body = { userId, capability, entityId, toolName, toolArgs };
                const { status, data } = await apiCall("POST", "/api/rbac/check", body);
                if (status === 200) {
                    const icon = data.allowed ? "✅" : "❌";
                    return ok(`${icon} ${data.allowed ? "ALLOWED" : "DENIED"} — reason: ${data.reason}${data.capability ? ` (cap: ${data.capability})` : ""}\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_create_invite": {
                const { role, expiresAt, roleExpiresAt, createdBy } = args || {};
                if (!role) return err("role is required");
                const body = { role, expiresAt, roleExpiresAt, createdBy };
                const { status, data } = await apiCall("POST", "/api/rbac/invites", body);
                if (status === 201) {
                    return ok(`🔗 Invite created for role: ${role}\n\nToken: ${data.token}\nDeep link: /start invite_${data.token}\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_list_overrides": {
                const { entity_id, target_type, target_id } = args || {};
                const qs = new URLSearchParams();
                if (entity_id) qs.set("entity_id", entity_id);
                if (target_type) qs.set("target_type", target_type);
                if (target_id) qs.set("target_id", target_id);
                const qStr = qs.toString();
                const path = "/api/rbac/overrides" + (qStr ? `?${qStr}` : "");
                const { status, data } = await apiCall("GET", path);
                if (status === 200) {
                    if (!Array.isArray(data) || data.length === 0) {
                        return ok("No overrides configured.");
                    }
                    const summary = data.map(o => {
                        const g = o.grants?.length ? ` grants: ${o.grants.join(", ")}` : "";
                        const d = o.denies?.length ? ` denies: ${o.denies.join(", ")}` : "";
                        return `• ${o.entity_id} → ${o.target_type}:${o.target_id}${g}${d}`;
                    }).join("\n");
                    return ok(`${data.length} override(s):\n\n${summary}\n\nFull data:\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_set_override": {
                const { entity_id, target_type, target_id, grants, denies } = args || {};
                if (!entity_id) return err("entity_id is required");
                if (!target_type) return err("target_type is required");
                if (!target_id) return err("target_id is required");
                const body = { entity_id, target_type, target_id, grants, denies };
                const { status, data } = await apiCall("POST", "/api/rbac/overrides", body);
                if (status === 201) {
                    return ok(`✅ Override set: ${target_type}:${target_id} on ${entity_id}\n\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_delete_override": {
                const { entity_id, target_type, target_id } = args || {};
                if (!entity_id) return err("entity_id is required");
                if (!target_type) return err("target_type is required");
                if (!target_id) return err("target_id is required");
                const body = { entity_id, target_type, target_id };
                const { status, data } = await apiCall("DELETE", "/api/rbac/overrides", body);
                if (status === 204) return ok(`🗑️ Override removed: ${target_type}:${target_id} on ${entity_id}`);
                if (status === 404) return err("Override not found");
                return err(`Error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            case "rbac_get_audit_log": {
                const { limit, offset, event, actor, target } = args || {};
                const qs = new URLSearchParams();
                if (limit) qs.set("limit", String(limit));
                if (offset) qs.set("offset", String(offset));
                if (event) qs.set("event", event);
                if (actor) qs.set("actor", String(actor));
                if (target) qs.set("target", String(target));
                const qStr = qs.toString();
                const path = "/api/rbac/audit" + (qStr ? `?${qStr}` : "");
                const { status, data } = await apiCall("GET", path);
                if (status === 200) {
                    const entries = data.entries || [];
                    if (entries.length === 0) {
                        return ok(`No audit log entries found (total: ${data.total || 0}).`);
                    }
                    const summary = entries.slice(0, 20).map(e => {
                        const ts = e.timestamp?.slice(0, 19).replace("T", " ") || "?";
                        return `[${ts}] ${e.event} — actor: ${e.actor}, target: ${e.target}`;
                    }).join("\n");
                    return ok(`Audit log (${entries.length}/${data.total} entries):\n\n${summary}\n\nFull data:\n${JSON.stringify(data, null, 2)}`);
                }
                return err(`API error (${status}): ${data?.error || JSON.stringify(data)}`);
            }

            default:
                return err(`Unknown tool: ${name}`);
        }
    } catch (e) {
        log(`Tool error: ${e.message}`);
        if (e.message?.includes("ECONNREFUSED")) {
            return err("Bot API is unavailable (connection refused). The bot may be starting up. Retry shortly.");
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
        serverInfo: { name: "rbac-tools", version: "1.0.0" },
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
        process.stderr.write("rbac-mcp: line buffer exceeded 1MB, resetting\n");
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

log("RBAC MCP server started");
