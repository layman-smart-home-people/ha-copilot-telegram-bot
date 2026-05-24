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
    const { acp, telegram, transport, chatId, chatIds, ref, log, buttons, models, modes, history,
            currentModel, currentMode, availableCommands, knownTools, pairing, sessionMgr, bridge, config } = ctx;
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
                    const { value: selected } = await buttons.prompt(chatId, "📋 Select a mode:", rows, {
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
                    const { value: selected } = await buttons.prompt(chatId, "🤖 Select a model:", rows, {
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
                await bridge.showStatusMenu(chatId);
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
            case "stop":
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
            case "retry": {
                if (!history) { reply("⚠️ No history available"); return true; }
                const lastUser = history.getLastUserMessage();
                if (!lastUser) { reply("⚠️ No previous message to retry"); return true; }
                // Cancel current operation if running, then resend
                if (acp?.alive && bridge?.promptActive) {
                    try { await acp.cancel(); } catch {}
                }
                reply(`🔄 Retrying: "${lastUser.length > 60 ? lastUser.slice(0, 60) + '...' : lastUser}"`);
                // Re-submit through bridge
                if (bridge?.submitRetry) {
                    bridge.submitRetry(ref, lastUser);
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
                lines.push("  /autopilot /plan /stop /retry");
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
                            { text: "🛑 Stop", callback_data: "/stop" },
                        ],
                        [
                            { text: "🔄 Retry", callback_data: "/retry" },
                            { text: "🔓 Allow All", callback_data: "/allowall on" },
                        ],
                        [
                            { text: "🔄 Restart", callback_data: "/session new" },
                        ],
                        [{ text: "✕ Dismiss", callback_data: "dismiss" }],
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
                    "  /stop — cancel current operation\n" +
                    "  /retry — resend last message\n" +
                    "  /usage\n" +
                    "  /status\n" +
                    "  /history [n]\n" +
                    "  /session [new|stop]\n" +
                    "  /new [title] — new session/topic\n" +
                    "  /close — close current topic\n" +
                    "  /sessions — list sessions\n" +
                    "  /pair — pairing info\n" +
                    "  /allowall [on|off] — toggle tool auto-approve\n" +
                    "  /help\n\n" +
                    "💡 Reply to any message to give Copilot context.\n\n" +
                    "Or tap a button below:",
                    undefined,
                    helpButtons
                ));
                return true;
            }
            case "new": {
                // Create new session (and optionally a forum topic)
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                const title = args || `Session ${new Date().toLocaleString("en-SG", { timeZone: process.env.TZ || "UTC" })}`;

                if (sessionMgr?.forumChatId && ref?.chatId === sessionMgr.forumChatId) {
                    // Forum mode: create a topic
                    try {
                        const topic = await transport.createForumTopic(sessionMgr.forumChatId, `💬 ${title}`);
                        const topicRef = { chatId: sessionMgr.forumChatId, threadId: topic.message_thread_id };

                        // Create ACP session
                        const result = await acp.newSession({ cwd: "/config" });
                        topicRef.sessionId = result.sessionId;
                        sessionMgr.register(topicRef, result.sessionId, title, true);

                        reply(`✅ Session created: ${title}\nTopic opened — start chatting there!`);
                    } catch (err) {
                        reply(`❌ Failed to create session: ${err.message}`);
                    }
                } else {
                    // Private chat: just restart session
                    broadcast("🔄 Creating new session...");
                    await ctx.restartCopilot?.();
                }
                return true;
            }
            case "close": {
                if (sessionMgr && ref?.threadId) {
                    const session = sessionMgr.getSession(ref);
                    if (session) {
                        sessionMgr.closeSession(ref);
                        try {
                            await transport.closeForumTopic(ref.chatId, ref.threadId);
                        } catch {}
                        reply("🔒 Session closed.");
                    } else {
                        reply("⚠️ No session found for this topic.");
                    }
                } else {
                    reply("💡 Use /session stop to stop Copilot in private chat.");
                }
                return true;
            }
            case "sessions": {
                if (!sessionMgr) { reply("📋 Forum topics not configured."); return true; }
                const sessions = sessionMgr.listSessions();
                if (sessions.length === 0) {
                    reply("📋 No sessions. Use /new to create one.");
                    return true;
                }
                const lines = ["📋 Sessions:\n"];
                for (const s of sessions) {
                    const status = s.isCurrent ? "▶️" : s.active ? "⏸️" : "🔒";
                    lines.push(`${status} ${s.title} (${s.sessionId?.slice(0, 8) || "?"}…)`);
                }
                reply(lines.join("\n"));
                return true;
            }
            case "pair": {
                if (!pairing) { reply("🔐 Pairing not available."); return true; }

                if (args === "list") {
                    if (!pairing.isAdmin(ctx.ref?.chatId || chatId)) {
                        reply("🔒 Admin only."); return true;
                    }
                    const users = pairing.getPairedUsers();
                    if (users.length === 0) {
                        reply("👥 No paired users.");
                    } else {
                        const lines = ["👥 Paired users:\n"];
                        for (const u of users) {
                            const admin = u.isAdmin ? " 👑" : "";
                            lines.push(`• ${u.username || u.userId}${admin} (${new Date(u.pairedAt).toLocaleDateString()})`);
                        }
                        reply(lines.join("\n"));
                    }
                    return true;
                }

                reply(
                    "🔐 Pairing info:\n" +
                    "To pair a new device, message the bot from that device.\n" +
                    "A pairing code will appear in HA add-on logs.\n\n" +
                    "/pair list — show paired users\n" +
                    "/unpair <userId> — revoke access"
                );
                return true;
            }
            case "unpair": {
                if (!pairing) { reply("🔐 Pairing not available."); return true; }
                if (!pairing.isAdmin(ctx.ref?.chatId || chatId)) {
                    reply("🔒 Admin only."); return true;
                }
                if (!args) { reply("Usage: /unpair <userId>"); return true; }
                const targetId = parseInt(args);
                if (isNaN(targetId)) { reply("❌ Invalid user ID."); return true; }
                if (pairing.revoke(targetId)) {
                    reply(`✅ Unpaired user ${targetId}`);
                } else {
                    reply(`⚠️ Could not unpair user ${targetId} (admin or not found).`);
                }
                return true;
            }
            case "allowall": {
                if (!bridge) { reply("⚠️ Not available"); return true; }
                if (args === "off" || args === "false") {
                    bridge.allowAll = false;
                    bridge.resetPreamble();
                    broadcast("🔐 Allow-all OFF → agent will confirm before HA write actions");
                } else {
                    bridge.allowAll = true;
                    bridge.resetPreamble();
                    broadcast("🔓 Allow-all ON → all tool calls auto-approved");
                }
                return true;
            }
            case "delete": {
                if (sessionMgr && ref?.threadId) {
                    const session = sessionMgr.getSession(ref);
                    if (session) {
                        sessionMgr.deleteSession(ref);
                        try {
                            await transport.deleteForumTopic(ref.chatId, ref.threadId);
                        } catch {}
                        // Can't reply — topic is deleted
                    } else {
                        reply("⚠️ No session found for this topic.");
                    }
                } else {
                    reply("💡 /delete only works in forum topic sessions.");
                }
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
