#!/usr/bin/env node
// Minimal MCP server for Telegram UX — raw JSON-RPC over stdio (NDJSON framing).
// Exposes ask_user and background_task tools that route to the bot via UDS.
// No npm dependencies.

import { createConnection } from "net";

const SOCKET_PATH = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
const SCOPE_KEY = process.env.TG_UX_SCOPE_KEY || null;

function log(msg) { process.stderr.write(`[telegram-mcp] ${msg}\n`); }

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

const BACKGROUND_TASK_TOOL = {
    name: "background_task",
    description:
        "Dispatch a task to run in the background on a separate agent. " +
        "Returns immediately with a task ID. Results are delivered to the user via Telegram when complete. " +
        "Use for fire-and-forget work that doesn't need to be in your response. " +
        "Provide ALL necessary context in the prompt — the background agent has no access to your conversation history. " +
        "For multi-task research: use group_id + group_size to aggregate results. " +
        "When all tasks in a group complete, their results are synthesized into a unified report.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: "Complete, self-contained task description with all context needed",
            },
            description: {
                type: "string",
                description: "Short description for status tracking (e.g., 'Check sensor trends')",
            },
            group_id: {
                type: "string",
                description: "Optional group ID for multi-task aggregation. Tasks with the same group_id are collected and synthesized when all complete.",
            },
            group_size: {
                type: "integer",
                description: "Total number of tasks in this group. Required when group_id is provided. Aggregation triggers when this many tasks complete.",
            },
        },
        required: ["prompt", "description"],
    },
};

const NOTIFY_TOOL = {
    name: "notify_user",
    description:
        "Send a one-way notification to the user via Telegram. " +
        "Does NOT wait for a reply — returns immediately. " +
        "Use this in autonomous/silent mode when you find something the user should know about. " +
        "Keep messages concise and actionable.",
    inputSchema: {
        type: "object",
        properties: {
            message: { type: "string", description: "The notification message to send" },
        },
        required: ["message"],
    },
};

const TELEGRAM_CALL_TOOL = {
    name: "telegram_call",
    description:
        "Call any Telegram Bot API method through the bot. " +
        "Use for forum topic management (editForumTopic, createForumTopic, closeForumTopic, deleteForumTopic, getForumTopicIconStickers), " +
        "sending messages (sendMessage), editing messages (editMessageText), and other Bot API methods. " +
        "Returns the API response. Example: method='editForumTopic', params={chat_id: 123, message_thread_id: 456, name: 'New Name'}.",
    inputSchema: {
        type: "object",
        properties: {
            method: {
                type: "string",
                description: "Telegram Bot API method name (e.g. 'editForumTopic', 'sendMessage', 'getForumTopicIconStickers')",
            },
            params: {
                type: "object",
                description: "Parameters for the API method (e.g. {chat_id: 123, message_thread_id: 456, name: 'New Name'})",
            },
        },
        required: ["method"],
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
        serverInfo: { name: "telegram", version: "2.0.0" },
        capabilities: { tools: {} },
    });
}

function handleToolsList(id) {
    send(id, { tools: [TOOL, BACKGROUND_TASK_TOOL, NOTIFY_TOOL, TELEGRAM_CALL_TOOL] });
}

async function handleToolsCall(id, params) {
    if (!params || typeof params !== "object") {
        sendError(id, -32602, "Invalid params");
        return;
    }
    const { name, arguments: args } = params;

    if (name === "ask_user") {
        return handleAskUser(id, args);
    } else if (name === "background_task") {
        return handleBackgroundTask(id, args);
    } else if (name === "notify_user") {
        return handleNotifyUser(id, args);
    } else if (name === "telegram_call") {
        return handleTelegramCall(id, args);
    } else {
        sendError(id, -32602, `Unknown tool: ${name}`);
    }
}

async function handleAskUser(id, args) {
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

async function handleBackgroundTask(id, args) {
    if (!args?.prompt || typeof args.prompt !== "string") {
        send(id, {
            content: [{ type: "text", text: "Error: prompt parameter is required" }],
            isError: true,
        });
        return;
    }
    if (!args?.description || typeof args.description !== "string") {
        send(id, {
            content: [{ type: "text", text: "Error: description parameter is required" }],
            isError: true,
        });
        return;
    }
    if (args.group_id && (!args.group_size || typeof args.group_size !== "number" || args.group_size < 1)) {
        send(id, {
            content: [{ type: "text", text: "Error: group_size (positive integer) is required when group_id is provided" }],
            isError: true,
        });
        return;
    }
    log(`background_task called: "${args.description}"${args.group_id ? ` [group=${args.group_id}, size=${args.group_size}]` : ""}`);
    pendingCalls++;
    try {
        const params = { prompt: args.prompt, description: args.description };
        if (args.group_id) {
            params.groupId = args.group_id;
            params.groupSize = args.group_size;
        }
        const result = await callBot({
            method: "background_task",
            params,
            scopeKey: SCOPE_KEY,
        });
        if (result.error) {
            send(id, {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true,
            });
        } else {
            const groupInfo = result.groupId ? `\nGroup: ${result.groupId} (${result.groupSize} tasks)` : "";
            send(id, {
                content: [{ type: "text", text: `Task dispatched: ${result.taskId}\nStatus: ${result.status}${groupInfo}\nResults will be delivered via Telegram when complete.` }],
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

async function handleNotifyUser(id, args) {
    if (!args?.message || typeof args.message !== "string" || !args.message.trim()) {
        send(id, {
            content: [{ type: "text", text: "Error: message parameter is required (non-empty string)" }],
            isError: true,
        });
        return;
    }
    log(`notify_user called: "${args.message.substring(0, 80)}"`);
    pendingCalls++;
    try {
        const result = await callBot({ method: "notify_user", params: { message: args.message }, scopeKey: SCOPE_KEY });
        if (result.error) {
            send(id, {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true,
            });
        } else {
            send(id, {
                content: [{ type: "text", text: "Notification sent" }],
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

async function handleTelegramCall(id, args) {
    if (!args?.method || typeof args.method !== "string") {
        send(id, {
            content: [{ type: "text", text: "Error: method parameter is required (Telegram Bot API method name)" }],
            isError: true,
        });
        return;
    }
    log(`telegram_call: ${args.method}(${JSON.stringify(args.params || {}).substring(0, 120)})`);
    pendingCalls++;
    try {
        const result = await callBot({
            method: "telegram_call",
            params: { method: args.method, params: args.params || {} },
            scopeKey: SCOPE_KEY,
        });
        if (result.error) {
            send(id, {
                content: [{ type: "text", text: `Telegram API error: ${result.error}` }],
                isError: true,
            });
        } else {
            send(id, {
                content: [{ type: "text", text: JSON.stringify(result.data ?? result, null, 2) }],
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
        process.stderr.write("telegram-mcp: line buffer exceeded 1MB, resetting\n");
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
