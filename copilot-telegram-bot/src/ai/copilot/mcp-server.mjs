#!/usr/bin/env node
// Minimal MCP server for Telegram UX — raw JSON-RPC over stdio (NDJSON framing).
// Exposes ask_user and background_task tools that route to the bot via UDS.
// No npm dependencies.

import { createConnection } from "net";
import { readFileSync } from "fs";
import { join } from "path";

const SOCKET_PATH = process.env.TG_UX_SOCK || "/run/tg-ux.sock";
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

const SEND_FILE_TOOL = {
    name: "send_file",
    description:
        "Send a file to the user via Telegram. " +
        "Accepts a local file path and sends it as a document or photo attachment. " +
        "Images (jpg, png, gif, webp) are sent as photos by default — set type='document' to force document mode. " +
        "Use for sharing reports, exports, images, or any generated files directly in chat instead of sharing URLs.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: {
                type: "string",
                description: "Absolute path to the file on disk (e.g. '/config/www/report.html')",
            },
            caption: {
                type: "string",
                description: "Optional caption to send with the file (max 1024 chars)",
            },
            type: {
                type: "string",
                enum: ["auto", "document", "photo"],
                description: "Send mode: 'auto' (default) picks photo for images, document for everything else. 'document' forces document mode. 'photo' forces photo mode.",
            },
        },
        required: ["file_path"],
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

const SEND_TO_USER_TOOL = {
    name: "send_to_user",
    description:
        "Send a message to another user or group by name, @username, or chat ID. " +
        "Resolves the target via RBAC (paired users) or allowed groups. " +
        "Use when the current user asks you to send something to a different person or group chat. " +
        "This is a private bot — all paired users and allowed groups are valid targets.",
    inputSchema: {
        type: "object",
        properties: {
            target: {
                type: "string",
                description: "Who to send to: display name, @username, or numeric chat/user ID",
            },
            message: {
                type: "string",
                description: "The message to send (plain text)",
            },
        },
        required: ["target", "message"],
    },
};

// --- JSON-RPC helpers ---

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// --- UDS call to bot (with retry) ---

function connectUDS() {
    return new Promise((resolve, reject) => {
        const conn = createConnection(SOCKET_PATH, () => resolve(conn));
        conn.on("error", reject);
    });
}

async function callBot(params) {
    const maxRetries = 4;
    const delays = [500, 1000, 2000, 4000]; // ms backoff

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const conn = await connectUDS();
            // Remove the one-shot error listener from connect phase
            conn.removeAllListeners("error");

            return await new Promise((resolve, reject) => {
                const payload = JSON.stringify(params) + "\n";
                if (attempt > 0) log(`UDS retry ${attempt}: sending ${payload.length} bytes`);
                else log(`UDS send: ${payload.length} bytes`);
                conn.write(payload);

                const chunks = [];
                // Timeout slightly above UDS server's 5min to let server-side timeout resolve first
                const timer = setTimeout(() => {
                    log("UDS timeout (5.5min)");
                    conn.destroy();
                    reject(new Error("Timed out waiting for user response"));
                }, 5.5 * 60 * 1000);

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
                    log(`UDS stream error: ${err.message}`);
                    reject(err);
                });
            });
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) {
                log(`UDS connect failed (${err.code}), retry in ${delays[attempt]}ms...`);
                await new Promise(r => setTimeout(r, delays[attempt]));
            } else {
                throw err;
            }
        }
    }
    throw lastErr;
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
    send(id, { tools: [TOOL, BACKGROUND_TASK_TOOL, NOTIFY_TOOL, SEND_FILE_TOOL, TELEGRAM_CALL_TOOL, SEND_TO_USER_TOOL] });
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
    } else if (name === "send_file") {
        return handleSendFile(id, args);
    } else if (name === "telegram_call") {
        return handleTelegramCall(id, args);
    } else if (name === "send_to_user") {
        return handleSendToUser(id, args);
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
        const result = await callBot({ method: "ask_user", params: args, scopeKey: getScopeKey() });
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
            scopeKey: getScopeKey(),
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
        const result = await callBot({ method: "notify_user", params: { message: args.message }, scopeKey: getScopeKey() });
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

async function handleSendFile(id, args) {
    if (!args?.file_path || typeof args.file_path !== "string") {
        send(id, {
            content: [{ type: "text", text: "Error: file_path parameter is required" }],
            isError: true,
        });
        return;
    }
    log(`send_file called: "${args.file_path}"`);
    pendingCalls++;
    try {
        const result = await callBot({
            method: "send_file",
            params: {
                file_path: args.file_path,
                caption: args.caption || "",
                type: args.type || "auto",
            },
            scopeKey: getScopeKey(),
        });
        if (result.error) {
            send(id, {
                content: [{ type: "text", text: `Error: ${result.error}` }],
                isError: true,
            });
        } else {
            send(id, {
                content: [{ type: "text", text: `File sent: ${result.filename || args.file_path}` }],
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
            scopeKey: getScopeKey(),
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

async function handleSendToUser(id, args) {
    if (!args?.target || typeof args.target !== "string") {
        send(id, { content: [{ type: "text", text: "Error: target parameter is required" }], isError: true });
        return;
    }
    if (!args?.message || typeof args.message !== "string") {
        send(id, { content: [{ type: "text", text: "Error: message parameter is required" }], isError: true });
        return;
    }
    log(`send_to_user called: target="${args.target}", msg="${args.message.substring(0, 80)}"`);
    pendingCalls++;
    try {
        const result = await callBot({
            method: "send_to_user",
            params: { target: args.target, message: args.message },
            scopeKey: getScopeKey(),
        });
        if (result.error) {
            send(id, { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true });
        } else {
            send(id, { content: [{ type: "text", text: `Message sent to ${result.resolvedName || args.target}` }] });
        }
    } catch (err) {
        send(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
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
