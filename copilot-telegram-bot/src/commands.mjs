// ============================================================
// Slash Command Handler
// ============================================================

export function parseSlashCommand(text, botUsername) {
    const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?\s*([\s\S]*)?$/);
    if (!match) return null;
    const [, command, atBot, args] = match;
    if (atBot && botUsername) {
        if (atBot.toLowerCase() !== botUsername.toLowerCase()) return null;
    }
    return { command: command.toLowerCase(), args: (args || "").trim() };
}

export async function handleSlashCommand(ctx, command, args) {
    const { acp, telegram, chatId, chatIds, log } = ctx;
    const reply = (text) => telegram.enqueue(() => telegram.sendMessage(chatId, text));
    const broadcast = (text) => {
        for (const cid of chatIds) {
            telegram.enqueue(() => telegram.sendMessage(cid, text));
        }
    };

    try {
        switch (command) {
            case "autopilot": {
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                if (args === "off" || args === "false") {
                    await acp.setMode("interactive");
                    broadcast("✅ Autopilot OFF → interactive mode");
                } else {
                    await acp.setMode("autopilot");
                    broadcast("✅ Autopilot ON");
                }
                return true;
            }
            case "plan": {
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                if (args === "off" || args === "false") {
                    await acp.setMode("interactive");
                    broadcast("✅ Plan mode OFF → interactive mode");
                } else {
                    await acp.setMode("plan");
                    broadcast("✅ Plan mode ON");
                }
                return true;
            }
            case "mode": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                try {
                    const mode = await acp.getMode();
                    reply(`📋 Current mode: ${mode?.mode || mode || "unknown"}`);
                } catch {
                    reply("📋 Mode: unknown (RPC not available)");
                }
                return true;
            }
            case "compact": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                await acp.compact();
                broadcast("🗜️ History compacted");
                return true;
            }
            case "model": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (args) {
                    await acp.setModel(args);
                    broadcast(`🤖 Model → ${args}`);
                } else {
                    try {
                        const current = await acp.getModel();
                        reply(`🤖 Current model: ${current?.modelId || current || "unknown"}`);
                    } catch {
                        reply("🤖 Model: unknown");
                    }
                }
                return true;
            }
            case "usage":
            case "context": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                try {
                    const metrics = await acp.getUsage();
                    const lines = ["📊 Usage Metrics:"];
                    if (metrics?.contextWindow) {
                        const cw = metrics.contextWindow;
                        lines.push(`  Context: ${cw.used?.toLocaleString() || "?"} / ${cw.total?.toLocaleString() || "?"} tokens`);
                    }
                    if (metrics?.session) {
                        const s = metrics.session;
                        if (s.turns != null) lines.push(`  Turns: ${s.turns}`);
                        if (s.inputTokens != null) lines.push(`  Input: ${s.inputTokens.toLocaleString()} tokens`);
                        if (s.outputTokens != null) lines.push(`  Output: ${s.outputTokens.toLocaleString()} tokens`);
                    }
                    reply(lines.join("\n"));
                } catch {
                    reply("📊 Usage metrics not available");
                }
                return true;
            }
            case "status": {
                const lines = ["📡 Copilot Telegram Bot Status:"];
                lines.push(`  🤖 Copilot: ${acp?.alive ? "running" : "stopped"}`);
                lines.push(`  📱 Telegram: connected`);
                lines.push(`  👥 Allowed chats: ${chatIds.length}`);
                if (acp?.sessionId) lines.push(`  🔗 Session: ${acp.sessionId.slice(0, 8)}...`);
                reply(lines.join("\n"));
                return true;
            }
            case "start":
                return true; // Telegram built-in, ignore
            case "session": {
                if (args === "new" || args === "restart") {
                    if (acp?.alive) {
                        broadcast("🔄 Restarting Copilot session...");
                        await ctx.restartCopilot?.();
                    } else {
                        broadcast("🚀 Starting Copilot...");
                        await ctx.startCopilot?.();
                    }
                    return true;
                }
                if (args === "stop" || args === "kill") {
                    if (acp?.alive) {
                        await ctx.stopCopilot?.();
                        broadcast("⏹️ Copilot stopped");
                    } else {
                        reply("⚠️ Copilot not running");
                    }
                    return true;
                }
                reply(
                    "🔗 Session commands:\n" +
                    "  /session new — restart session\n" +
                    "  /session stop — stop Copilot"
                );
                return true;
            }
            case "help": {
                reply(
                    "📋 Available commands:\n" +
                    "  /autopilot [on|off]\n" +
                    "  /plan [on|off]\n" +
                    "  /mode\n" +
                    "  /model [name]\n" +
                    "  /compact\n" +
                    "  /usage\n" +
                    "  /status\n" +
                    "  /session [new|stop]\n" +
                    "  /help"
                );
                return true;
            }
            default:
                return false; // Unknown command — fall through to prompt
        }
    } catch (err) {
        reply(`❌ Command error: ${err.message}`);
        return true;
    }
}
