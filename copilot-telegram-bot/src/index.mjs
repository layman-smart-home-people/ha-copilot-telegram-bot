#!/usr/bin/env node
// ============================================================
// Ezra v7 — Main Entry Point
// ============================================================
// Architecture: Pool → ConversationManager → Router → Telegram
// Replaces the v6 orchestrator-based design.

import { existsSync } from "node:fs";
import { TelegramClient } from "./transport/telegram/client.mjs";
import { ACPPool } from "./pool/index.mjs";
import { ConversationManager } from "./conversation/index.mjs";
import { Router } from "./gateway/router.mjs";
import { Permissions } from "./gateway/permissions.mjs";
import { PromptEnricher } from "./gateway/prompt-enricher.mjs";
import { SIBridge } from "./gateway/si-bridge.mjs";
import { TopicManager } from "./core/topic-manager.mjs";
import { StandingInstructionManager } from "./ha/standing-instructions.mjs";
import { StandingInstructionOrchestrator } from "./ha/orchestrator.mjs";
import { HAEventListener } from "./ha/events.mjs";
import { WebUIServer } from "./webui/server.mjs";
import { loadConfig } from "./config.mjs";
import { createLogger, setLogLevel } from "./logger.mjs";
import { ensureCopilotBinary, ensureCopilotConfigDir } from "./copilot-bootstrap.mjs";

// --- Timezone from HA ---
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

const log = createLogger("main-v7");

