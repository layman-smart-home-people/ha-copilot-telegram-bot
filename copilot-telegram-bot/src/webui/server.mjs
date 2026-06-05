// ============================================================
// Web UI Server — Ingress-based dashboard for the Copilot Bot
// ============================================================
// Lightweight HTTP server using Node built-in http module.
// Serves REST API + static frontend. Auth handled by HA Ingress.

import http from "node:http";
import { readFileSync, readdirSync, statSync, readFile, writeFile } from "node:fs";
import { join, extname, resolve, basename, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const STATIC_DIR = new URL("./dist/", import.meta.url).pathname;

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
    #log;
    #ctx = {}; // references to bot internals
    #logBuffer = [];       // circular buffer for recent log lines
    #logMaxLines = 500;
    #sseClients = new Set(); // SSE connections for live log streaming
    #addonSlug = null;     // resolved lazily

    constructor({ port = 8099, log = console.log } = {}) {
        this.#port = port;
        this.#log = typeof log === "function" ? log : console.log;
    }

    /**
     * Attach bot internals so API routes can access them.
     * Call this before start().
     */
    attach({ bridge, orchestrator, scopeMgr, config, acp, telegram, startedAt }) {
        this.#ctx = { bridge, orchestrator, scopeMgr, config, acp, telegram, startedAt };
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
            this.#log(`[WEBUI] Server listening on port ${this.#port}`);
        });
    }

    async stop() {
        if (this.#server) {
            return new Promise((resolve) => {
                this.#server.close(() => {
                    this.#log("[WEBUI] Server stopped");
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
            this.#log(`[WEBUI] Request error: ${err.message}`);
            this.#json(res, 500, { error: "Internal server error" });
        }
    }

    async #handleApi(req, res, pathname, params) {
        const method = req.method;

        // GET /api/status — bot status overview
        if (pathname === "/api/status" && method === "GET") {
            return this.#apiStatus(res);
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
        if (!filePath.startsWith(resolve(agentDir))) {
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
        if (!filePath.startsWith(resolve(agentDir))) {
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
