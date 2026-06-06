#!/usr/bin/env node
// ============================================================
// Copilot Telegram Bot — Main Entry Point
// ============================================================
// Always-on Telegram bot that connects to GitHub Copilot CLI
// via the Agent Client Protocol (ACP).

import { existsSync } from "node:fs";
import { ACPClient } from "./ai/copilot/acp-client.mjs";
import { TelegramClient } from "./transport/telegram/client.mjs";
import { Bridge } from "./bridge.mjs";
import { PairingManager } from "./core/pairing.mjs";
import { ScopeManager } from "./core/scope-manager.mjs";
import { SessionManager } from "./core/sessions.mjs";
import { loadConfig } from "./config.mjs";
import { HAEventListener } from "./ha/events.mjs";
import { StandingInstructionManager } from "./ha/standing-instructions.mjs";
import { StandingInstructionOrchestrator } from "./ha/orchestrator.mjs";
import { WebUIServer } from "./webui/server.mjs";
import { createLogger, setLogLevel } from "./logger.mjs";

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

const log = createLogger('main');

// Log timezone after it's been set
log.info(`Copilot Telegram Bot starting... (TZ=${process.env.TZ || "UTC"})`);

// --- Startup validation ---

async function validate(config) {
    if (!config.botToken) {
        log.error("No bot_token configured. Set it in the add-on configuration.");
        process.exit(1);
    }

    if (config.allowedChatIds.length === 0) {
        log.warn("No allowed_chat_ids configured. The bot will not respond to anyone.");
        log.warn("Add your Telegram chat ID to the add-on configuration.");
    }

    // Validate copilot binary
    if (!existsSync(config.copilotBinary)) {
        log.warn(`Copilot binary not found at ${config.copilotBinary}`);
        log.warn("If copilot_binary is set to 'auto', the bootstrap script should have installed it.");
        log.warn("Check the add-on logs for init-copilot bootstrap errors.");
        log.warn("The bot will start but Copilot won't work until the binary is available.");
        return; // Don't exit — let the bot start anyway
    }

    // Quick ACP handshake test
    log.info("Testing Copilot ACP connection...");
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
        log.info(`Copilot ACP OK: ${result.agentInfo?.name} v${result.agentInfo?.version} (auth methods: ${authMethods})`);
        await testAcp.stop();
    } catch (err) {
        log.warn(`Copilot ACP test failed: ${err.message}`);
        if (stderrLines.length > 0) {
            log.warn(`Copilot stderr: ${stderrLines.join(" | ")}`);
        }
        log.warn("The bot will start but Copilot may not work until the issue is resolved.");
        try { await testAcp.stop(); } catch {}
    }
}

// --- Main ---

