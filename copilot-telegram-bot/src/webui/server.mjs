// ============================================================
// Web UI Server — Ingress-based dashboard for the Copilot Bot
// ============================================================
// Lightweight HTTP server using Node built-in http module.
// Serves REST API + static frontend. Auth handled by HA Ingress.

import http from "node:http";
import { readFileSync, readdirSync, statSync, readFile, writeFile } from "node:fs";
import { join, extname, resolve, basename, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const STATIC_DIR = new URL("./dist/", import.meta.url).pathname;
const log = createLogger("webui");
const TRUSTED_INGRESS_IPS = new Set(["172.30.32.2", "::ffff:172.30.32.2", "::1", "127.0.0.1", "::ffff:127.0.0.1"]);

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

export class WebUIServer {
    #server = null;
    #port;
    #ctx = {}; // references to bot internals
    #logBuffer = [];       // circular buffer for recent log lines
    #logMaxLines = 500;
    #sseClients = new Set(); // SSE connections for live log streaming
    #chatSseClients = new Map(); // scopeKey -> Set<res>
    #chatConvListeners = new Map(); // scopeKey -> listeners
    #addonSlug = null;     // resolved lazily
    #approvalRequestListener = null;
    #approvalResolvedListener = null;

    constructor({ port = 8099 } = {}) {
        this.#port = port;
    }

    /**
     * Attach bot internals so API routes can access them.
     * Call this before start().
     */
    attach({ pool, conversationManager, siOrchestrator, config, telegram, startedAt, enricher, rbac, pkm, controlStore, approvalService }) {
        this.#ctx = { pool, conversationManager, siOrchestrator, config, telegram, startedAt, enricher, rbac, pkm, controlStore, approvalService };

        if (this.#approvalRequestListener) {
            approvalService?.off?.("webui-approval-request", this.#approvalRequestListener);
            approvalService?.off?.("webui-approval-resolved", this.#approvalResolvedListener);
        }

        this.#approvalRequestListener = ({ scopeKey, ...event }) => {
            this.#broadcastChatEvent(scopeKey, { type: "permission_request", ...event });
        };
        this.#approvalResolvedListener = ({ scopeKey, ...event }) => {
            this.#broadcastChatEvent(scopeKey, { type: "permission_resolved", ...event });
        };

        approvalService?.on?.("webui-approval-request", this.#approvalRequestListener);
        approvalService?.on?.("webui-approval-resolved", this.#approvalResolvedListener);
    }

    /**
     * Push a log line into the circular buffer and broadcast to SSE clients.
     * Call this from the global log() function.
     */
    pushLog(line) {
        const entry = { ts: Date.now(), line };
        this.#logBuffer.push(entry);
        if (this.#logBuffer.length > this.#logMaxLines) {
            this.#logBuffer.shift();
        }
        // Broadcast to SSE clients
        for (const client of this.#sseClients) {
            try {
                client.write(`data: ${JSON.stringify(entry)}\n\n`);
            } catch {
                this.#sseClients.delete(client);
            }
        }
    }

    /** Push a chat event to one WebUI scope. */
    pushChatEvent(scopeKey, event) {
        this.#broadcastChatEvent(scopeKey, event);
    }

    async start() {
        this.#server = http.createServer((req, res) => this.#handleRequest(req, res));
        this.#server.listen(this.#port, () => {
            log.info(`Server listening on port ${this.#port}`);
        });
    }

    async stop() {
        this.#detachAllChatConvListeners();
        if (this.#server) {
            return new Promise((resolve) => {
                this.#server.close(() => {
                    log.info("Server stopped");
                    resolve();
                });
            });
        }
    }

    async #handleRequest(req, res) {
        try {
            // Strip ingress prefix — HA sets X-Ingress-Path header
            const ingressPath = req.headers["x-ingress-path"] || "";
            let url = req.url || "/";
            if (ingressPath && url.startsWith(ingressPath)) {
                url = url.slice(ingressPath.length) || "/";
            }

            const [pathname, queryString] = url.split("?", 2);
            const params = queryString ? Object.fromEntries(new URLSearchParams(queryString)) : {};

            // API routes
            if (pathname.startsWith("/api/")) {
                const principal = this.#resolveWebuiPrincipal(req);
                return await this.#handleApi(req, res, pathname, params, principal);
            }

            // Static file serving
            return this.#serveStatic(res, pathname);
        } catch (err) {
            log.error(`Request error: ${err.message}`);
            this.#json(res, 500, { error: "Internal server error" });
        }
    }

    async #handleApi(req, res, pathname, params, principal) {
        const method = req.method;
        const requirePrincipal = () => {
            if (!principal) {
                this.#json(res, 403, { error: "This route requires an authenticated Home Assistant ingress user" });
                return null;
            }
            return principal;
        };
        const requireOperator = () => {
            const resolved = requirePrincipal();
            if (!resolved) return null;
            if (!this.#isWebuiOperator(resolved)) {
                this.#json(res, 403, {
                    error: "This WebUI action requires an authorized operator. Add the Home Assistant user ID to webui_operator_ids to enable it.",
                });
                return null;
            }
            return resolved;
        };
        // GET /api/status — bot status overview
        if (pathname === "/api/status" && method === "GET") {
            return this.#apiStatus(res);
        }

        if (pathname === "/api/webui/me" && method === "GET") {
            if (!requirePrincipal()) return;
            return this.#apiWebuiMe(res, principal);
        }

        // GET /api/metrics — cumulative pool metrics
        if (pathname === "/api/metrics" && method === "GET") {
            return this.#json(res, 200, this.#ctx.pool?.getMetrics?.() || null);
        }

        // POST /api/metrics/reset — unsupported in v7
        if (pathname === "/api/metrics/reset" && method === "POST") {
            return this.#json(res, 404, { error: "Not found" });
        }

        // GET /api/instructions — list standing instructions
        if (pathname === "/api/instructions" && method === "GET") {
            return this.#apiInstructionsList(res);
        }

        // POST /api/instructions — create instruction
        if (pathname === "/api/instructions" && method === "POST") {
            if (!requireOperator()) return;
            const body = await this.#readBody(req);
            return this.#apiInstructionsCreate(res, body);
        }

        // Match /api/instructions/:id routes
        const instrMatch = pathname.match(/^\/api\/instructions\/([^/]+)$/);
        if (instrMatch) {
            const id = decodeURIComponent(instrMatch[1]);

            if (method === "GET") {
                return this.#apiInstructionsGet(res, id);
            }
            if (method === "PUT") {
                if (!requireOperator()) return;
                const body = await this.#readBody(req);
                return this.#apiInstructionsUpdate(res, id, body);
            }
            if (method === "DELETE") {
                if (!requireOperator()) return;
                return this.#apiInstructionsDelete(res, id);
            }
        }

        // POST /api/instructions/:id/toggle
        const toggleMatch = pathname.match(/^\/api\/instructions\/([^/]+)\/(enable|disable|toggle)$/);
        if (toggleMatch && method === "POST") {
            if (!requireOperator()) return;
            const id = decodeURIComponent(toggleMatch[1]);
            const action = toggleMatch[2];
            return this.#apiInstructionsToggle(res, id, action);
        }

        // POST /api/standing/reconnect — force reconnect HA WebSocket
        if (pathname === "/api/standing/reconnect" && method === "POST") {
            if (!requireOperator()) return;
            return this.#apiStandingReconnect(res);
        }

        // GET /api/docs — list available docs
        if (pathname === "/api/docs" && method === "GET") {
            return this.#apiDocsList(res);
        }

        // GET/PUT /api/docs/:name
        const docMatch = pathname.match(/^\/api\/docs\/(.+)$/);
        if (docMatch) {
            const name = decodeURIComponent(docMatch[1]);
            if (method === "GET") {
                return this.#apiDocsGet(res, name);
            }
            if (method === "PUT") {
                if (!requireOperator()) return;
                const body = await this.#readBody(req);
                return this.#apiDocsPut(res, name, body);
            }
        }

        // GET /api/scopes — list active scopes
        if (pathname === "/api/scopes" && method === "GET") {
            return this.#apiScopesList(res);
        }

        // GET /api/logs — recent log buffer
        if (pathname === "/api/logs" && method === "GET") {
            return this.#apiLogs(res);
        }

        // GET /api/logs/stream — SSE live log stream
        if (pathname === "/api/logs/stream" && method === "GET") {
            return this.#apiLogStream(req, res);
        }

        // GET /api/system — host/system info from supervisor
        if (pathname === "/api/system" && method === "GET") {
            return this.#apiSystemInfo(res);
        }

        // GET /api/entities — search HA entities
        if (pathname === "/api/entities" && method === "GET") {
            return this.#apiEntities(res, params);
        }

        // GET /api/config/options — current add-on options
        if (pathname === "/api/config/options" && method === "GET") {
            return this.#apiConfigGet(res);
        }

        // PUT /api/config/options — update add-on options
        if (pathname === "/api/config/options" && method === "PUT") {
            if (!requireOperator()) return;
            const body = await this.#readBody(req);
            return this.#apiConfigPut(res, body);
        }

        // POST /api/config/restart — restart the add-on
        if (pathname === "/api/config/restart" && method === "POST") {
            if (!requireOperator()) return;
            return this.#apiConfigRestart(res);
        }

        // GET /api/chat/status — web chat ACP status
        if (pathname === "/api/chat/status" && method === "GET") {
            if (!requirePrincipal()) return;
            return this.#apiChatStatus(res, principal);
        }

        // GET /api/chat/stream — SSE stream for chat events
        if (pathname === "/api/chat/stream" && method === "GET") {
            if (!requirePrincipal()) return;
            return this.#apiChatStream(req, res, principal);
        }

        // POST /api/chat/send — send a message to web chat ACP
        if (pathname === "/api/chat/send" && method === "POST") {
            if (!requirePrincipal()) return;
            const body = await this.#readBody(req);
            return this.#apiChatSend(res, body, principal);
        }

        // POST /api/chat/new — start a new chat session
        if (pathname === "/api/chat/new" && method === "POST") {
            if (!requirePrincipal()) return;
            return this.#apiChatNew(res, principal);
        }

        // POST /api/chat/stop — cancel the current prompt
        if (pathname === "/api/chat/stop" && method === "POST") {
            if (!requirePrincipal()) return;
            return this.#apiChatStop(res, principal);
        }

        if (pathname === "/api/chat/approval" && method === "POST") {
            if (!requirePrincipal()) return;
            const body = await this.#readBody(req);
            return this.#apiChatApproval(res, body, principal);
        }

        if (pathname === "/api/chat/elicitation" && method === "POST") {
            if (!requirePrincipal()) return;
            const body = await this.#readBody(req);
            return this.#apiChatElicitation(res, body, principal);
        }

        // GET /api/chats — list all reachable chats (users + groups)
        if (pathname === "/api/chats" && method === "GET") {
            return this.#apiChats(res);
        }

        // --- RBAC API routes ---
        if (pathname.startsWith("/api/rbac/") || pathname === "/api/rbac") {
            return this.#handleRbacRoute(req, res, method, pathname, params, principal);
        }

        // --- PKM API routes ---
        if (pathname.startsWith("/api/pkm/") || pathname === "/api/pkm") {
            const pkm = this.#ctx.pkm;
            if (!pkm) {
                return this.#json(res, 503, { error: "PKM not available" });
            }
            // Resolve user context from X-Scope-Key header (set by PKM MCP sidecar)
            const scopeKey = req.headers["x-scope-key"] || "";
            const userId = scopeKey.startsWith("dm:") ? scopeKey.split(":")[1] : null;
            const chatType = scopeKey.startsWith("group:") ? "group" : "private";
            const context = { userId, chatType, scopeKey };

            let body = {};
            if (method === "POST" || method === "PUT") {
                try {
                    body = await this.#readBody(req);
                } catch (err) {
                    return this.#json(res, err.message === "Request body too large" ? 413 : 400, { error: err.message });
                }
            }
            const result = await pkm.handleApi(method, pathname, body, context);
            return this.#json(res, result.status || 200, result.data);
        }

        // POST /api/dispatch — dispatch task to full-capability agent
        if (pathname === "/api/dispatch" && method === "POST") {
            if (!requireOperator()) return;
            const body = await this.#readBody(req);
            return this.#apiDispatch(res, body, principal);
        }

        this.#json(res, 404, { error: "Not found" });
    }

    // ── RBAC API ─────────────────────────────────────────────

    async #handleRbacRoute(req, res, method, pathname, params, principal) {
        const rbac = this.#ctx.rbac;
        if (!rbac) {
            return this.#json(res, 503, { error: "RBAC not available" });
        }
        const requirePrincipal = () => {
            if (!principal) {
                this.#json(res, 403, { error: "This route requires an authenticated Home Assistant ingress user" });
                return null;
            }
            return principal;
        };
        const denyPrivilegedWebuiWrite = () => {
            this.#json(res, 403, {
                error: "RBAC write actions are temporarily disabled in WebUI until explicit WebUI role mapping is implemented",
            });
            return null;
        };

        try {
            // GET /api/rbac/roles
            if (pathname === "/api/rbac/roles" && method === "GET") {
                const allRoles = rbac.getAllRoles();
                const result = Object.entries(allRoles).map(([name, r]) => ({
                    name,
                    ...r,
                    effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)],
                }));
                return this.#json(res, 200, result);
            }

            // POST /api/rbac/roles
            if (pathname === "/api/rbac/roles" && method === "POST") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // GET/PUT/DELETE /api/rbac/roles/:name
            const roleMatch = pathname.match(/^\/api\/rbac\/roles\/([^/]+)$/);
            if (roleMatch) {
                const name = decodeURIComponent(roleMatch[1]);
                if (method === "GET") {
                    const role = rbac.getRoleConfig(name);
                    if (!role) return this.#json(res, 404, { error: `Role not found: ${name}` });
                    return this.#json(res, 200, { name, ...role, effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)] });
                }
                if (method === "PUT") {
                    if (!requirePrincipal()) return;
                    return denyPrivilegedWebuiWrite();
                }
                if (method === "DELETE") {
                    if (!requirePrincipal()) return;
                    return denyPrivilegedWebuiWrite();
                }
            }

            // GET /api/rbac/users
            if (pathname === "/api/rbac/users" && method === "GET") {
                return this.#json(res, 200, rbac.getPairedUsers());
            }

            // PUT /api/rbac/users/:id/role
            const userRoleMatch = pathname.match(/^\/api\/rbac\/users\/([^/]+)\/role$/);
            if (userRoleMatch && method === "PUT") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // GET/DELETE /api/rbac/users/:id
            const userMatch = pathname.match(/^\/api\/rbac\/users\/([^/]+)$/);
            if (userMatch) {
                const userId = decodeURIComponent(userMatch[1]);
                if (method === "GET") {
                    const user = rbac.getUser(Number(userId));
                    if (!user) return this.#json(res, 404, { error: `User not found: ${userId}` });
                    return this.#json(res, 200, user);
                }
                if (method === "DELETE") {
                    if (!requirePrincipal()) return;
                    return denyPrivilegedWebuiWrite();
                }
            }

            // POST /api/rbac/check
            if (pathname === "/api/rbac/check" && method === "POST") {
                const body = await this.#readBody(req);
                const { userId, capability, entityId, toolName, toolArgs } = body;
                let result;
                if (toolName) {
                    result = rbac.checkToolPermission(Number(userId), toolName, toolArgs || {});
                } else {
                    result = rbac.canPerform(Number(userId), capability, entityId || null);
                }
                return this.#json(res, 200, result);
            }

            // POST /api/rbac/invites
            if (pathname === "/api/rbac/invites" && method === "POST") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // GET /api/rbac/invites
            if (pathname === "/api/rbac/invites" && method === "GET") {
                const status = params.status || undefined;
                return this.#json(res, 200, rbac.listInvites({ status }));
            }

            // DELETE /api/rbac/invites
            if (pathname === "/api/rbac/invites" && method === "DELETE") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // GET /api/rbac/overrides
            if (pathname === "/api/rbac/overrides" && method === "GET") {
                const filters = {};
                if (params.entity_id) filters.entity_id = params.entity_id;
                if (params.target_type) filters.target_type = params.target_type;
                if (params.target_id) filters.target_id = params.target_id;
                return this.#json(res, 200, rbac.getOverrides(filters));
            }

            // POST /api/rbac/overrides
            if (pathname === "/api/rbac/overrides" && method === "POST") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // DELETE /api/rbac/overrides
            if (pathname === "/api/rbac/overrides" && method === "DELETE") {
                if (!requirePrincipal()) return;
                return denyPrivilegedWebuiWrite();
            }

            // GET /api/rbac/audit
            if (pathname === "/api/rbac/audit" && method === "GET") {
                const query = {};
                if (params.limit) query.limit = Number(params.limit);
                if (params.offset) query.offset = Number(params.offset);
                if (params.event) query.event = params.event;
                if (params.actor) query.actor = params.actor;
                if (params.target) query.target = params.target;
                return this.#json(res, 200, rbac.getAuditLog(query));
            }

            return this.#json(res, 404, { error: "Not found" });
        } catch (err) {
            log.error(`RBAC API error: ${err.message}`);
            return this.#json(res, 400, { error: err.message });
        }
    }

    // ── Status API ──────────────────────────────────────────────

    #apiStatus(res) {
        const { pool, conversationManager, siOrchestrator, config, startedAt } = this.#ctx;
        const uptime = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

        this.#json(res, 200, {
            bot: {
                version: config?.version || "unknown",
                uptime,
                startedAt: startedAt ? new Date(startedAt).toISOString() : null,
            },
            pool: pool?.status?.() || null,
            conversations: conversationManager?.list?.() || [],
            metrics: pool?.getMetrics?.() || null,
            standing: siOrchestrator?.status?.() || null,
            homeAssistant: {
                connected: siOrchestrator?.eventListener?.connected || false,
            },
        });
    }

    #apiWebuiMe(res, principal) {
        this.#json(res, 200, {
            principal,
            capabilities: {
                canUseChat: true,
                canManageWebuiContent: this.#isWebuiOperator(principal),
                canManageWebuiAccess: false,
            },
        });
    }

    // ── Instructions API ────────────────────────────────────────

    #apiInstructionsList(res) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        this.#json(res, 200, manager.list());
    }

    #apiInstructionsGet(res, id) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        const instruction = manager.get(id);
        if (!instruction) {
            return this.#json(res, 404, { error: "Instruction not found" });
        }
        this.#json(res, 200, instruction);
    }

    #apiInstructionsCreate(res, body) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        try {
            const instruction = manager.create(body);
            this.#json(res, 201, instruction);
        } catch (err) {
            this.#json(res, 400, { error: err.message });
        }
    }

    #apiInstructionsUpdate(res, id, body) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        try {
            const instruction = manager.update(id, body);
            if (!instruction) {
                return this.#json(res, 404, { error: "Instruction not found" });
            }
            this.#json(res, 200, instruction);
        } catch (err) {
            this.#json(res, 400, { error: err.message });
        }
    }

    #apiInstructionsDelete(res, id) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        const deleted = manager.delete(id);
        if (!deleted) {
            return this.#json(res, 404, { error: "Instruction not found" });
        }
        this.#json(res, 204);
    }

    #apiInstructionsToggle(res, id, action) {
        const manager = this.#ctx.siOrchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Standing instruction manager not available" });
        }
        try {
            let instruction;
            if (action === "enable") {
                instruction = manager.enable(id);
            } else if (action === "disable") {
                instruction = manager.disable(id);
            } else {
                // toggle
                const current = manager.get(id);
                if (!current) {
                    return this.#json(res, 404, { error: "Instruction not found" });
                }
                instruction = current.enabled ? manager.disable(id) : manager.enable(id);
            }
            if (!instruction) {
                return this.#json(res, 404, { error: "Instruction not found" });
            }
            this.#json(res, 200, instruction);
        } catch (err) {
            this.#json(res, 400, { error: err.message });
        }
    }

    async #apiStandingReconnect(res) {
        const siOrchestrator = this.#ctx.siOrchestrator;
        if (!siOrchestrator) {
            return this.#json(res, 503, { error: "Standing orchestrator not available" });
        }
        try {
            const connected = await siOrchestrator.reconnectHA();
            this.#json(res, 200, { reconnected: true, connected });
        } catch (err) {
            this.#json(res, 500, { error: `Reconnect failed: ${err.message}` });
        }
    }

    // ── Chats API ──────────────────────────────────────────────

    async #apiChats(res) {
        const config = this.#ctx.config;
        const telegram = this.#ctx.telegram;
        const rbac = this.#ctx.rbac;

        // 1. Paired users from RBAC
        const users = rbac ? rbac.getPairedUsers().map(u => ({
            type: "user",
            chatId: u.userId,
            name: u.displayName || u.username || String(u.userId),
            username: u.username || null,
            role: u.role,
        })) : [];

        // 2. Allowed groups — fetch info from Telegram API
        const groups = [];
        const groupIds = config.allowedGroups || [];
        for (const gid of groupIds) {
            const chatId = parseInt(gid);
            if (isNaN(chatId)) continue;
            const entry = { type: "group", chatId, name: `Group ${gid}`, members: [] };
            try {
                const chat = await telegram.call("getChat", { chat_id: chatId });
                entry.name = chat.title || entry.name;
                entry.memberCount = chat.member_count || null;
                entry.isForum = chat.is_forum || false;
            } catch (err) {
                entry.error = err.message;
            }
            try {
                const admins = await telegram.call("getChatAdministrators", { chat_id: chatId });
                entry.members = (admins || []).map(m => ({
                    userId: m.user?.id,
                    name: [m.user?.first_name, m.user?.last_name].filter(Boolean).join(" "),
                    username: m.user?.username || null,
                    isBot: m.user?.is_bot || false,
                    status: m.status,
                }));
            } catch {}
            groups.push(entry);
        }

        // 3. Owner chat IDs not in RBAC (pre-approved but not yet paired)
        const pairedIds = new Set(users.map(u => u.chatId));
        const ownerChats = (config.allowedChatIds || [])
            .map(Number)
            .filter(id => !isNaN(id) && !pairedIds.has(id))
            .map(id => ({ type: "user", chatId: id, name: `User ${id}`, username: null, role: "owner (pre-approved)" }));

        this.#json(res, 200, { users: [...users, ...ownerChats], groups });
    }

    // ── Dispatch API ────────────────────────────────────────────

    async #apiDispatch(res, body, principal) {
        const { prompt, description, model } = body || {};
        const callerScope = principal?.scopeKey || null;
        if (callerScope?.startsWith("webui:")) {
            return this.#json(res, 403, { error: "Dispatch is not available from WebUI yet" });
        }
        if (!prompt || typeof prompt !== "string") {
            return this.#json(res, 400, { error: "prompt is required" });
        }
        if (!description || typeof description !== "string") {
            return this.#json(res, 400, { error: "description is required" });
        }

        const convMgr = this.#ctx.conversationManager;
        const config = this.#ctx.config;
        const telegram = this.#ctx.telegram;
        const enricher = this.#ctx.enricher;

        if (!convMgr) {
            return this.#json(res, 503, { error: "Conversation manager not available" });
        }

        // Resolve chat/thread from caller's scope if available, otherwise fall back
        let chatId, threadId = null;
        if (callerScope) {
            const callerConv = convMgr.get(callerScope);
            if (callerConv?.ref) {
                chatId = callerConv.ref.chatId;
                threadId = callerConv.ref.threadId || null;
            }
        }
        if (!chatId) chatId = config.allowedChatIds?.[0];
        if (!chatId) {
            return this.#json(res, 400, { error: "No target chat configured" });
        }

        // Guard: limit concurrent dispatches to prevent recursive exhaustion
        const activeDispatches = convMgr.list().filter(c => c.scopeKey.startsWith("dispatch:"));
        if (activeDispatches.length >= 3) {
            return this.#json(res, 429, { error: "Too many dispatched tasks in flight (max 3)" });
        }

        const scopeKey = `dispatch:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        // Determine chat type from chatId (groups have negative IDs in Telegram)
        const chatType = chatId < 0 ? "supergroup" : "private";
        const ref = {
            chatId,
            userId: 0,
            chatType,
            threadId,
            isForum: !!threadId,
            username: "dispatcher",
            firstName: "Dispatched Agent",
        };

        // Enrich the prompt with system context (IDENTITY.md, PKM, etc.)
        const enrichedPrompt = enricher
            ? enricher.enrich(prompt, ref, { isFirstMessage: true, isDispatcher: false })
            : prompt;

        // Model selection: explicit param > user's default_model > fallback "standard"
        const requestedModel = model || config.defaultModel || "standard";
        log.info(`Dispatch: "${description}" → ${requestedModel} [${scopeKey}]`);

        // Fire-and-forget: create conversation and route prompt asynchronously
        setImmediate(() => {
            convMgr.route(scopeKey, enrichedPrompt, ref, {
                model: requestedModel,
                mcpProfile: "owner",
            }).then(() => {
                log.info(`Dispatch complete: "${description}"`);
                // Clean up the dispatch conversation
                convMgr.destroy(scopeKey).catch(() => {});
            }).catch(err => {
                log.error(`Dispatch failed: "${description}" — ${err.message}`);
                if (telegram && chatId) {
                    telegram.sendMessage(chatId, `❌ Dispatched task failed: ${description}\n${err.message}`).catch(() => {});
                }
            });
        });

        this.#json(res, 200, { status: "dispatched", scopeKey, model: requestedModel, description });
    }

    // ── Docs API ────────────────────────────────────────────────

    #apiDocsList(res) {
        const agentDir = this.#ctx.config?.agentDir || "/config/.agent";
        const docs = [];

        // Main docs
        for (const name of ["IDENTITY.md", "MEMORY.md", "TASKS.md", "SKILLS.md"]) {
            const path = join(agentDir, name);
            docs.push({
                name,
                path,
                exists: existsSync(path),
                type: "main",
            });
        }

        // Skills
        const skillsDir = join(agentDir, "skills");
        if (existsSync(skillsDir)) {
            try {
                const files = readdirSync(skillsDir)
                    .filter(f => f.endsWith(".md"))
                    .sort();
                for (const f of files) {
                    docs.push({
                        name: `skills/${f}`,
                        path: join(skillsDir, f),
                        exists: true,
                        type: "skill",
                    });
                }
            } catch {}
        }

        // Daily logs
        const memDir = join(agentDir, "memory");
        if (existsSync(memDir)) {
            try {
                const files = readdirSync(memDir)
                    .filter(f => f.endsWith(".md"))
                    .sort()
                    .reverse();
                for (const f of files) {
                    docs.push({
                        name: `memory/${f}`,
                        path: join(memDir, f),
                        exists: true,
                        type: "daily_log",
                    });
                }
            } catch {}
        }

        this.#json(res, 200, docs);
    }

    #apiDocsGet(res, name) {
        const agentDir = this.#ctx.config?.agentDir || "/config/.agent";
        const filePath = resolve(agentDir, name);

        // Security: ensure path stays within agent dir
        if (!filePath.startsWith(resolve(agentDir) + "/")) {
            return this.#json(res, 403, { error: "Access denied" });
        }

        if (!existsSync(filePath)) {
            return this.#json(res, 404, { error: "File not found" });
        }

        try {
            const content = readFileSync(filePath, "utf-8");
            this.#json(res, 200, { name, content });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to read file: ${err.message}` });
        }
    }

    #apiDocsPut(res, name, body) {
        const agentDir = this.#ctx.config?.agentDir || "/config/.agent";
        const filePath = resolve(agentDir, name);

        // Security: ensure path stays within agent dir
        if (!filePath.startsWith(resolve(agentDir) + "/")) {
            return this.#json(res, 403, { error: "Access denied" });
        }

        const content = body?.content;
        if (typeof content !== "string") {
            return this.#json(res, 400, { error: "Body must contain 'content' string" });
        }

        try {
            const dir = dirname(filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFile(filePath, content, "utf-8", (err) => {
                if (err) {
                    this.#json(res, 500, { error: `Failed to write file: ${err.message}` });
                } else {
                    this.#json(res, 200, { name, saved: true });
                }
            });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to write file: ${err.message}` });
        }
    }

    // ── Scopes API ──────────────────────────────────────────────

    #apiScopesList(res) {
        const conversationManager = this.#ctx.conversationManager;
        if (!conversationManager) {
            return this.#json(res, 503, { error: "Conversation manager not available" });
        }
        this.#json(res, 200, conversationManager.list());
    }

    // ── Logs API ────────────────────────────────────────────────

    #apiLogs(res) {
        this.#json(res, 200, this.#logBuffer);
    }

    #apiLogStream(req, res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write(":ok\n\n");

        this.#sseClients.add(res);

        // Heartbeat to keep connection alive behind proxies (HA Ingress/nginx)
        const heartbeat = setInterval(() => {
            try { res.write(":heartbeat\n\n"); }
            catch { clearInterval(heartbeat); this.#sseClients.delete(res); }
        }, 30_000);

        req.on("close", () => {
            clearInterval(heartbeat);
            this.#sseClients.delete(res);
        });
    }

    // ── System Info API ─────────────────────────────────────────

    async #apiSystemInfo(res) {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) {
            return this.#json(res, 503, { error: "No supervisor token" });
        }

        try {
            const headers = { Authorization: `Bearer ${token}` };
            const [hostRes, osRes, coreRes] = await Promise.all([
                fetch("http://supervisor/host/info", { headers }),
                fetch("http://supervisor/os/info", { headers }),
                fetch("http://supervisor/core/info", { headers }),
            ]);

            const host = hostRes.ok ? (await hostRes.json()).data : {};
            const os = osRes.ok ? (await osRes.json()).data : {};
            const core = coreRes.ok ? (await coreRes.json()).data : {};

            this.#json(res, 200, {
                hostname: host.hostname || "unknown",
                kernel: host.kernel || null,
                chassis: host.chassis || null,
                disk_free: host.disk_free ?? null,
                disk_total: host.disk_total ?? null,
                disk_used: host.disk_used ?? null,
                os_version: os.version || null,
                board: os.board || null,
                ha_version: core.version || null,
                ha_arch: core.arch || null,
            });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to fetch system info: ${err.message}` });
        }
    }

    // ── Entity Search API ───────────────────────────────────────

    async #apiEntities(res, params) {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) {
            return this.#json(res, 503, { error: "No supervisor token" });
        }

        try {
            const statesRes = await fetch("http://supervisor/core/api/states", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!statesRes.ok) {
                return this.#json(res, 502, { error: `HA API error: ${statesRes.status}` });
            }

            const states = await statesRes.json();
            const query = (params.q || "").toLowerCase();
            const domain = params.domain || "";

            let results = states.map(s => ({
                entity_id: s.entity_id,
                state: s.state,
                friendly_name: s.attributes?.friendly_name || "",
                domain: s.entity_id.split(".")[0],
            }));

            if (domain) {
                results = results.filter(e => e.domain === domain);
            }

            if (query) {
                results = results.filter(e =>
                    e.entity_id.toLowerCase().includes(query) ||
                    e.friendly_name.toLowerCase().includes(query)
                );
            }

            // Limit results for performance
            results = results.slice(0, 100);

            this.#json(res, 200, results);
        } catch (err) {
            this.#json(res, 500, { error: `Failed to fetch entities: ${err.message}` });
        }
    }

    // ── Config API ──────────────────────────────────────────────

    async #getAddonSlug() {
        if (this.#addonSlug) return this.#addonSlug;
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) return null;
        try {
            const res = await fetch("http://supervisor/addons/self/info", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                this.#addonSlug = data.data?.slug || null;
            }
        } catch {}
        return this.#addonSlug;
    }

    async #apiConfigGet(res) {
        const token = process.env.SUPERVISOR_TOKEN;
        const slug = await this.#getAddonSlug();
        if (!token || !slug) {
            return this.#json(res, 503, { error: "Supervisor unavailable" });
        }

        try {
            const infoRes = await fetch(`http://supervisor/addons/${slug}/info`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!infoRes.ok) {
                return this.#json(res, 502, { error: `Supervisor API error: ${infoRes.status}` });
            }
            const info = await infoRes.json();
            const options = info.data?.options || {};
            const schema = info.data?.schema || {};

            // Redact sensitive fields — HA schema is an object { key: "password", ... }
            const safeOptions = { ...options };
            if (schema && typeof schema === "object" && !Array.isArray(schema)) {
                for (const [key, type] of Object.entries(schema)) {
                    if (typeof type === "string" && type.startsWith("password") && safeOptions[key]) {
                        safeOptions[key] = "••••••••";
                    }
                }
            }

            this.#json(res, 200, {
                options: safeOptions,
                schema,
                version: info.data?.version || null,
            });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to fetch config: ${err.message}` });
        }
    }

    async #apiConfigPut(res, body) {
        const token = process.env.SUPERVISOR_TOKEN;
        const slug = await this.#getAddonSlug();
        if (!token || !slug) {
            return this.#json(res, 503, { error: "Supervisor unavailable" });
        }

        try {
            const options = body?.options;
            if (!options || typeof options !== "object") {
                return this.#json(res, 400, { error: "Body must contain 'options' object" });
            }

            // Remove redacted password fields so they aren't overwritten
            const cleanOptions = { ...options };
            for (const [key, val] of Object.entries(cleanOptions)) {
                if (val === "••••••••") delete cleanOptions[key];
            }

            const updateRes = await fetch(`http://supervisor/addons/${slug}/options`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ options: cleanOptions }),
            });

            if (!updateRes.ok) {
                const err = await updateRes.json().catch(() => ({}));
                return this.#json(res, 502, { error: err.message || `Supervisor error: ${updateRes.status}` });
            }

            this.#json(res, 200, { saved: true });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to save config: ${err.message}` });
        }
    }

    async #apiConfigRestart(res) {
        const token = process.env.SUPERVISOR_TOKEN;
        const slug = await this.#getAddonSlug();
        if (!token || !slug) {
            return this.#json(res, 503, { error: "Supervisor unavailable" });
        }

        try {
            // Respond before restarting since we'll be killed
            this.#json(res, 200, { restarting: true });

            // Give the response time to flush, then restart
            setTimeout(async () => {
                try {
                    await fetch(`http://supervisor/addons/${slug}/restart`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${token}` },
                    });
                } catch {}
            }, 500);
        } catch (err) {
            this.#json(res, 500, { error: `Failed to restart: ${err.message}` });
        }
    }

    // ── Chat API (Copilot Web Chat) ─────────────────────────────

    #getWebuiConversation(scopeKey) {
        return this.#ctx.conversationManager?.get?.(scopeKey) || null;
    }

    #getWebuiConversationStatus(scopeKey) {
        const conversation = this.#getWebuiConversation(scopeKey);
        const status = conversation?.toStatus?.() || {
            scopeKey,
            state: "idle",
            instanceId: null,
            model: null,
            promptCount: 0,
            idleMs: 0,
            lastActivity: null,
        };
        return {
            ...status,
            connected: !!conversation,
            busy: conversation ? !["idle", "dead"].includes(conversation.state) : false,
        };
    }

    #resolveWebuiPrincipal(req) {
        const headers = req.headers || {};
        const ingressPath = headers["x-ingress-path"] || "";
        const remoteUserId = headers["x-remote-user-id"] || headers["x-hass-user"] || null;
        const remoteUserName = headers["x-remote-user-name"] || headers["x-hass-user-name"] || null;
        const remoteDisplayName = headers["x-remote-user-display-name"] || headers["x-hass-user-display-name"] || remoteUserName || null;
        const remoteIp = req.socket?.remoteAddress || "";

        if (!ingressPath && !remoteUserId) return null;
        if (!remoteUserId) return null;
        if (!remoteIp || !TRUSTED_INGRESS_IPS.has(remoteIp)) {
            log.warn(`Untrusted WebUI request source: ${remoteIp}`);
            return null;
        }

        return this.#ctx.controlStore?.resolveWebuiPrincipal({
            haUserId: remoteUserId,
            username: remoteUserName,
            displayName: remoteDisplayName,
        }) || null;
    }

    #getWebuiRef(principal) {
        const existing = this.#getWebuiConversation(principal.scopeKey)?.ref;
        if (existing) return existing;

        return {
            chatId: `webui:${principal.principalId}`,
            chatType: "private",
            userId: principal.principalId,
            username: principal.username || "webui",
            firstName: principal.displayName || principal.username || "WebUI",
        };
    }

    #apiChatStatus(res, principal) {
        const status = this.#getWebuiConversationStatus(principal.scopeKey);
        status.pendingApproval = this.#ctx.approvalService?.getPendingWebuiApproval(principal.principalId, principal.scopeKey) || null;
        const conversation = this.#getWebuiConversation(principal.scopeKey);
        status.pendingElicitation = conversation?.state === "eliciting" ? { message: "The agent needs your input. Reply below or decline." } : null;
        this.#json(res, 200, status);
    }

    #apiChatStream(req, res, principal) {
        const scopeKey = principal.scopeKey;
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        const status = this.#getWebuiConversationStatus(scopeKey);
        status.pendingApproval = this.#ctx.approvalService?.getPendingWebuiApproval(principal.principalId, scopeKey) || null;
        const conversation = this.#getWebuiConversation(scopeKey);
        status.pendingElicitation = conversation?.state === "eliciting" ? { message: "The agent needs your input. Reply below or decline." } : null;
        res.write(`data: ${JSON.stringify({ type: "status", ...status })}\n\n`);

        if (!this.#chatSseClients.has(scopeKey)) this.#chatSseClients.set(scopeKey, new Set());
        this.#chatSseClients.get(scopeKey).add(res);

        // Heartbeat to keep connection alive behind proxies (HA Ingress/nginx)
        const heartbeat = setInterval(() => {
            try { res.write(":heartbeat\n\n"); }
            catch {
                clearInterval(heartbeat);
                this.#chatSseClients.get(scopeKey)?.delete(res);
            }
        }, 30_000);

        req.on("close", () => {
            clearInterval(heartbeat);
            const clients = this.#chatSseClients.get(scopeKey);
            clients?.delete(res);
            if (clients && clients.size === 0) {
                this.#chatSseClients.delete(scopeKey);
                this.#detachChatConvListeners(scopeKey);
            }
            try { res.end(); } catch {}
        });

        // Ensure conversation event listeners are attached
        this.#ensureChatConvListeners(scopeKey);
    }

    /** Broadcast a chat event to all connected chat SSE clients. */
    #broadcastChatEvent(scopeKey, event) {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        const clients = this.#chatSseClients.get(scopeKey);
        if (!clients) return;
        for (const client of clients) {
            try { client.write(payload); }
            catch { clients.delete(client); }
        }
    }

    /**
     * Attach event listeners to a per-user WebUI conversation.
     * Re-attaches whenever the conversation instance changes.
     */
    #ensureChatConvListeners(scopeKey) {
        const conv = this.#getWebuiConversation(scopeKey);
        if (!conv) return; // no conversation yet — listeners will attach on send

        // Already listening to this conversation instance
        const existing = this.#chatConvListeners.get(scopeKey);
        if (existing?.target === conv) return;

        // Detach from previous conversation if any
        this.#detachChatConvListeners(scopeKey);

        const listeners = {
            target: conv,
            text_chunk: ({ text }) =>
                this.#broadcastChatEvent(scopeKey, { type: "text_chunk", text }),
            thought_chunk: ({ text }) =>
                this.#broadcastChatEvent(scopeKey, { type: "thought", text }),
            tool_start: (data) =>
                this.#broadcastChatEvent(scopeKey, { type: "tool_start", toolCallId: data.toolCallId, name: data.name }),
            tool_end: (data) =>
                this.#broadcastChatEvent(scopeKey, { type: "tool_end", toolCallId: data.toolCallId, status: data.status }),
            prompt_complete: () => {
                this.#broadcastChatEvent(scopeKey, { type: "done", ...this.#getWebuiConversationStatus(scopeKey) });
            },
            autopilot_complete: () => {
                this.#broadcastChatEvent(scopeKey, { type: "done", ...this.#getWebuiConversationStatus(scopeKey) });
            },
            error: (err) =>
                this.#broadcastChatEvent(scopeKey, { type: "error", message: err.message }),
            dead: () =>
                this.#broadcastChatEvent(scopeKey, { type: "error", message: "Conversation ended unexpectedly" }),
            elicitation: (data) =>
                this.#broadcastChatEvent(scopeKey, { type: "elicitation", message: data.message }),
        };

        for (const [event, fn] of Object.entries(listeners)) {
            if (event === "target") continue;
            conv.on(event, fn);
        }
        this.#chatConvListeners.set(scopeKey, listeners);
    }

    #detachChatConvListeners(scopeKey) {
        const listeners = this.#chatConvListeners.get(scopeKey);
        if (!listeners) return;
        const { target, ...fns } = listeners;
        for (const [event, fn] of Object.entries(fns)) {
            target.removeListener(event, fn);
        }
        this.#chatConvListeners.delete(scopeKey);
    }

    #detachAllChatConvListeners() {
        for (const scopeKey of this.#chatConvListeners.keys()) {
            this.#detachChatConvListeners(scopeKey);
        }
    }

    async #apiChatSend(res, body, principal) {
        const conversationManager = this.#ctx.conversationManager;
        if (!conversationManager) {
            return this.#json(res, 503, { error: "Conversation manager not available" });
        }

        const text = body?.text?.trim();
        if (!text) {
            return this.#json(res, 400, { error: "Message text is required" });
        }

        const scopeKey = principal.scopeKey;
        const ref = this.#getWebuiRef(principal);

        try {
            // Broadcast user message and message_start to SSE clients
            this.#broadcastChatEvent(scopeKey, { type: "user_message", text });
            this.#broadcastChatEvent(scopeKey, { type: "message_start" });
            this.#ensureChatConvListeners(scopeKey);

            // Force safe defaults — never trust client-supplied model/mcpProfile
            const isOperator = this.#isWebuiOperator(principal);
            const opts = {
                model: isOperator
                    ? (this.#ctx.config?.defaultModel || "standard")
                    : (this.#ctx.config?.guestModel || "fast"),
                mcpProfile: isOperator ? "owner" : "guest",
                messageId: null,
                _forcedTransport: "off",
            };

            // Don't await — route() blocks until prompt completes.
            // We respond immediately and let SSE carry the streaming events.
            const routePromise = conversationManager.route(scopeKey, text, ref, opts);
            let settled = false;
            routePromise.finally(() => { settled = true; });

            // Poll briefly for conversation to appear (created before prompt starts)
            const attachListeners = async () => {
                for (let i = 0; i < 400; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    const conv = this.#getWebuiConversation(scopeKey);
                    if (conv) { this.#ensureChatConvListeners(scopeKey); return; }
                    if (settled) return;
                }
            };
            attachListeners();

            // Handle completion/errors in background
            routePromise.catch(err => {
                this.#broadcastChatEvent(scopeKey, { type: "error", message: err.message });
            });

            this.#json(res, 200, { sent: true, conversation: this.#getWebuiConversationStatus(scopeKey) });
        } catch (err) {
            this.#broadcastChatEvent(scopeKey, { type: "error", message: err.message });
            this.#json(res, 500, { error: `Chat error: ${err.message}` });
        }
    }

    async #apiChatNew(res, principal) {
        const conversationManager = this.#ctx.conversationManager;
        if (!conversationManager) {
            return this.#json(res, 503, { error: "Conversation manager not available" });
        }

        try {
            this.#detachChatConvListeners(principal.scopeKey);
            const cleared = await conversationManager.destroy(principal.scopeKey);
            this.#broadcastChatEvent(principal.scopeKey, { type: "new_session" });
            this.#json(res, 200, { cleared, conversation: this.#getWebuiConversationStatus(principal.scopeKey) });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to reset conversation: ${err.message}` });
        }
    }

    async #apiChatStop(res, principal) {
        const conversation = this.#getWebuiConversation(principal.scopeKey);
        if (!conversation || ["idle", "dead"].includes(conversation.state)) {
            return this.#json(res, 200, { stopped: false, conversation: this.#getWebuiConversationStatus(principal.scopeKey) });
        }

        try {
            const stopped = await conversation.stop("⏹️ Stopped from WebUI.");
            this.#json(res, 200, { stopped, conversation: this.#getWebuiConversationStatus(principal.scopeKey) });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to stop: ${err.message}` });
        }
    }

    async #apiChatApproval(res, body, principal) {
        const approvalId = body?.approvalId;
        const optionId = body?.optionId;
        if (!approvalId || !optionId) {
            return this.#json(res, 400, { error: "approvalId and optionId are required" });
        }
        const result = await this.#ctx.approvalService.respondWebuiApproval(principal.principalId, approvalId, optionId);
        if (!result.ok) {
            return this.#json(res, 404, { error: result.error });
        }
        return this.#json(res, 200, { ok: true });
    }

    async #apiChatElicitation(res, body, principal) {
        const conversation = this.#getWebuiConversation(principal.scopeKey);
        if (!conversation || conversation.state !== "eliciting") {
            return this.#json(res, 404, { error: "No pending elicitation" });
        }
        const action = body?.action;
        if (action !== "decline") {
            return this.#json(res, 400, { error: "Only decline is supported via this endpoint" });
        }
        await conversation.respondElicitation("decline");
        return this.#json(res, 200, { ok: true });
    }

    #isWebuiOperator(principal) {
        const allowed = this.#ctx.config?.webuiOperatorIds || [];
        return !!principal?.principalId && allowed.includes(String(principal.principalId));
    }

    // ── Helpers ─────────────────────────────────────────────────

    #json(res, status, data = null) {
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        if (status === 204) {
            res.end();
        } else {
            res.end(JSON.stringify(data));
        }
    }

    #serveStatic(res, pathname) {
        if (pathname === "/") pathname = "/index.html";

        const filePath = join(STATIC_DIR, pathname);
        const resolved = resolve(filePath);

        // Security: prevent directory traversal
        if (!resolved.startsWith(resolve(STATIC_DIR))) {
            this.#json(res, 403, { error: "Forbidden" });
            return;
        }

        if (!existsSync(resolved)) {
            // SPA fallback — serve index.html for non-API, non-static routes
            const indexPath = join(STATIC_DIR, "index.html");
            if (existsSync(indexPath)) {
                const content = readFileSync(indexPath, "utf-8");
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(content);
                return;
            }
            this.#json(res, 404, { error: "Not found" });
            return;
        }

        const ext = extname(resolved).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        readFile(resolved, (err, data) => {
            if (err) {
                this.#json(res, 500, { error: "Failed to read file" });
                return;
            }
            res.writeHead(200, {
                "Content-Type": contentType,
                "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
            });
            res.end(data);
        });
    }

    async #readBody(req, maxBytes = 1_048_576) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.destroy();
                    return reject(new Error("Request body too large"));
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try {
                    const raw = Buffer.concat(chunks).toString("utf-8");
                    resolve(raw ? JSON.parse(raw) : {});
                } catch (err) {
                    reject(new Error("Invalid JSON body"));
                }
            });
            req.on("error", reject);
        });
    }
}
