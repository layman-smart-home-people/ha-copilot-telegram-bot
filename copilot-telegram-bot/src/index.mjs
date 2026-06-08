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
    const router = new Router({ telegram, conversationManager: convMgr, pool, permissions, config });
    _router = router;
    router.start();

    // --- Start Polling ---
    telegram.startPolling();
    log.info("✅ Ezra v7 online — polling for messages");

    // Notify owner
    const ownerChatId = config.allowedChatIds?.[0];
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

    try {
        if (_telegram) _telegram.stopPolling();
        if (_router) _router.stop();
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
