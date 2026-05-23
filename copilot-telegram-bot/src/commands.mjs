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
    const { acp, telegram, chatId, chatIds, log, buttons, models, modes, history,
            currentModel, currentMode, availableCommands, knownTools } = ctx;
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
                if (buttons && modes?.length > 0) {
                    const rows = modes.map(m => [{ text: m.name || m.id, value: m.id }]);
                    const selected = await buttons.prompt(chatId, "📋 Select a mode:", rows, {
                        timeoutText: "📋 Mode selection expired",
                    });
                    if (selected) {
                        await acp.setMode(selected);
                        const name = modes.find(m => m.id === selected)?.name || selected;
                        broadcast(`📋 Mode → ${name}`);
                    }
                } else {
                    reply("📋 Mode: use /autopilot or /plan to change");
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
                } else if (buttons && models?.length > 0) {
                    // Show interactive model picker
                    const rows = [];
                    for (let i = 0; i < models.length; i += 2) {
                        const row = [{ text: models[i].name || models[i].modelId, value: models[i].modelId }];
                        if (models[i + 1]) {
                            row.push({ text: models[i + 1].name || models[i + 1].modelId, value: models[i + 1].modelId });
                        }
                        rows.push(row);
                    }
                    const selected = await buttons.prompt(chatId, "🤖 Select a model:", rows, {
                        timeoutText: "🤖 Model selection expired",
                    });
                    if (selected) {
                        await acp.setModel(selected);
                        const name = models.find(m => m.modelId === selected)?.name || selected;
                        broadcast(`🤖 Model → ${name}`);
                    }
                } else {
                    reply("🤖 No models available yet. Try again after session starts.");
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
                const alive = acp?.alive;
                const hasSession = !!acp?.sessionId;
                const ready = alive && hasSession;

                const lines = [];
                lines.push(ready ? "✅ Copilot Ready" : alive ? "⏳ Copilot Starting..." : "⏹️ Copilot Stopped");
                lines.push("");

                if (ready) {
                    const modelName = models?.find(m => m.modelId === currentModel)?.name || currentModel || "unknown";
                    const modeName = modes?.find(m => m.id === currentMode)?.name || currentMode || "unknown";
                    lines.push(`🤖 Model: ${modelName}`);
                    lines.push(`📋 Mode: ${modeName}`);
                    lines.push(`🔗 Session: ${acp.sessionId.slice(0, 8)}…`);
                    lines.push(`📊 Models available: ${models?.length || 0}`);
                }

                lines.push(`📱 Telegram: connected`);
                lines.push(`👥 Allowed chats: ${chatIds.length}`);
                if (history) lines.push(`📜 History: ${history.length} messages`);

                const statusButtons = {
                    inline_keyboard: ready ? [
                        [
                            { text: "🤖 Model", callback_data: "/model" },
                            { text: "📋 Mode", callback_data: "/mode" },
                        ],
                        [
                            { text: "📊 Usage", callback_data: "/usage" },
                            { text: "🗜️ Compact", callback_data: "/compact" },
                        ],
                        [
                            { text: "🔄 Restart", callback_data: "/session new" },
                            { text: "⏹️ Stop", callback_data: "/session stop" },
                        ],
                    ] : [
                        [{ text: "🚀 Start Copilot", callback_data: "/session new" }],
                    ],
                };
                telegram.enqueue(() => telegram.sendMessage(chatId, lines.join("\n"), undefined, statusButtons));
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
            case "cancel": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                try {
                    await acp.cancel();
                    broadcast("🛑 Cancelled current operation");
                } catch (err) {
                    reply(`⚠️ Cancel failed: ${err.message}`);
                }
                return true;
            }
            case "history": {
                if (!history) { reply("📜 No history available"); return true; }
                const n = parseInt(args) || 10;
                const formatted = history.format(Math.min(n, 30));
                reply(`📜 Recent messages (${Math.min(n, 30)}):\n\n${formatted}`);
                return true;
            }
            case "skills":
            case "tools": {
                const lines = ["🧰 Available Skills & Tools\n"];

                // Copilot slash commands from ACP
                if (availableCommands?.length > 0) {
                    lines.push("⚡ Copilot Commands:");
                    for (const cmd of availableCommands) {
                        const name = cmd.name || cmd.command || cmd;
                        const desc = cmd.description ? ` — ${cmd.description}` : "";
                        lines.push(`  /${name}${desc}`);
                    }
                    lines.push("");
                }

                // MCP tools discovered from tool calls
                if (knownTools?.size > 0) {
                    // Group by prefix (ha_, github_, etc.)
                    const groups = new Map();
                    for (const [name] of knownTools) {
                        const prefix = name.includes("_") ? name.split("_")[0] : "other";
                        if (!groups.has(prefix)) groups.set(prefix, []);
                        groups.get(prefix).push(name);
                    }

                    const labels = { ha: "🏠 Home Assistant", github: "🐙 GitHub", mcp: "🔌 MCP" };
                    for (const [prefix, tools] of groups) {
                        const label = labels[prefix] || `🔧 ${prefix}`;
                        lines.push(`${label} Tools:`);
                        for (const t of tools.sort()) {
                            lines.push(`  • ${t}`);
                        }
                        lines.push("");
                    }
                }

                // Bot commands (always available)
                lines.push("📱 Bot Commands:");
                lines.push("  /help /status /model /mode");
                lines.push("  /skills /history /compact");
                lines.push("  /autopilot /plan /cancel");
                lines.push("  /usage /session");

                if (!knownTools?.size && !availableCommands?.length) {
                    lines.push("\n💡 MCP tools will appear here after Copilot uses them.");
                    lines.push("Try asking Copilot to check your HA entities!");
                }

                reply(lines.join("\n"));
                return true;
            }
            case "help": {
                const helpButtons = {
                    inline_keyboard: [
                        [
                            { text: "📡 Status", callback_data: "/status" },
                            { text: "📊 Usage", callback_data: "/usage" },
                        ],
                        [
                            { text: "🤖 Autopilot", callback_data: "/autopilot on" },
                            { text: "📋 Plan", callback_data: "/plan on" },
                        ],
                        [
                            { text: "🗜️ Compact", callback_data: "/compact" },
                            { text: "🛑 Cancel", callback_data: "/cancel" },
                        ],
                        [
                            { text: "🔄 Restart Session", callback_data: "/session new" },
                        ],
                    ],
                };
                telegram.enqueue(() => telegram.sendMessage(
                    chatId,
                    "📋 Available commands:\n" +
                    "  /autopilot [on|off]\n" +
                    "  /plan [on|off]\n" +
                    "  /model [name]\n" +
                    "  /mode\n" +
                    "  /skills — show available tools\n" +
                    "  /compact\n" +
                    "  /cancel\n" +
                    "  /usage\n" +
                    "  /status\n" +
                    "  /history [n]\n" +
                    "  /session [new|stop]\n" +
                    "  /help\n\n" +
                    "💡 Reply to any message to give Copilot context.\n\n" +
                    "Or tap a button below:",
                    undefined,
                    helpButtons
                ));
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
