#!/usr/bin/env node
// ============================================================
// Copilot Telegram Bot — Main Entry Point
// ============================================================
// Always-on Telegram bot that connects to GitHub Copilot CLI
// via the Agent Client Protocol (ACP).

import { existsSync } from "node:fs";
import { ACPClient } from "./acp.mjs";
import { TelegramClient } from "./telegram.mjs";
import { Bridge } from "./bridge.mjs";
import { PairingManager } from "./pairing.mjs";
import { ScopeManager } from "./scope-manager.mjs";
import { SessionManager } from "./sessions.mjs";
import { loadConfig } from "./config.mjs";

// --- Set timezone from HA system before any Date operations ---
if (!process.env.TZ || process.env.TZ === "UTC" || process.env.TZ === "Etc/UTC") {
    const token = process.env.SUPERVISOR_TOKEN;
    if (token) {
        for (const url of ["http://supervisor/core/api/config", "http://supervisor/info"]) {
            try {
                const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (!res.ok) continue;
                const data = await res.json();
                const tz = data?.time_zone || data?.data?.timezone;
                if (tz) { process.env.TZ = tz; break; }
            } catch { /* try next */ }
        }
    }
}

// --- Config ---

function log(msg) {
    // Use local time (respects TZ env) in ISO-ish format
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
    console.log(`[${ts}] ${msg}`);
}

// Log timezone after it's been set
log(`Copilot Telegram Bot starting... (TZ=${process.env.TZ || "UTC"})`);

// --- Startup validation ---

async function validate(config) {
    if (!config.botToken) {
        log("ERROR: No bot_token configured. Set it in the add-on configuration.");
        process.exit(1);
    }

    if (config.allowedChatIds.length === 0) {
        log("WARNING: No allowed_chat_ids configured. The bot will not respond to anyone.");
        log("Add your Telegram chat ID to the add-on configuration.");
    }

    // Validate copilot binary
    if (!existsSync(config.copilotBinary)) {
        log(`WARNING: Copilot binary not found at ${config.copilotBinary}`);
        log("The bot will start but Copilot won't work until the binary is available.");
        log("Make sure the Copilot CLI is installed at the configured path.");
        return; // Don't exit — let the bot start anyway
    }

    // Quick ACP handshake test
    log("Testing Copilot ACP connection...");
    const testAcp = new ACPClient({
        binary: config.copilotBinary,
        cwd: config.workingDirectory,
        model: config.model,
        extraArgs: config.copilotExtraArgs,
        copilotHome: config.copilotConfigDir,
        permissionPolicy: "allow_all", // test always uses allow_all
    });

    // Capture stderr for diagnostics
    const stderrLines = [];
    testAcp.on("log", (text) => stderrLines.push(text));

    try {
        const result = await testAcp.start();
        const authMethods = result.authMethods?.map(m => m.id).join(", ") || "none";
        log(`Copilot ACP OK: ${result.agentInfo?.name} v${result.agentInfo?.version} (auth methods: ${authMethods})`);
        await testAcp.stop();
    } catch (err) {
        log(`WARNING: Copilot ACP test failed: ${err.message}`);
        if (stderrLines.length > 0) {
            log(`Copilot stderr: ${stderrLines.join(" | ")}`);
        }
        log("The bot will start but Copilot may not work until the issue is resolved.");
        try { await testAcp.stop(); } catch {}
    }
}

// --- Main ---

