#!/usr/bin/env node
// Minimal MCP server for Telegram UX — raw JSON-RPC over stdio (NDJSON framing).
// Exposes one tool: ask_user(message, options?) that routes to the bot via UDS.
// No npm dependencies.

import { createConnection } from "net";

const SOCKET_PATH = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
const SCOPE_KEY = process.env.TG_UX_SCOPE_KEY || null;

function log(msg) { process.stderr.write(`[tg-mcp] ${msg}\n`); }

const TOOL = {
    name: "ask_user",
    description:
        "Ask the Telegram user a question and wait for their answer. " +
        "For multiple-choice, provide an options array and each becomes an inline button. " +
        "Without options the user types a free-text reply. Returns the user's answer.",
    inputSchema: {
        type: "object",
        properties: {
            message: { type: "string", description: "The question to ask" },
            options: {
                type: "array",
                description: "Optional choices — each becomes an inline button",
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string" },
                        value: { type: "string" },
                    },
                    required: ["label", "value"],
                },
            },
        },
        required: ["message"],
    },
};

// --- JSON-RPC helpers ---

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// --- UDS call to bot ---

function callBot(params) {
    return new Promise((resolve, reject) => {
        log(`UDS connect → ${SOCKET_PATH} (scope=${SCOPE_KEY || "none"})`);
        const conn = createConnection(SOCKET_PATH, () => {
            const payload = JSON.stringify(params) + "\n";
            log(`UDS send: ${payload.length} bytes`);
            conn.write(payload);
        });
        const chunks = [];
        // 30-minute timeout — user may take time to respond, especially if queued
        const timer = setTimeout(() => {
            log("UDS timeout (30min)");
            conn.destroy();
            reject(new Error("Timed out waiting for user response"));
        }, 30 * 60 * 1000);
        conn.on("data", (c) => chunks.push(c));
        conn.on("end", () => {
            clearTimeout(timer);
            try {
                const result = JSON.parse(Buffer.concat(chunks).toString());
                log(`UDS response: ${result.error ? "error: " + result.error : "ok"}`);
                resolve(result);
            } catch (e) {
                log(`UDS parse error: ${e.message}`);
                reject(new Error("Invalid response from bot"));
            }
        });
        conn.on("error", (err) => {
            clearTimeout(timer);
            log(`UDS error: ${err.message}`);
            reject(err);
        });
    });
}

// --- Request handlers ---

let clientProtocolVersion = "2025-11-25";

function handleInitialize(id, params) {
    if (params?.protocolVersion) clientProtocolVersion = params.protocolVersion;
    send(id, {
        protocolVersion: clientProtocolVersion,
        serverInfo: { name: "tg-ux", version: "1.0.0" },
        capabilities: { tools: {} },
    });
}

function handleToolsList(id) {
    send(id, { tools: [TOOL] });
}

async function handleToolsCall(id, params) {
    if (!params || typeof params !== "object") {
        sendError(id, -32602, "Invalid params");
        return;
    }
    const { name, arguments: args } = params;
    if (name !== "ask_user") {
        sendError(id, -32602, `Unknown tool: ${name}`);
        return;
    }
    if (!args?.message || typeof args.message !== "string") {
        send(id, {
            content: [{ type: "text", text: "Error: message parameter is required" }],
            isError: true,
        });
        return;
    }
    log(`ask_user called: "${args.message.substring(0, 80)}"`);
    pendingCalls++;
    try {
        const result = await callBot({ method: "ask_user", params: args, scopeKey: SCOPE_KEY });
        if (result.error) {
            send(id, {
                content: [{ type: "text", text: result.error }],
                isError: true,
            });
        } else {
            send(id, {
                content: [{ type: "text", text: result.answer ?? "" }],
            });
        }
    } catch (err) {
        send(id, {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
        });
    } finally {
        pendingCalls--;
        checkExit();
    }
}

// --- Stdio NDJSON framing ---

function handleMessage(msg) {
    // Notifications (no id) — ignore (e.g. notifications/initialized)
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
const MAX_BUF = 1024 * 1024; // 1MB safety limit

let pendingCalls = 0;
let stdinEnded = false;

function checkExit() {
    if (stdinEnded && pendingCalls === 0) process.exit(0);
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
    lineBuf += chunk;
    if (lineBuf.length > MAX_BUF) {
        process.stderr.write("tg-ux: line buffer exceeded 1MB, resetting\n");
        lineBuf = "";
        return;
    }
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // keep incomplete trailing line
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            handleMessage(JSON.parse(line));
        } catch {
            // skip malformed lines
        }
    }
});
process.stdin.on("end", () => {
    stdinEnded = true;
    checkExit();
});
process.stdin.on("error", () => process.exit(1));
process.stdout.on("error", () => process.exit(1));
