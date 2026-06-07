// ============================================================
// Web UI Server — Ingress-based dashboard for the Copilot Bot
// ============================================================
// Lightweight HTTP server using Node built-in http module.
// Serves REST API + static frontend. Auth handled by HA Ingress.

import http from "node:http";
import { readFileSync, readdirSync, statSync, readFile, writeFile } from "node:fs";
import { join, extname, resolve, basename, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { ACPClient } from "../ai/copilot/acp-client.mjs";
import { AgentMemory } from "../core/agent-memory.mjs";
import { metrics } from "../core/metrics.mjs";
import { createLogger } from "../logger.mjs";

const STATIC_DIR = new URL("./dist/", import.meta.url).pathname;
const log = createLogger("webui");

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
    #addonSlug = null;     // resolved lazily
    #chatAcp = null;       // dedicated ACP client for web chat
    #chatSseClients = new Set(); // SSE connections for chat streaming
    #chatBusy = false;     // true while a prompt is in progress
    #chatSessionId = null; // current ACP session ID for web chat
    #chatInitPromise = null; // deduplicates concurrent init calls
    #chatInitFailures = 0; // count consecutive auto-init failures
    static #MAX_INIT_FAILURES = 3; // disable auto-init after this many consecutive failures

    constructor({ port = 8099 } = {}) {
        this.#port = port;
    }

    /**
     * Attach bot internals so API routes can access them.
     * Call this before start().
     */
    attach({ bridge, orchestrator, scopeMgr, config, acp, telegram, startedAt, pairing }) {
        this.#ctx = { bridge, orchestrator, scopeMgr, config, acp, telegram, startedAt, pairing };
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

    async start() {
        this.#server = http.createServer((req, res) => this.#handleRequest(req, res));
        this.#server.listen(this.#port, () => {
            log.info(`Server listening on port ${this.#port}`);
        });
    }

    async stop() {
        // Stop chat ACP if running
        if (this.#chatAcp) {
            try { await this.#chatAcp.stop(); } catch {}
            this.#chatAcp = null;
        }

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
                return await this.#handleApi(req, res, pathname, params);
            }

            // Static file serving
            return this.#serveStatic(res, pathname);
        } catch (err) {
            log.error(`Request error: ${err.message}`);
            this.#json(res, 500, { error: "Internal server error" });
        }
    }

    async #handleApi(req, res, pathname, params) {
        const method = req.method;

        // GET /api/status — bot status overview
        if (pathname === "/api/status" && method === "GET") {
            return this.#apiStatus(res);
        }

        // GET /api/metrics — cumulative metrics
        if (pathname === "/api/metrics" && method === "GET") {
            return this.#json(res, 200, metrics.toJSON());
        }

        // POST /api/metrics/reset — manual metrics reset
        if (pathname === "/api/metrics/reset" && method === "POST") {
            metrics.reset();
            return this.#json(res, 200, { ok: true, message: "Metrics reset" });
        }

        // GET /api/instructions — list standing instructions
        if (pathname === "/api/instructions" && method === "GET") {
            return this.#apiInstructionsList(res);
        }

        // POST /api/instructions — create instruction
        if (pathname === "/api/instructions" && method === "POST") {
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
                const body = await this.#readBody(req);
                return this.#apiInstructionsUpdate(res, id, body);
            }
            if (method === "DELETE") {
                return this.#apiInstructionsDelete(res, id);
            }
        }

        // POST /api/instructions/:id/toggle
        const toggleMatch = pathname.match(/^\/api\/instructions\/([^/]+)\/(enable|disable|toggle)$/);
        if (toggleMatch && method === "POST") {
            const id = decodeURIComponent(toggleMatch[1]);
            const action = toggleMatch[2];
            return this.#apiInstructionsToggle(res, id, action);
        }

        // POST /api/standing/reconnect — force reconnect HA WebSocket
        if (pathname === "/api/standing/reconnect" && method === "POST") {
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
            const body = await this.#readBody(req);
            return this.#apiConfigPut(res, body);
        }

        // POST /api/config/restart — restart the add-on
        if (pathname === "/api/config/restart" && method === "POST") {
            return this.#apiConfigRestart(res);
        }

        // GET /api/chat/status — web chat ACP status
        if (pathname === "/api/chat/status" && method === "GET") {
            return this.#apiChatStatus(res);
        }

        // GET /api/chat/stream — SSE stream for chat events
        if (pathname === "/api/chat/stream" && method === "GET") {
            return this.#apiChatStream(req, res);
        }

        // POST /api/chat/send — send a message to web chat ACP
        if (pathname === "/api/chat/send" && method === "POST") {
            const body = await this.#readBody(req);
            return this.#apiChatSend(res, body);
        }

        // POST /api/chat/new — start a new chat session
        if (pathname === "/api/chat/new" && method === "POST") {
            return this.#apiChatNew(res);
        }

        // POST /api/chat/stop — cancel the current prompt
        if (pathname === "/api/chat/stop" && method === "POST") {
            return this.#apiChatStop(res);
        }

        // ── RBAC API ────────────────────────────────────────────────

        // GET /api/rbac/roles — list all roles
        if (pathname === "/api/rbac/roles" && method === "GET") {
            return this.#apiRbacListRoles(res);
        }

        // POST /api/rbac/roles — create custom role
        if (pathname === "/api/rbac/roles" && method === "POST") {
            const body = await this.#readBody(req);
            return this.#apiRbacCreateRole(res, body);
        }

        // /api/rbac/roles/:name
        const roleMatch = pathname.match(/^\/api\/rbac\/roles\/([^/]+)$/);
        if (roleMatch) {
            const name = decodeURIComponent(roleMatch[1]);
            if (method === "GET") return this.#apiRbacGetRole(res, name);
            if (method === "PUT") {
                const body = await this.#readBody(req);
                return this.#apiRbacUpdateRole(res, name, body);
            }
            if (method === "DELETE") return this.#apiRbacDeleteRole(res, name);
        }

        // GET /api/rbac/users — list all users
        if (pathname === "/api/rbac/users" && method === "GET") {
            return this.#apiRbacListUsers(res);
        }

        // /api/rbac/users/:userId
        const userMatch = pathname.match(/^\/api\/rbac\/users\/([^/]+)$/);
        if (userMatch) {
            const userId = decodeURIComponent(userMatch[1]);
            if (method === "GET") return this.#apiRbacGetUser(res, userId);
            if (method === "DELETE") return this.#apiRbacRevokeUser(res, userId);
        }

        // PUT /api/rbac/users/:userId/role
        const userRoleMatch = pathname.match(/^\/api\/rbac\/users\/([^/]+)\/role$/);
        if (userRoleMatch && method === "PUT") {
            const userId = decodeURIComponent(userRoleMatch[1]);
            const body = await this.#readBody(req);
            return this.#apiRbacSetUserRole(res, userId, body);
        }

        // POST /api/rbac/check — debug permission check
        if (pathname === "/api/rbac/check" && method === "POST") {
            const body = await this.#readBody(req);
            return this.#apiRbacCheckPermission(res, body);
        }

        // POST /api/rbac/invites — create invite
        if (pathname === "/api/rbac/invites" && method === "POST") {
            const body = await this.#readBody(req);
            return this.#apiRbacCreateInvite(res, body);
        }

        // GET /api/rbac/invites — list invites
        if (pathname === "/api/rbac/invites" && method === "GET") {
            return this.#apiRbacListInvites(res, params);
        }

        // DELETE /api/rbac/invites — revoke invite
        if (pathname === "/api/rbac/invites" && method === "DELETE") {
            const body = await this.#readBody(req);
            return this.#apiRbacRevokeInvite(res, body);
        }

        // GET /api/rbac/overrides — list overrides
        if (pathname === "/api/rbac/overrides" && method === "GET") {
            return this.#apiRbacListOverrides(res, params);
        }

        // POST /api/rbac/overrides — add/update override
        if (pathname === "/api/rbac/overrides" && method === "POST") {
            const body = await this.#readBody(req);
            return this.#apiRbacSetOverride(res, body);
        }

        // DELETE /api/rbac/overrides — remove override
        if (pathname === "/api/rbac/overrides" && method === "DELETE") {
            const body = await this.#readBody(req);
            return this.#apiRbacDeleteOverride(res, body);
        }

        // GET /api/rbac/audit — get audit log entries
        if (pathname === "/api/rbac/audit" && method === "GET") {
            return this.#apiRbacGetAudit(res, params);
        }

        this.#json(res, 404, { error: "Not found" });
    }

    // ── Status API ──────────────────────────────────────────────

    #apiStatus(res) {
        const { bridge, orchestrator, scopeMgr, config, acp, startedAt } = this.#ctx;

        const uptime = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
        const orchestratorStatus = orchestrator?.status() || {};

        const status = {
            bot: {
                version: config?.version || "unknown",
                uptime,
                startedAt: startedAt ? new Date(startedAt).toISOString() : null,
                promptActive: bridge?.promptActive ?? false,
            },
            copilot: {
                connected: acp?.alive ?? false,
                model: config?.model || "auto",
            },
            homeAssistant: {
                connected: config?.haConnected ?? false,
                version: config?.haVersion || null,
            },
            orchestrator: orchestratorStatus,
            scopes: scopeMgr?.stats() || { dm: 0, group: 0, forum: 0, total: 0 },
        };

        this.#json(res, 200, status);
    }

    // ── Instructions API ────────────────────────────────────────

    #apiInstructionsList(res) {
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
        }
        this.#json(res, 200, manager.list());
    }

    #apiInstructionsGet(res, id) {
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
        }
        const instruction = manager.get(id);
        if (!instruction) {
            return this.#json(res, 404, { error: "Instruction not found" });
        }
        this.#json(res, 200, instruction);
    }

    #apiInstructionsCreate(res, body) {
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
        }
        try {
            const instruction = manager.create(body);
            this.#json(res, 201, instruction);
        } catch (err) {
            this.#json(res, 400, { error: err.message });
        }
    }

    #apiInstructionsUpdate(res, id, body) {
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
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
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
        }
        const deleted = manager.delete(id);
        if (!deleted) {
            return this.#json(res, 404, { error: "Instruction not found" });
        }
        this.#json(res, 204);
    }

    #apiInstructionsToggle(res, id, action) {
        const manager = this.#ctx.orchestrator?.manager;
        if (!manager) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
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
        const orchestrator = this.#ctx.orchestrator;
        if (!orchestrator) {
            return this.#json(res, 503, { error: "Orchestrator not available" });
        }
        try {
            const connected = await orchestrator.reconnectHA();
            this.#json(res, 200, { reconnected: true, connected });
        } catch (err) {
            this.#json(res, 500, { error: `Reconnect failed: ${err.message}` });
        }
    }

    // ── Docs API ────────────────────────────────────────────────

    #apiDocsList(res) {
        const agentDir = this.#ctx.config?.agentDir || "/config/copilot-telegram-bot";
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
        const agentDir = this.#ctx.config?.agentDir || "/config/copilot-telegram-bot";
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
        const agentDir = this.#ctx.config?.agentDir || "/config/copilot-telegram-bot";
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
        const scopeMgr = this.#ctx.scopeMgr;
        if (!scopeMgr) {
            return this.#json(res, 503, { error: "Scope manager not available" });
        }
        this.#json(res, 200, scopeMgr.list());
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

        req.on("close", () => {
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
            const schema = info.data?.schema || [];

            // Redact sensitive fields
            const safeOptions = { ...options };
            for (const field of schema) {
                if (field.format === "password" && safeOptions[field.name]) {
                    safeOptions[field.name] = "••••••••";
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

    #chatSseEmit(event) {
        for (const client of this.#chatSseClients) {
            try {
                client.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
                this.#chatSseClients.delete(client);
            }
        }
    }

    async #ensureChatAcp() {
        if (this.#chatAcp?.alive) return this.#chatAcp;

        // Deduplicate concurrent initialization calls
        if (this.#chatInitPromise) return this.#chatInitPromise;
        this.#chatInitPromise = this.#doInitChatAcp().then((acp) => {
            this.#chatInitFailures = 0; // reset on success
            return acp;
        }).finally(() => {
            this.#chatInitPromise = null;
        });
        return this.#chatInitPromise;
    }

    async #doInitChatAcp() {
        const config = this.#ctx.config;
        if (!config) throw new Error("Bot config not available");

        const acp = new ACPClient({
            binary: config.copilotBinary,
            cwd: config.workingDirectory,
            model: config.model,
            extraArgs: config.copilotExtraArgs,
            copilotHome: config.copilotConfigDir,
            permissionPolicy: "allow_all",
            tag: "webchat",
        });

        // Wire ACP events to SSE
        acp.on("text_chunk", (text) => {
            this.#chatSseEmit({ type: "text_chunk", text });
        });

        acp.on("thought_chunk", (text) => {
            this.#chatSseEmit({ type: "thought", text });
        });

        acp.on("message_start", () => {
            this.#chatSseEmit({ type: "message_start" });
        });

        acp.on("message_end", () => {
            this.#chatBusy = false;
            this.#chatSseEmit({ type: "done" });
        });

        acp.on("tool_start", (tool) => {
            this.#chatSseEmit({
                type: "tool_start",
                toolCallId: tool.toolCallId,
                name: tool.toolName,
                args: tool.arguments,
            });
        });

        acp.on("tool_end", (tool) => {
            this.#chatSseEmit({
                type: "tool_end",
                toolCallId: tool.toolCallId,
                status: tool.status,
            });
        });

        acp.on("plan", (entries) => {
            this.#chatSseEmit({ type: "plan", entries });
        });

        // Auto-approve all permission requests for web chat
        acp.on("permission_request", (req) => {
            log.debug("Auto-approving permission request");
            acp.respondPermission(req.requestId, "allow_always");
        });

        acp.on("exit", ({ code, signal }) => {
            log.info(`ACP exited: code=${code} signal=${signal}`);
            this.#chatBusy = false;
            this.#chatSessionId = null;
            this.#chatAcp = null;
            this.#chatSseEmit({ type: "disconnected" });
        });

        acp.on("log", (text) => {
            if (!text.includes("agent_message_chunk") && !text.includes("agent_thought_chunk")) {
                log.debug(text);
            }
        });

        // Start the ACP process — clean up on any failure
        this.#chatSseEmit({ type: "connecting" });
        try {
            await acp.start();

            const agentMemory = new AgentMemory({ agentDir: config.agentDir });
            const session = await acp.newSession({
                cwd: config.workingDirectory,
                mcpServers: config.mcpServers || [],
            });
            this.#chatSessionId = session.sessionId;
            this.#chatAcp = acp;

            // Send preamble with agent context
            const agentContext = agentMemory.buildContext();
            const preamble = [
                "You are an AI assistant connected via the Copilot Bot Web Dashboard.",
                "You have the same tools and capabilities as via Telegram.",
                "Use markdown formatting — the web UI renders it natively.",
                `You have direct HA access: curl -s http://supervisor/core/api/... -H "Authorization: Bearer $SUPERVISOR_TOKEN".`,
                agentContext ? `\n[Agent persistent memory — your identity and memory:\n${agentContext}\n]` : "",
            ].filter(Boolean).join("\n");

            this.#chatBusy = true;
            this.#chatSseEmit({ type: "status", connected: true, busy: true });
            try {
                await acp.prompt(preamble, { mode: undefined });
            } catch (err) {
                log.warn(`Preamble failed: ${err.message}`);
            }
            this.#chatBusy = false;

            this.#chatSseEmit({ type: "status", connected: true, busy: false });
            return acp;
        } catch (err) {
            // Clean up on init failure so next call retries cleanly
            log.error(`Init failed: ${err.message}`);
            try { await acp.stop(); } catch {}
            this.#chatAcp = null;
            this.#chatSessionId = null;
            this.#chatBusy = false;
            throw err;
        }
    }

    #apiChatStatus(res) {
        this.#json(res, 200, {
            connected: this.#chatAcp?.alive ?? false,
            busy: this.#chatBusy,
            sessionId: this.#chatSessionId,
        });
    }

    #apiChatStream(req, res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });

        // Send current status
        res.write(`data: ${JSON.stringify({
            type: "status",
            connected: this.#chatAcp?.alive ?? false,
            busy: this.#chatBusy,
        })}\n\n`);

        this.#chatSseClients.add(res);
        req.on("close", () => this.#chatSseClients.delete(res));

        // Auto-initialize chat ACP on first SSE connection (with backoff on repeated failures)
        if (!this.#chatAcp?.alive && !this.#chatInitPromise && this.#chatInitFailures < WebUIServer.#MAX_INIT_FAILURES) {
            this.#ensureChatAcp().catch((err) => {
                this.#chatInitFailures++;
                log.warn(`Auto-init failed (${this.#chatInitFailures}/${WebUIServer.#MAX_INIT_FAILURES}): ${err.message}`);
                if (this.#chatInitFailures >= WebUIServer.#MAX_INIT_FAILURES) {
                    log.warn("Auto-init disabled after repeated failures. Use the chat UI to manually connect.");
                }
            });
        }
    }

    async #apiChatSend(res, body) {
        const text = body?.text?.trim();
        if (!text) {
            return this.#json(res, 400, { error: "Message text is required" });
        }

        if (this.#chatBusy) {
            return this.#json(res, 409, { error: "A prompt is already in progress" });
        }

        try {
            const acp = await this.#ensureChatAcp();
            this.#chatBusy = true;
            this.#chatSseEmit({ type: "user_message", text });
            this.#json(res, 200, { sent: true });

            // Run prompt async — responses stream via SSE
            acp.prompt(text, { timeout: 0 }).catch((err) => {
                this.#chatBusy = false;
                this.#chatSseEmit({ type: "error", message: err.message });
                log.warn(`Prompt error: ${err.message}`);
            });
        } catch (err) {
            this.#chatBusy = false;
            this.#json(res, 500, { error: `Chat error: ${err.message}` });
        }
    }

    async #apiChatNew(res) {
        try {
            // If ACP is alive, create a new session
            if (this.#chatAcp?.alive) {
                if (this.#chatBusy) {
                    try { await this.#chatAcp.cancel(); } catch {}
                    this.#chatBusy = false;
                }
                const session = await this.#chatAcp.newSession({
                    cwd: this.#ctx.config?.workingDirectory || "/config",
                    mcpServers: this.#ctx.config?.mcpServers || [],
                });
                this.#chatSessionId = session.sessionId;
                this.#chatSseEmit({ type: "new_session" });
                this.#json(res, 200, { sessionId: this.#chatSessionId });
            } else {
                // Will be started on next send
                this.#chatSessionId = null;
                this.#json(res, 200, { sessionId: null });
            }
        } catch (err) {
            this.#json(res, 500, { error: `Failed to create session: ${err.message}` });
        }
    }

    async #apiChatStop(res) {
        if (!this.#chatBusy || !this.#chatAcp?.alive) {
            return this.#json(res, 200, { stopped: false });
        }
        try {
            await this.#chatAcp.cancel();
            this.#chatBusy = false;
            this.#chatSseEmit({ type: "cancelled" });
            this.#json(res, 200, { stopped: true });
        } catch (err) {
            this.#json(res, 500, { error: `Failed to stop: ${err.message}` });
        }
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

    // ── RBAC API ──────────────────────────────────────────────

    #apiRbacListRoles(res) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const roles = rbac.getAllRoles();
        const result = Object.entries(roles).map(([name, role]) => ({
            name,
            ...role,
            effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)],
        }));
        return this.#json(res, 200, result);
    }

    #apiRbacGetRole(res, name) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const role = rbac.getRoleConfig(name);
        if (!role) return this.#json(res, 404, { error: `Role not found: ${name}` });

        return this.#json(res, 200, {
            name,
            ...role,
            effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)],
        });
    }

    #apiRbacCreateRole(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            const { name, rank, inherits, capabilities, icon, description } = body || {};
            if (!name) return this.#json(res, 400, { error: "name is required" });
            if (rank === undefined) return this.#json(res, 400, { error: "rank is required" });

            rbac.createRole(name, { rank, inherits, capabilities, icon, description });
            const role = rbac.getRoleConfig(name);
            return this.#json(res, 201, {
                name,
                ...role,
                effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)],
            });
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacUpdateRole(res, name, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            rbac.updateRole(name, body || {});
            const role = rbac.getRoleConfig(name);
            return this.#json(res, 200, {
                name,
                ...role,
                effectiveCapabilities: [...rbac.getEffectiveCapabilities(name)],
            });
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacDeleteRole(res, name) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            rbac.deleteRole(name);
            return this.#json(res, 204, null);
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacListUsers(res) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const users = rbac.getPairedUsers();
        const result = users.map(u => ({
            ...u,
            effectiveCapabilities: u.role ? [...rbac.getEffectiveCapabilities(u.role)] : [],
        }));
        return this.#json(res, 200, result);
    }

    #apiRbacGetUser(res, userId) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const user = rbac.getUser(Number(userId));
        if (!user) return this.#json(res, 404, { error: `User not found: ${userId}` });

        return this.#json(res, 200, {
            ...user,
            effectiveCapabilities: user.role ? [...rbac.getEffectiveCapabilities(user.role)] : [],
        });
    }

    #apiRbacSetUserRole(res, userId, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            const { role, expiresAt, displayName, actorId } = body || {};
            if (!role) return this.#json(res, 400, { error: "role is required" });

            // Block owner role assignment via API — must be done via config
            if (role === "owner") {
                return this.#json(res, 403, { error: "Cannot assign owner role via API. Use allowed_chat_ids config." });
            }

            // If actorId provided, enforce delegation boundaries
            if (actorId && !rbac.canGrantRole(Number(actorId), role)) {
                return this.#json(res, 403, { error: `Insufficient rank to assign role: ${role}` });
            }

            rbac.setUserRole(Number(userId), role, { expiresAt, displayName });
            const user = rbac.getUser(Number(userId));
            return this.#json(res, 200, {
                ...user,
                effectiveCapabilities: [...rbac.getEffectiveCapabilities(user.role)],
            });
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacRevokeUser(res, userId) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const revoked = rbac.revoke(Number(userId));
        if (!revoked) return this.#json(res, 400, { error: "Cannot revoke this user (may be a pre-approved admin)" });
        return this.#json(res, 204, null);
    }

    #apiRbacCheckPermission(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const { userId, capability, entityId, toolName, toolArgs } = body || {};
        if (!userId) return this.#json(res, 400, { error: "userId is required" });

        if (toolName) {
            const result = rbac.checkToolPermission(Number(userId), toolName, toolArgs || {});
            return this.#json(res, 200, result);
        }
        if (capability) {
            const result = rbac.canPerform(Number(userId), capability, entityId || null);
            return this.#json(res, 200, result);
        }
        return this.#json(res, 400, { error: "Either capability or toolName is required" });
    }

    #apiRbacCreateInvite(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            const { role, expiresAt, roleExpiresAt, createdBy } = body || {};
            if (!role) return this.#json(res, 400, { error: "role is required" });

            const token = rbac.createInvite(role, { createdBy, expiresAt, roleExpiresAt });
            return this.#json(res, 201, { token, role, expiresAt, roleExpiresAt });
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacListInvites(res, params) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const status = params.status || undefined;
        return this.#json(res, 200, rbac.listInvites({ status }));
    }

    #apiRbacRevokeInvite(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const { token, id, revokedBy } = body || {};
        const tokenOrPrefix = token || id;
        if (!tokenOrPrefix) return this.#json(res, 400, { error: "token or id is required" });

        try {
            const revoked = rbac.revokeInvite(tokenOrPrefix, { revokedBy });
            if (!revoked) return this.#json(res, 404, { error: "Invite not found" });
            return this.#json(res, 204, null);
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacListOverrides(res, params) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const filters = {};
        if (params.entity_id) filters.entity_id = params.entity_id;
        if (params.target_type) filters.target_type = params.target_type;
        if (params.target_id) filters.target_id = params.target_id;
        return this.#json(res, 200, rbac.getOverrides(filters));
    }

    #apiRbacSetOverride(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        try {
            const { entity_id, target_type, target_id, grants, denies } = body || {};
            if (!entity_id) return this.#json(res, 400, { error: "entity_id is required" });
            if (!target_type) return this.#json(res, 400, { error: "target_type is required" });
            if (!target_id) return this.#json(res, 400, { error: "target_id is required" });

            rbac.addOverride({ entity_id, target_type, target_id, grants, denies });
            return this.#json(res, 201, { entity_id, target_type, target_id, grants, denies });
        } catch (err) {
            return this.#json(res, 400, { error: err.message });
        }
    }

    #apiRbacDeleteOverride(res, body) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const { entity_id, target_type, target_id } = body || {};
        if (!entity_id || !target_type || !target_id) {
            return this.#json(res, 400, { error: "entity_id, target_type, and target_id are required" });
        }
        const removed = rbac.removeOverride(entity_id, target_type, target_id);
        if (!removed) return this.#json(res, 404, { error: "Override not found" });
        return this.#json(res, 204, null);
    }

    #apiRbacGetAudit(res, params) {
        const rbac = this.#ctx.pairing;
        if (!rbac) return this.#json(res, 503, { error: "RBAC not available" });

        const limit = Math.min(parseInt(params.limit) || 50, 200);
        const offset = parseInt(params.offset) || 0;
        const result = rbac.getAuditLog({
            limit,
            offset,
            event: params.event || undefined,
            actor: params.actor || undefined,
            target: params.target || undefined,
        });
        return this.#json(res, 200, result);
    }

    async #readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
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