async function main() {

    const config = await loadConfig(log);

    // Inject github_token into env BEFORE validation so the ACP test has it
    if (config.githubToken) {
        if (config.githubToken.startsWith("ghp_")) {
            log("WARNING: Classic PATs (ghp_) are NOT supported by Copilot CLI.");
            log("Use a fine-grained PAT (github_pat_) with 'Copilot Requests' permission.");
            log("Ignoring configured token — will use stored credentials or device login.");
        } else {
            process.env.COPILOT_GITHUB_TOKEN = config.githubToken;
            log("Using configured GitHub token for authentication");
        }
    }

    await validate(config);

    // Create Telegram client
    const telegram = new TelegramClient({
        token: config.botToken,
    });

    // Validate bot token
    try {
        const me = await telegram.getMe();
        log(`Telegram bot: @${me.username} (${me.first_name})`);
    } catch (err) {
        log(`ERROR: Invalid bot token: ${err.message}`);
        process.exit(1);
    }

    // Register bot commands with Telegram
    try {
        await telegram.call("setMyCommands", {
            commands: [
                { command: "help", description: "Show available commands" },
                { command: "status", description: "Bot & Copilot status" },
                { command: "autopilot", description: "Toggle autopilot mode" },
                { command: "plan", description: "Toggle plan mode" },
                { command: "model", description: "Switch AI model" },
                { command: "compact", description: "Compact conversation history" },
                { command: "usage", description: "Show usage metrics" },
                { command: "stop", description: "Stop current operation" },
                { command: "retry", description: "Retry last message" },
                { command: "session", description: "Session management (new/stop)" },
                { command: "mode", description: "Switch conversation mode" },
                { command: "history", description: "Show recent chat history" },
                { command: "skills", description: "Show available tools & skills" },
                { command: "new", description: "Create new session/topic" },
                { command: "close", description: "Close current topic session" },
                { command: "sessions", description: "List all sessions" },
                { command: "pair", description: "Pairing & user management" },
                { command: "allowall", description: "Toggle auto-approve all tools" },
            ],
        });
        log("Registered bot commands with Telegram");
    } catch (err) {
        log(`WARNING: Failed to register commands: ${err.message}`);
    }

    // Create ACP client
    const acp = new ACPClient({
        binary: config.copilotBinary,
        cwd: config.workingDirectory,
        model: config.model,
        extraArgs: config.copilotExtraArgs,
        copilotHome: config.copilotConfigDir,
        permissionPolicy: config.permissionPolicy || "interactive",
    });

    // Create pairing manager
    const pairing = new PairingManager({
        persistPath: "/data/paired_users.json",
        preApprovedIds: config.allowedChatIds || [],
        log,
    });

    // Create session manager
    const sessionMgr = new SessionManager({
        persistPath: "/data/sessions.json",
        log,
    });

    const scopeMgr = new ScopeManager({
        persistPath: "/data/scopes.json",
        defaultAllowAll: config.permissionPolicy === "allow_all",
        log,
    });

    const bridge = new Bridge({
        telegram,
        acp,
        config,
        log,
        pairing,
        sessionMgr,
        scopeMgr,
    });

    bridge.setupACPHandlers();
    bridge.setupTelegramHandlers();
    _bridge = bridge; // expose for shutdown handler
    _scopeMgr = scopeMgr;

    // Start Telegram polling FIRST so the bot can send/receive messages
    // during login flow
    log("Starting Telegram polling...");
    telegram.startPolling();

    // Auto-start Copilot if configured
    if (config.autoStart) {
        try {
            await bridge.startCopilot();
        } catch (err) {
            log(`Auto-start failed: ${err.message}. Will retry on first message.`);
        }
    }

    // Idle timeout
    let idleTimer = null;
    if (config.idleTimeoutMinutes > 0) {
        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(async () => {
                if (acp.alive && !bridge.promptActive) {
                    log(`Idle timeout (${config.idleTimeoutMinutes}min) — stopping Copilot`);
                    for (const chatId of bridge.allowedChatIds) {
                        telegram.enqueue(() =>
                            telegram.sendMessage(chatId, `⏸️ Copilot stopped (idle ${config.idleTimeoutMinutes}min). Send a message to restart.`)
                        );
                    }
                    await bridge.stopCopilot();
                }
            }, config.idleTimeoutMinutes * 60 * 1000);
        };
        telegram.on("update", resetIdle);
        resetIdle();
    }

    // Startup logged (no user-facing message)
    for (const chatId of bridge.allowedChatIds) {
        log(`Bot online, chat ${chatId} ready`);
    }
}

// --- Shutdown ---

let _bridge = null; // set during main() for shutdown access
let _scopeMgr = null;

async function shutdown(signal) {
    log(`Received ${signal}, shutting down...`);

    const timer = setTimeout(() => process.exit(0), 5000);

    try {
        if (_scopeMgr) _scopeMgr.shutdown();
    } catch (err) {
        log(`Scope shutdown error: ${err.message}`);
    }

    try {
        if (_bridge) {
            await _bridge.notifyShutdown();
        }
    } catch {}

    clearTimeout(timer);
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch(err => {
    log(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
