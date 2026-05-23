#!/usr/bin/env node
// ============================================================
// Copilot Telegram Bot — Main Entry Point
// ============================================================
// Always-on Telegram bot that connects to GitHub Copilot CLI
// via the Agent Client Protocol (ACP).

import { readFileSync, existsSync } from "node:fs";
import { ACPClient } from "./acp.mjs";
import { TelegramClient } from "./telegram.mjs";
import { Bridge } from "./bridge.mjs";

// --- Config ---

function loadConfig() {
    // HA add-on options are at /data/options.json
    const optionsPath = "/data/options.json";
    let options = {};
    if (existsSync(optionsPath)) {
        try {
            options = JSON.parse(readFileSync(optionsPath, "utf-8"));
        } catch (err) {
            log(`Failed to read options.json: ${err.message}`);
        }
    }

    // Allow env overrides for development
    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN || options.bot_token || "",
        allowedChatIds: options.allowed_chat_ids || [],
        copilotBinary: process.env.COPILOT_BINARY || options.copilot_binary || "/share/copilot-tools/copilot",
        copilotConfigDir: options.copilot_config_dir || "/share/copilot-tools/.copilot",
        copilotExtraArgs: options.copilot_extra_args || "",
        preamble: options.preamble || "Be concise, mobile-first, Telegram-friendly PLAIN TEXT only.",
        autoStart: options.auto_start !== false,
        idleTimeoutMinutes: options.idle_timeout_minutes || 0,
        model: options.model || "",
        workingDirectory: options.working_directory || "/config",
        mcpServers: [],
    };

    // Try to load MCP config
    const mcpPaths = [
        "/data/.copilot/mcp.json",
        `${config.copilotConfigDir}/mcp.json`,
    ];
    for (const p of mcpPaths) {
        if (existsSync(p)) {
            try {
                const mcpConfig = JSON.parse(readFileSync(p, "utf-8"));
                if (mcpConfig.mcpServers) {
                    config.mcpServers = Object.entries(mcpConfig.mcpServers).map(([name, server]) => ({
                        name,
                        ...server,
                    }));
                }
                log(`Loaded MCP config from ${p} (${config.mcpServers.length} servers)`);
                break;
            } catch {}
        }
    }

    return config;
}

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

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
        log(`ERROR: Copilot binary not found at ${config.copilotBinary}`);
        log("Make sure the Copilot CLI add-on is installed and the path is correct.");
        process.exit(1);
    }

    // Quick ACP handshake test
    log("Testing Copilot ACP connection...");
    const testAcp = new ACPClient({
        binary: config.copilotBinary,
        cwd: config.workingDirectory,
        model: config.model,
        extraArgs: config.copilotExtraArgs,
    });

    try {
        const result = await testAcp.start();
        log(`Copilot ACP OK: ${result.agentInfo?.name} v${result.agentInfo?.version}`);
        await testAcp.stop();
    } catch (err) {
        log(`WARNING: Copilot ACP test failed: ${err.message}`);
        log("The bot will start but Copilot may not work. Check auth with 'copilot login'.");
        try { await testAcp.stop(); } catch {}
    }
}

// --- Main ---

async function main() {
    log("Copilot Telegram Bot starting...");

    const config = loadConfig();
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

    // Create ACP client
    const acp = new ACPClient({
        binary: config.copilotBinary,
        cwd: config.workingDirectory,
        model: config.model,
        extraArgs: config.copilotExtraArgs,
    });

    // Create bridge
    const bridge = new Bridge({
        telegram,
        acp,
        config,
        log,
    });

    bridge.setupACPHandlers();
    bridge.setupTelegramHandlers();

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

    // Send startup message
    for (const chatId of bridge.allowedChatIds) {
        telegram.enqueue(() =>
            telegram.sendMessage(chatId, `🟢 Copilot Telegram Bot online. ${acp.alive ? "Session ready." : "Send a message to start Copilot."}`)
        );
    }

    // Start polling (this blocks)
    log("Starting Telegram polling...");
    await telegram.startPolling();

    log("Polling stopped.");
}

// --- Shutdown ---

async function shutdown(signal) {
    log(`Received ${signal}, shutting down...`);

    // Give 5 seconds for cleanup
    const timer = setTimeout(() => process.exit(0), 5000);

    try {
        // Notify users
        // (telegram client may already be stopped, so this is best-effort)
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