// --- Crash guards ---
process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled rejection: ${reason?.message || reason}`);
    if (reason?.stack) log.debug(reason.stack);
});

// --- Globals for shutdown ---
let _pool = null;
let _convMgr = null;
let _telegram = null;
let _router = null;
let _siOrchestrator = null;
let _webui = null;

// --- Main ---
async function main() {
    const config = await loadConfig();
    setLogLevel(config.logLevel);

    log.info(`Ezra v7 starting (TZ=${process.env.TZ || "UTC"})`);
    log.info(`Binary: ${config.copilotBinary} | Config: ${config.copilotConfigDir}`);

    // GitHub token
    if (config.githubToken) {
        if (config.githubToken.startsWith("ghp_")) {
            log.error("Classic PATs (ghp_) not supported. Use github_pat_ or device login.");
        } else {
            process.env.COPILOT_GITHUB_TOKEN = config.githubToken;
        }
    }

    // Validate binary
    if (!existsSync(config.copilotBinary)) {
        try {
            config.copilotBinary = await ensureCopilotBinary(config.copilotBinary);
            log.info(`Binary auto-installed: ${config.copilotBinary}`);
        } catch (err) {
            log.error(`Binary not found and download failed: ${err.message}`);
            process.exit(1);
        }
    }
    ensureCopilotConfigDir(config.copilotConfigDir);

    // --- Telegram ---
    const telegram = new TelegramClient({ token: config.botToken });
    _telegram = telegram;

    try {
        const me = await telegram.getMe();
        log.info(`Telegram: @${me.username} (${me.first_name})`);
        if (me.has_topics_enabled) {
            log.info("Bot has Threaded Mode enabled (BotFather)");
        }
    } catch (err) {
        log.error(`Invalid bot token: ${err.message}`);
        process.exit(1);
    }

    // Register commands
    await telegram.call("setMyCommands", {
        commands: [
            { command: "stop", description: "Cancel current operation" },
            { command: "new", description: "Start fresh conversation" },
            { command: "help", description: "Show available commands" },
            { command: "status", description: "Bot & pool status" },
            { command: "settings", description: "Configure bot settings" },
            { command: "standing", description: "Standing instructions" },
            { command: "memory", description: "Memory & knowledge" },
        ],
    }).catch(err => log.warn(`Command registration failed: ${err.message}`));

    // --- Permissions ---
    const permissions = new Permissions({ config });

    // --- Prompt Enricher ---
    const enricher = new PromptEnricher({ config, permissions });

    // --- MCP Profiles ---
    // Owner profile: full tool access (ha-mcp + any configured MCP servers)
    const ownerMcpServers = {};
    if (config.mcpServers?.length) {
        for (const s of config.mcpServers) {
            if (s.url) {
                ownerMcpServers[s.name] = { type: "sse", url: s.url };
            } else if (s.command) {
                ownerMcpServers[s.name] = { type: "stdio", command: s.command, args: s.args || [] };
            }
        }
    }
    // Guest profile: no MCP tools (or limited set in future)
    const mcpProfiles = {
        owner: { mcpServers: ownerMcpServers },
        guest: { mcpServers: {} },
    };

    // --- Pool ---
    const pool = new ACPPool({ config, mcpProfiles });
    _pool = pool;
    await pool.boot();

    // --- ConversationManager ---
    const convMgr = new ConversationManager({ pool, telegram, config });
    _convMgr = convMgr;
    convMgr.start();

    // --- Router ---
    const router = new Router({ telegram, conversationManager: convMgr, pool, permissions, config, enricher });
    _router = router;
    router.start();

    // --- DM Topics ---
    let topicManager = null;
    if (config.dmTopicsEnabled) {
        topicManager = new TopicManager({ telegram, config });
        router.setTopicManager(topicManager);

        // Create topics for each allowed private chat
        const topicChatId = config.allowedChatIds?.[0];
        if (topicChatId) {
            try {
                await topicManager.ensureTopics(Number(topicChatId));
                const topics = topicManager.getTopics(topicChatId);
                log.info(`DM topics ready: ${topics?.length || 0} topics for chat ${topicChatId}`);
            } catch (err) {
                log.warn(`DM topic setup failed (non-fatal): ${err.message}`);
            }
        }
    }

    // --- Start Polling ---
    telegram.startPolling();
    log.info("✅ Ezra v7 online — polling for messages");

    // --- Standing Instructions ---
    const ownerChatId = config.allowedChatIds?.[0];
    try {
        const siManager = new StandingInstructionManager();
        const haEventListener = new HAEventListener();
        const siBridge = new SIBridge({ conversationManager: convMgr, telegram, config });
        if (topicManager) siBridge.setTopicManager(topicManager);

        const siOrchestrator = new StandingInstructionOrchestrator({
            eventListener: haEventListener,
            manager: siManager,
            bridge: siBridge,
            telegram,
            ownerChatId,
            haBaseUrl: "http://supervisor/core/api",
            haToken: process.env.SUPERVISOR_TOKEN,
        });
        _siOrchestrator = siOrchestrator;
        await siOrchestrator.start();
        router.setSIOrchestrator(siOrchestrator);
        log.info("Standing instructions active");
    } catch (err) {
        log.warn(`SI startup failed (non-fatal): ${err.message}`);
    }

    // --- WebUI ---
    const webui = new WebUIServer({ port: 8099 });
    _webui = webui;
    webui.attach({
        pool,
        conversationManager: convMgr,
        siOrchestrator: _siOrchestrator,
        config,
        telegram,
        startedAt: Date.now(),
        enricher,
    });
    await webui.start();
    log.info("WebUI listening on :8099");

    // Hook console.log → WebUI SSE log stream
    const origLog = console.log;
    console.log = (...args) => {
        origLog(...args);
        const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        webui.pushLog(line);
    };

    // Notify owner
    if (ownerChatId) {
        const poolStatus = pool.status();
        telegram.sendMessage(
            ownerChatId,
            `✅ Ezra v7 online\n🤖 Pool: ${poolStatus.idle} ready (max ${poolStatus.maxSize})`,
        ).catch(() => {});
    }
}

// --- Shutdown ---
async function shutdown(signal) {
    log.info(`${signal} received — shutting down`);
    const timer = setTimeout(() => process.exit(0), 8000);

    // Notify active conversations
    if (_convMgr && _telegram) {
        const active = _convMgr.list().filter(c => c.state === "prompting");
        for (const c of active) {
            const chatId = c.scopeKey.split(":")[1];
            if (chatId) {
                _telegram.sendMessage(chatId, "⚠️ Restarting — your conversation will resume shortly.").catch(() => {});
            }
        }
    }

    try {
        if (_telegram) _telegram.stopPolling();
        if (_router) _router.stop();
        if (_siOrchestrator) await _siOrchestrator.stop();
        if (_webui) await _webui.stop();
    } catch {}

    try {
        if (_convMgr) await _convMgr.stop();
    } catch (err) {
        log.error(`ConvMgr shutdown: ${err.message}`);
    }

    try {
        if (_pool) await _pool.shutdown();
    } catch (err) {
        log.error(`Pool shutdown: ${err.message}`);
    }

    clearTimeout(timer);
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch(err => {
    log.error(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
});
