// ============================================================
// ACP Client — Agent Client Protocol over stdio (NDJSON)
// ============================================================
// Spawns `copilot --acp --stdio` and communicates via JSON-RPC 2.0.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class ACPClient extends EventEmitter {
    #process = null;
    #buffer = "";
    #nextId = 1;
    #pending = new Map(); // id → { resolve, reject, timeout }
    #sessionId = null;
    #initialized = false;
    #dead = false;
    #config;
    #authMethods = [];

    constructor(config) {
        super();
        this.#config = config;
    }

    get sessionId() { return this.#sessionId; }
    get alive() { return this.#process && !this.#dead; }
    get authMethods() { return this.#authMethods; }

    // --- Lifecycle ---

    async start() {
        if (this.alive) return;
        this.#dead = false;
        this.#buffer = "";
        this.#pending.clear();
        this.#sessionId = null;
        this.#initialized = false;

        const args = ["--acp", "--stdio"];
        // Permission strategy:
        // - allow_all config: pass --allow-all (CLI auto-approves everything)
        // - interactive config: NO --allow-all-tools flag, so the CLI sends
        //   session/request_permission for each tool call and we handle it
        //   via inline buttons in the bridge permission_request handler
        if (this.#config.permissionPolicy === "allow_all") {
            args.push("--allow-all");
        }
        // interactive mode: don't pass --allow-all-tools so CLI sends permission requests
        if (this.#config.model) args.push("--model", this.#config.model);
        if (this.#config.extraArgs) {
            const extra = this.#config.extraArgs.trim().split(/\s+/);
            args.push(...extra);
        }

        // Wrap spawn in a promise so ENOENT is caught properly
        const copilotHome = this.#config.copilotHome || process.env.COPILOT_HOME || "";
        const spawnEnv = {
            ...process.env,
            HOME: process.env.HOME || "/root",
            PATH: `${this.#config.binary.replace(/\/[^/]+$/, "")}:${process.env.PATH}`,
        };
        // Set COPILOT_HOME to bypass symlink resolution issues in containers
        if (copilotHome) {
            spawnEnv.COPILOT_HOME = copilotHome;
        }
        this.emit("log", `ACP spawn: COPILOT_HOME=${spawnEnv.COPILOT_HOME || "unset"} args=[${args.join(" ")}]`);
        await new Promise((resolve, reject) => {
            this.#process = spawn(this.#config.binary, args, {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: this.#config.cwd || "/config",
                env: spawnEnv,
            });

            // Suppress EPIPE errors on stdin (process may die before we write)
            this.#process.stdin.on("error", () => {});

            this.#process.stdout.on("data", (chunk) => this.#onData(chunk));
            this.#process.stderr.on("data", (chunk) => {
                const text = chunk.toString().trim();
                if (text) this.emit("log", text);
            });

            this.#process.on("exit", (code, signal) => {
                this.#dead = true;
                this.#rejectAll(new Error(`Copilot process exited: code=${code} signal=${signal}`));
                this.emit("exit", { code, signal });
            });

            this.#process.on("error", (err) => {
                this.#dead = true;
                this.#rejectAll(err);
                reject(err);
            });

            // If spawn succeeds, the process will have a pid
            this.#process.on("spawn", () => resolve());
        });

        // Initialize ACP
        const initResult = await this.#send("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
        });
        this.#initialized = true;
        this.#authMethods = initResult.authMethods || [];
        this.emit("initialized", initResult);
        return initResult;
    }

    // --- Authentication ---

    async authenticate(methodId) {
        if (!methodId && this.#authMethods.length > 0) {
            methodId = this.#authMethods[0].id;
        }
        if (!methodId) {
            throw new Error("No auth method available");
        }
        return this.#send("authenticate", { methodId }, 15000);
    }

    async stop() {
        if (!this.#process) return;
        this.#dead = true;
        this.#rejectAll(new Error("ACP client stopped"));

        try {
            this.#process.stdin.end();
            this.#process.kill("SIGTERM");
        } catch {}

        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try { this.#process?.kill("SIGKILL"); } catch {}
                resolve();
            }, 5000);
            this.#process.once("exit", () => { clearTimeout(timer); resolve(); });
        });

        this.#process = null;
        this.#sessionId = null;
    }

    // --- Session management ---

    async newSession(opts = {}) {
        const params = {
            cwd: opts.cwd || this.#config.cwd || "/config",
            mcpServers: [],
        };
        // Only include HTTP/SSE MCP servers (session/new doesn't accept stdio format)
        if (opts.mcpServers?.length) {
            const httpServers = opts.mcpServers.filter(s => s.url);
            if (httpServers.length) params.mcpServers = httpServers;
        }
        const result = await this.#send("session/new", params, 60000);
        this.#sessionId = result.sessionId;
        this.emit("session", result);
        return result;
    }

    async loadSession(sessionId) {
        const result = await this.#send("session/load", { sessionId });
        this.#sessionId = result.sessionId || sessionId;
        return result;
    }

    // --- Prompting ---

    async prompt(text, opts = {}) {
        if (!this.#sessionId) throw new Error("No active ACP session");
        const promptContent = [];

        if (typeof text === "string") {
            promptContent.push({ type: "text", text });
        } else if (Array.isArray(text)) {
            promptContent.push(...text);
        }

        // Add image attachments if provided
        if (opts.images) {
            for (const img of opts.images) {
                promptContent.push({
                    type: "image",
                    data: img.data,
                    mimeType: img.mimeType,
                });
            }
        }

        const params = {
            sessionId: this.#sessionId,
            prompt: promptContent,
        };
        if (opts.mode) params.mode = opts.mode;

        return this.#send("session/prompt", params, opts.timeout || 300000);
    }

    // --- RPC commands ---
    // Note: ACP exposes commands (model, autopilot, compact, usage) rather than
    // typed RPC methods. We use session/set_config_option where available and
    // fall back to sending commands as prompts.

    async setMode(mode) {
        try {
            return await this.#send("session/set_config_option", {
                sessionId: this.#sessionId, optionId: "mode", value: mode,
            }, 10000);
        } catch {
            // Fallback: send as a slash command via prompt
            return this.prompt(`/autopilot ${mode === "autopilot" ? "on" : "off"}`);
        }
    }

    async setModel(modelId) {
        try {
            return await this.#send("session/set_config_option", {
                sessionId: this.#sessionId, optionId: "model", value: modelId,
            }, 10000);
        } catch {
            return this.prompt(`/model ${modelId}`);
        }
    }

    async compact() {
        return this.prompt("/compact");
    }

    async getUsage() {
        // Usage is typically delivered via config_option_update notifications
        // There's no dedicated RPC; send /usage and let the response come through
        return this.prompt("/usage");
    }

    async cancel() {
        try {
            return await this.#send("session/cancel", { sessionId: this.#sessionId }, 10000);
        } catch {
            // If cancel RPC doesn't exist, there's nothing we can do
            return null;
        }
    }

    async listSessions() {
        try {
            return await this.#send("session/list", {}, 10000);
        } catch {
            return [];
        }
    }

    /**
     * Respond to a session/request_permission server request.
     * @param {number} requestId - The JSON-RPC id from the server request
     * @param {string} optionId - e.g. "allow_once", "allow_always", "reject_once"
     * @param {boolean} cancelled - if true, send cancelled outcome
     */
    respondPermission(requestId, optionId, cancelled = false) {
        // ACP spec: result.outcome = { outcome: "selected"|"cancelled", optionId? }
        const outcome = cancelled
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId };
        const response = {
            jsonrpc: "2.0",
            id: requestId,
            result: { outcome },
        };
        const payload = JSON.stringify(response) + "\n";
        this.emit("log", `Permission response: ${JSON.stringify(response)}`);
        try {
            const ok = this.#process.stdin.write(payload, (err) => {
                if (err) {
                    this.emit("log", `Permission stdin write error: ${err.message}`);
                } else {
                    this.emit("log", `Permission response flushed to ACP stdin (id=${requestId})`);
                }
            });
            if (!ok) {
                this.emit("log", `Permission stdin backpressure — waiting for drain`);
                this.#process.stdin.once("drain", () => {
                    this.emit("log", `Permission stdin drained`);
                });
            }
        } catch (err) {
            this.emit("log", `Failed to respond permission ${requestId}: ${err.message}`);
        }
    }

    // --- Internal ---

    #send(method, params, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (this.#dead || !this.#process) {
                return reject(new Error("ACP process not running"));
            }
            const id = this.#nextId++;
            const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

            const timeout = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`ACP request timeout: ${method} (${timeoutMs}ms)`));
            }, timeoutMs);

            this.#pending.set(id, { resolve, reject, timeout });

            if (!this.#process.stdin.writable) {
                this.#pending.delete(id);
                clearTimeout(timeout);
                reject(new Error("ACP stdin not writable"));
                return;
            }

            this.#process.stdin.write(msg, (err) => {
                if (err) {
                    this.#pending.delete(id);
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    #onData(chunk) {
        this.#buffer += chunk.toString();
        const lines = this.#buffer.split("\n");
        this.#buffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                this.emit("log", `ACP parse error: ${line.substring(0, 200)}`);
                continue;
            }
            this.#handleMessage(msg);
        }
    }

    #handleMessage(msg) {
        // Log incoming ACP messages (summary only for frequent types)
        const methodOrType = msg.method || (msg.result !== undefined ? "response" : "unknown");
        const sessionUpdate = msg.params?.update?.sessionUpdate || "";
        const brief = sessionUpdate ? `${methodOrType}/${sessionUpdate}` : methodOrType;
        // Only log full JSON for non-frequent messages (skip chunks, agent_thought)
        const isFrequent = sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk";
        if (!isFrequent) {
            this.emit("log", `ACP ← ${brief} id=${msg.id ?? "-"}`);
        }

        // JSON-RPC 2.0 message routing:
        // - Request/notification: has "method"
        // - Response: has "result" or "error", no "method"
        // Check method FIRST to prevent server request IDs from colliding
        // with our pending client request IDs.

        if (msg.method) {
            if (msg.id != null) {
                // Server-to-client request (e.g., session/request_permission)
                this.#handleServerRequest(msg);
            } else {
                // Notification (no id)
                this.#handleNotification(msg);
            }
            return;
        }

        // Response to one of our requests
        if (msg.id != null && this.#pending.has(msg.id)) {
            const { resolve, reject, timeout } = this.#pending.get(msg.id);
            this.#pending.delete(msg.id);
            clearTimeout(timeout);

            if (msg.error) {
                this.emit("log", `ACP error id=${msg.id}: ${msg.error.code} ${msg.error.message}`);
                reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
            } else {
                resolve(msg.result);
            }
            return;
        }

        // Unmatched response (stale or unknown id)
        if (msg.id != null) {
            this.emit("log", `ACP unmatched response id=${msg.id}: ${JSON.stringify(msg).substring(0, 200)}`);
        }
    }

    #handleServerRequest(msg) {
        switch (msg.method) {
            case "requestPermission":
            case "session/request_permission": {
                // Emit for bridge to handle (may ask user or auto-approve)
                this.emit("log", `Permission request: ${JSON.stringify(msg.params)}`);
                this.emit("permission_request", {
                    requestId: msg.id,
                    ...msg.params,
                });
                break;
            }
            case "sessionUpdate": {
                // Some ACP servers send sessionUpdate as a request expecting a response
                const response = { jsonrpc: "2.0", id: msg.id, result: {} };
                try {
                    this.#process.stdin.write(JSON.stringify(response) + "\n");
                } catch {}
                this.#handleNotification(msg);
                break;
            }
            default: {
                // Unknown server request — respond with empty result
                const response = { jsonrpc: "2.0", id: msg.id, result: {} };
                try {
                    this.#process.stdin.write(JSON.stringify(response) + "\n");
                } catch {}
                this.emit("log", `Unknown ACP server request: ${msg.method}`);
            }
        }
    }

    #handleNotification(msg) {
        if (msg.method === "session/update") {
            const update = msg.params?.update;
            if (!update) return;

            switch (update.sessionUpdate) {
                case "agent_message_chunk":
                    if (update.content?.type === "text") {
                        this.emit("text_chunk", update.content.text);
                    }
                    break;
                case "agent_message_start":
                    this.emit("message_start", update);
                    break;
                case "agent_message_end":
                    this.emit("message_end", update);
                    break;
                case "tool_call":
                    // ACP sends tool_call with status "pending" when a tool is invoked
                    this.emit("tool_start", {
                        toolCallId: update.toolCallId,
                        toolName: update.title || "unknown",
                        arguments: update.rawInput,
                        kind: update.kind,
                        status: update.status,
                    });
                    break;
                case "tool_call_update":
                    // ACP sends tool_call_update with status changes
                    this.emit("tool_update", {
                        toolCallId: update.toolCallId,
                        status: update.status,
                        content: update.content,
                        rawOutput: update.rawOutput,
                    });
                    // Emit tool_end when the tool reaches a terminal state
                    if (update.status === "completed" || update.status === "failed") {
                        this.emit("tool_end", {
                            toolCallId: update.toolCallId,
                            status: update.status,
                            result: update.rawOutput || update.content,
                        });
                    }
                    break;
                case "available_commands_update":
                    this.emit("commands", update.availableCommands);
                    break;
                case "config_option_update":
                    this.emit("config_options", update.configOptions);
                    break;
                case "agent_thought_chunk":
                    if (update.content?.type === "text") {
                        this.emit("thought_chunk", update.content.text);
                    }
                    break;
                default:
                    this.emit("update", update);
                    this.emit("log", `Unknown session update: ${update.sessionUpdate}`);
            }
        } else {
            this.emit("notification", msg);
        }
    }

    #rejectAll(err) {
        for (const [id, { reject, timeout }] of this.#pending) {
            clearTimeout(timeout);
            reject(err);
        }
        this.#pending.clear();
    }

    // --- Respond to server (for interactive flows) ---

    respondToRequest(requestId, result) {
        if (this.#dead || !this.#process) return;
        const response = { jsonrpc: "2.0", id: requestId, result };
        try {
            this.#process.stdin.write(JSON.stringify(response) + "\n");
        } catch {}
    }
}
