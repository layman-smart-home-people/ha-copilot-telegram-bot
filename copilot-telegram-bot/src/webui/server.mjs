// ============================================================
// Web UI Server — Ingress-based dashboard for the Copilot Bot
// ============================================================
// Lightweight HTTP server using Node built-in http module.
// Serves REST API + static frontend. Auth handled by HA Ingress.

import http from "node:http";
import { readFileSync, readdirSync, statSync, readFile, writeFile } from "node:fs";
import { join, extname, resolve, basename, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const STATIC_DIR = new URL("./public/", import.meta.url).pathname;

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
