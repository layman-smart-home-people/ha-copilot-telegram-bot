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

    constructor(config) {
        super();
        this.#config = config;
    }

    get sessionId() { return this.#sessionId; }
    get alive() { return this.#process && !this.#dead; }

    // --- Lifecycle ---

    async start() {
        if (this.alive) return;
        this.#dead = false;
        this.#buffer = "";
        this.#pending.clear();
        this.#sessionId = null;
        this.#initialized = false;

        const args = ["--acp", "--stdio", "--allow-all"];
        if (this.#config.model) args.push("--model", this.#config.model);
        if (this.#config.extraArgs) {
            const extra = this.#config.extraArgs.trim().split(/\s+/);
            args.push(...extra);
        }

        // Wrap spawn in a promise so ENOENT is caught properly
        await new Promise((resolve, reject) => {
            this.#process = spawn(this.#config.binary, args, {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: this.#config.cwd || "/config",
                env: {
                    ...process.env,
                    HOME: process.env.HOME || "/root",
                    PATH: `${this.#config.binary.replace(/\/[^/]+$/, "")}:${process.env.PATH}`,
                },
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
        this.emit("initialized", initResult);
        return initResult;
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
            mcpServers: opts.mcpServers || [],
        };
        const result = await this.#send("session/new", params);
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
        // Response to a request
        if (msg.id != null && this.#pending.has(msg.id)) {
            const { resolve, reject, timeout } = this.#pending.get(msg.id);
            this.#pending.delete(msg.id);
            clearTimeout(timeout);

            if (msg.error) {
                reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
            } else {
                resolve(msg.result);
            }
            return;
        }

        // Server-to-client request (e.g., requestPermission)
        if (msg.method && msg.id != null) {
            this.#handleServerRequest(msg);
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.#handleNotification(msg);
            return;
        }
    }

    #handleServerRequest(msg) {
        switch (msg.method) {
            case "requestPermission": {
                // Auto-approve all permissions (we started with --allow-all too)
                const response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { outcome: { outcome: "approved" } },
                };
                this.emit("permission", msg.params);
                try {
                    this.#process.stdin.write(JSON.stringify(response) + "\n");
                } catch {}
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
                case "tool_call_start":
                    this.emit("tool_start", {
                        toolCallId: update.toolCallId,
                        toolName: update.toolName,
                        arguments: update.arguments,
                    });
                    break;
                case "tool_call_end":
                    this.emit("tool_end", {
                        toolCallId: update.toolCallId,
                        result: update.result,
                    });
                    break;
                case "available_commands_update":
                    this.emit("commands", update.availableCommands);
                    break;
                case "config_option_update":
                    this.emit("config_options", update.configOptions);
                    break;
                default:
                    this.emit("update", update);
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