async function main() {

    const config = await loadConfig();

    // Set log level from config (must happen early)
    setLogLevel(config.logLevel);
    log.info(`Log level: ${config.logLevel}`);
    log.info(`Copilot binary: ${config.copilotBinary}`);
    log.info(`Copilot config: ${config.copilotConfigDir}`);

    // Inject github_token into env BEFORE validation so the ACP test has it
    if (config.githubToken) {
        if (config.githubToken.startsWith("ghp_")) {
            log.warn("Classic PATs (ghp_) are NOT supported by Copilot CLI.");
            log.warn("Use a fine-grained PAT (github_pat_) with 'Copilot Requests' permission.");
            log.warn("Ignoring configured token — will use stored credentials or device login.");
        } else {
            process.env.COPILOT_GITHUB_TOKEN = config.githubToken;
            log.info("Using configured GitHub token for authentication");
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
        log.info(`Telegram bot: @${me.username} (${me.first_name})`);
        log.debug(`Bot settings: can_join_groups=${me.can_join_groups} can_read_all_group_messages=${me.can_read_all_group_messages} supports_inline_queries=${me.supports_inline_queries}`);
        if (!me.can_read_all_group_messages) {
            log.warn("Bot privacy mode is ON. In groups, the bot can only see @mentions, replies, and /commands.");
            log.warn("To receive all group messages, disable privacy mode in BotFather: /mybots → Bot Settings → Group Privacy → Turn off");
        }
    } catch (err) {
        log.error(`Invalid bot token: ${err.message}`);
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
                { command: "fleet", description: "Autopilot with parallel agents" },
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
                { command: "standing", description: "List/manage standing instructions" },
                { command: "clear", description: "Reset current conversation" },
            ],
        });
        log.info("Registered bot commands with Telegram");
    } catch (err) {
        log.warn(`Failed to register commands: ${err.message}`);
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
    });

    // Create session manager
    const sessionMgr = new SessionManager({
        persistPath: "/data/sessions.json",
    });

    // Owner scope key(s) — never evicted from LRU cache
    const ownerChatId = config.allowedChatIds?.[0];
    const ownerProtectedKeys = ownerChatId ? [`dm:${ownerChatId}`] : [];

    const scopeMgr = new ScopeManager({
        persistPath: "/data/scopes.json",
        defaultAllowAll: config.permissionPolicy === "allow_all",
        protectedKeys: ownerProtectedKeys,
    });

    const bridge = new Bridge({
        telegram,
        acp,
        config,
        pairing,
        sessionMgr,
        scopeMgr,
    });

    bridge.setupACPHandlers();
    bridge.setupTelegramHandlers();
    _bridge = bridge; // expose for shutdown handler
    _scopeMgr = scopeMgr;

    // --- Standing Instructions Orchestrator ---
    const standingMgr = new StandingInstructionManager({
        persistPath: "/data/standing_instructions.json",
    });
    const haEvents = new HAEventListener();
    const orchestrator = new StandingInstructionOrchestrator({
        eventListener: haEvents,
        manager: standingMgr,
        bridge,
        telegram,
        ownerChatId,
    });
    bridge.standingOrchestrator = orchestrator;
    _orchestrator = orchestrator;

    // Start Telegram polling FIRST so the bot can send/receive messages
    // during login flow
    log.info("Starting Telegram polling...");
    telegram.startPolling();

    // Auto-start Copilot if configured
    if (config.autoStart) {
        try {
            await bridge.startCopilot();
        } catch (err) {
            log.warn(`Auto-start failed: ${err.message}. Will retry on first message.`);
        }
    }

    // Start standing instruction orchestrator (non-blocking)
    orchestrator.start().catch(err => {
        log.error(`Standing instruction orchestrator failed to start: ${err.message}`);
    });

    // Start Web UI server (ingress)
    const webui = new WebUIServer({ port: 8099 });
    webui.attach({
        bridge,
        orchestrator,
        scopeMgr,
        config,
        acp,
        telegram,
        startedAt: Date.now(),
    });
    webui.start().catch(err => {
        log.error(`Web UI server failed to start: ${err.message}`);
    });
    _webui = webui;

    // Hook log output into WebUI SSE stream
    const origLog = console.log;
    console.log = (...args) => {
        origLog(...args);
        const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        webui.pushLog(line);
    };

    // Idle timeout
    let idleTimer = null;
    if (config.idleTimeoutMinutes > 0) {
        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(async () => {
                if (acp.alive && !bridge.promptActive) {
                    log.info(`Idle timeout (${config.idleTimeoutMinutes}min) — stopping Copilot`);
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
        log.info(`Bot online, chat ${chatId} ready`);
    }
}

// --- Shutdown ---

let _bridge = null; // set during main() for shutdown access
let _scopeMgr = null;
let _orchestrator = null;
let _webui = null;

async function shutdown(signal) {
    log.info(`Received ${signal}, shutting down...`);

    const timer = setTimeout(() => process.exit(0), 5000);

    try {
        if (_webui) await _webui.stop();
    } catch (err) {
        log.error(`WebUI shutdown error: ${err.message}`);
    }

    try {
        if (_orchestrator) await _orchestrator.stop();
    } catch (err) {
        log.error(`Orchestrator shutdown error: ${err.message}`);
    }

    try {
        if (_scopeMgr) _scopeMgr.shutdown();
    } catch (err) {
        log.error(`Scope shutdown error: ${err.message}`);
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
    log.error(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
