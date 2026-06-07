#!/usr/bin/env node
// ============================================================
// Copilot Telegram Bot — Main Entry Point
// ============================================================
// Always-on Telegram bot that connects to GitHub Copilot CLI
// via the Agent Client Protocol (ACP).

import { existsSync } from "node:fs";
import { ACPClient } from "./ai/copilot/acp-client.mjs";
import { ACPManager } from "./ai/copilot/acp-manager.mjs";
import { TelegramClient } from "./transport/telegram/client.mjs";
import { Orchestrator } from "./core/orchestrator.mjs";
import { RBACManager } from "./core/rbac.mjs";
import { ScopeManager } from "./core/scope-manager.mjs";
import { SessionManager } from "./core/sessions.mjs";
import { loadConfig } from "./config.mjs";
import { HAEventListener } from "./ha/events.mjs";
import { StandingInstructionManager } from "./ha/standing-instructions.mjs";
import { StandingInstructionOrchestrator } from "./ha/orchestrator.mjs";
import { WebUIServer } from "./webui/server.mjs";
import { createLogger, setLogLevel } from "./logger.mjs";
import { eventLog } from "./core/event-log.mjs";
import { metrics } from "./core/metrics.mjs";
import { ensureCopilotBinary, ensureCopilotConfigDir } from "./copilot-bootstrap.mjs";

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

// --- Global crash guards ---
// Prevent unhandled promise rejections from crashing the process.
// Individual errors are already logged at their source; this is the safety net.
process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection (process kept alive): ${reason?.message || reason}`);
    if (reason?.stack) log.debug(reason.stack);
});

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

    // Validate copilot binary — auto-download if missing
    if (!existsSync(config.copilotBinary)) {
        log.info(`Copilot binary not found at ${config.copilotBinary}`);
        try {
            const downloaded = await ensureCopilotBinary(config.copilotBinary);
            config.copilotBinary = downloaded;
            log.info(`Copilot CLI auto-installed to ${downloaded}`);
        } catch (err) {
            log.error(`Failed to auto-download Copilot CLI: ${err.message}`);
            log.warn("The bot will start but Copilot won't work until the binary is available.");
            log.warn("Check internet connectivity and try restarting the add-on.");
            return;
        }
    }

    // Ensure copilot config directory exists
    ensureCopilotConfigDir(config.copilotConfigDir);

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

    // Load persisted metrics and start event log
    await metrics.load();
    metrics.startPersistence();
    eventLog.emit("bot.started", { version: config.version || "unknown" });

    // Inject github_token into env BEFORE validation so the ACP test has it
    let startupWarning = null;
    if (config.githubToken) {
        if (config.githubToken.startsWith("ghp_")) {
            log.error("Classic PATs (ghp_) are NOT supported by Copilot CLI.");
            log.error("Use a fine-grained PAT (github_pat_) with 'Copilot Requests' permission.");
            startupWarning = "🚨 <b>Invalid GitHub Token</b>\n\n" +
                "You configured a <b>classic PAT</b> (<code>ghp_...</code>) which is <b>not supported</b> by Copilot CLI.\n\n" +
                "Options:\n" +
                "1️⃣ Use a <b>fine-grained PAT</b> (<code>github_pat_...</code>) with the <b>\"Copilot Requests\"</b> permission\n" +
                "2️⃣ Remove the token and use the <b>device login flow</b> instead (recommended)\n\n" +
                "The configured token has been ignored.";
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

    // Create ACP Manager (manages primary + overflow ACP instances)
    const acpMgr = new ACPManager({
        config,
        overflowEnabled: config.backgroundEnabled,
        overflowIdleMinutes: config.backgroundIdleMinutes,
        backgroundModel: config.backgroundModel,
    });
    const acp = acpMgr.createPrimary();

    // Create RBAC manager (replaces PairingManager, backward-compatible API)
    const pairing = new RBACManager({
        persistPath: "/data/rbac.json",
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

    const bridge = new Orchestrator({
        telegram,
        acpMgr,
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

    // Send startup warning (e.g. invalid token) to owner chat
    if (startupWarning && ownerChatId) {
        telegram.enqueue(() =>
            telegram.sendMessage(ownerChatId, startupWarning, "HTML")
        );
    }

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

    // Check for document migration (seed defaults changed since last version)
    // Note: hashes are saved after prompt injection (queuing), not after agent completes.
    // If the agent crashes mid-migration, the hashes are already saved and migration won't retry.
    // This is acceptable — Copilot failures during normal prompts indicate bigger issues.
    const migration = bridge.agentMemory.getMigrationPrompt();
    if (migration && ownerChatId) {
        log.info("Seed defaults changed — scheduling document migration");
        setTimeout(() => {
            bridge.injectSystemPrompt(migration.prompt, Number(ownerChatId))
                .then(() => {
                    bridge.agentMemory.saveSeedHashes(migration.hashes);
                    log.info("Document migration prompt injected, seed hashes saved");
                })
                .catch(err => {
                    // Don't save hashes on injection failure — retry on next startup
                    log.error(`Document migration injection failed: ${err.message}`);
                });
        }, 10_000);
    }
}

// --- Shutdown ---

let _bridge = null; // set during main() for shutdown access
let _scopeMgr = null;
let _orchestrator = null;
let _webui = null;

async function shutdown(signal) {
    log.info(`Received ${signal}, shutting down...`);
    eventLog.emit("bot.stopped", { signal });

    const timer = setTimeout(() => process.exit(0), 5000);

    try {
        await metrics.stopPersistence();
    } catch (err) {
        log.error(`Metrics flush error: ${err.message}`);
    }

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
