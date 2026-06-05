// ============================================================
// Slash Command Handler
// ============================================================

import { normalizeModeId, fullModeUri } from "./acp.mjs";
import { escapeHtml } from "./formatter.mjs";

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
    const { acp, telegram, transport, chatId, chatIds, ref, scope, scopeMgr, log, buttons, models, modes, history,
            currentModel, currentMode, availableCommands, knownTools, pairing, sessionMgr, bridge, config, promptActive } = ctx;
    const reply = (text) => telegram.enqueue(() => telegram.sendMessage(chatId, text));
    const broadcast = (text) => {
        for (const cid of chatIds) {
            telegram.enqueue(() => telegram.sendMessage(cid, text));
        }
    };
    const scopeKey = scope?.key || ref?.scopeKey || null;
    const scopeType = scopeKey?.startsWith("forum:") ? "Forum"
        : scopeKey?.startsWith("group:") ? "Group"
        : "DM";
    const scopeLabel = scopeType === "DM" ? "this conversation" : `this ${scopeType.toLowerCase()} conversation`;
    const scopeHistory = scope?.history || history || null;
    const updateScopeSettings = (result) => {
        if (!scope) return;
        if (result?.models?.currentModelId) scope.model = result.models.currentModelId;
        if (result?.modes?.currentModeId) scope.mode = normalizeModeId(result.modes.currentModeId);
    };
    const activateScopeSession = async ({ createIfMissing = false } = {}) => {
        if (!acp?.alive || !scope) return false;
        if (scope.sessionId) {
            if (acp.sessionId !== scope.sessionId) {
                try {
                    const result = await acp.loadSession(scope.sessionId);
                    updateScopeSettings(result);
                } catch {
                    // Old session doesn't exist — clear and create fresh
                    scope.sessionId = null;
                    scope.preambleSent = false;
                    if (!createIfMissing) return false;
                    const result = await acp.newSession({ cwd: config?.workingDirectory || "/config" });
                    scope.sessionId = result.sessionId;
                    if (ref) ref.sessionId = result.sessionId;
                    updateScopeSettings(result);
                }
            }
        } else {
            if (!createIfMissing) return false;
            const result = await acp.newSession({ cwd: config?.workingDirectory || "/config" });
            scope.sessionId = result.sessionId;
            if (ref) ref.sessionId = result.sessionId;
            scope.preambleSent = false;
            updateScopeSettings(result);
        }
        if (scopeMgr && scopeKey) scopeMgr.setActive(scopeKey);
        return true;
    };

    try {
        switch (command) {
            case "autopilot": {
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                await activateScopeSession({ createIfMissing: true });
                const apTarget = (args === "off" || args === "false") ? "agent" : "autopilot";
                try {
                    await acp.setConfigOption("mode", fullModeUri(apTarget));
                    reply(apTarget === "autopilot" ? "🤖 Autopilot ON" : "💬 Autopilot OFF (agent mode)");
                } catch {
                    // Autopilot may fail due to permission service — fall back to prompt
                    bridge.submitSlashCommand(ref, apTarget === "autopilot" ? "/autopilot on" : "/autopilot off");
                }
                return true;
            }
            case "plan": {
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                await activateScopeSession({ createIfMissing: true });
                if (args === "off" || args === "false") {
                    try {
                        await acp.setConfigOption("mode", fullModeUri("agent"));
                        reply("💬 Plan mode OFF (agent mode)");
                    } catch {
                        bridge.submitSlashCommand(ref, "/autopilot off");
                    }
                } else {
                    try {
                        await acp.setConfigOption("mode", fullModeUri("plan"));
                        reply("📝 Plan mode ON");
                    } catch {
                        bridge.submitSlashCommand(ref, "/plan");
                    }
                }
                return true;
            }
            case "fleet": {
                if (!acp?.alive) { reply("⚠️ Copilot not running. Send a message to start it."); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                await activateScopeSession({ createIfMissing: true });
                try {
                    await acp.setConfigOption("mode", fullModeUri("autopilot"));
                    reply("🚀 Fleet (autopilot) mode ON");
                } catch {
                    bridge.submitSlashCommand(ref, "/autopilot on");
                }
                return true;
            }
            case "mode": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                await activateScopeSession({ createIfMissing: true });
                if (buttons && modes?.length > 0) {
                    const rows = modes.map(m => [{ text: m.name || m.id, value: m.id }]);
                    const { value: selected } = await buttons.prompt(chatId, "📋 Select a mode:", rows, {
                        timeoutText: "📋 Mode selection expired",
                    });
                    if (selected) {
                        const modeUri = selected.startsWith("http") ? selected : fullModeUri(normalizeModeId(selected));
                        try {
                            await acp.setConfigOption("mode", modeUri);
                            reply(`✅ Mode → ${normalizeModeId(selected)}`);
                        } catch {
                            // Fall back to prompt-based command
                            const short = normalizeModeId(selected);
                            if (short === "plan") {
                                bridge.submitSlashCommand(ref, "/plan");
                            } else if (short === "autopilot") {
                                bridge.submitSlashCommand(ref, "/autopilot on");
                            } else {
                                bridge.submitSlashCommand(ref, "/autopilot off");
                            }
                        }
                    }
                } else {
                    reply("📋 Mode: use /autopilot or /plan to change");
                }
                return true;
            }
            case "compact": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                if (!await activateScopeSession()) {
                    reply("⚠️ No session yet in this conversation.");
                    return true;
                }
                bridge.submitSlashCommand(ref, "/compact");
                return true;
            }
            case "model": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                await activateScopeSession({ createIfMissing: true });
                const setModel = async (modelId) => {
                    try {
                        await acp.setConfigOption("model", modelId);
                        reply(`✅ Model → ${modelId}`);
                    } catch {
                        bridge.submitSlashCommand(ref, `/model ${modelId}`);
                    }
                };
                if (args) {
                    await setModel(args);
                } else if (buttons && models?.length > 0) {
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
                        await setModel(selected);
                    }
                } else {
                    reply("🤖 No models available yet. Try again after session starts.");
                }
                return true;
            }
            case "usage":
            case "context": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (promptActive) {
                    reply("⏳ Copilot is busy with another request. Try again shortly.");
                    return true;
                }
                if (!await activateScopeSession()) {
                    reply("⚠️ No session yet in this conversation.");
                    return true;
                }
                bridge.submitSlashCommand(ref, "/usage");
                return true;
            }
            case "status": {
                await bridge.showStatusMenu(chatId, scope);
                return true;
            }
            case "start":
                return true; // Telegram built-in, ignore
            case "session": {
                if (args === "new" || args === "restart") {
                    if (!scope) { reply("⚠️ Scope not available"); return true; }
                    if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                    scope.reset();
                    scope.sessionId = null;
                    scope.model = "";
                    scope.mode = "";
                    if (ref) ref.sessionId = null;
                    if (acp?.alive) {
                        const result = await acp.newSession({ cwd: config?.workingDirectory || "/config" });
                        scope.sessionId = result.sessionId;
                        if (ref) ref.sessionId = result.sessionId;
                        scope.preambleSent = false;
                        updateScopeSettings(result);
                        if (scopeMgr && scopeKey) scopeMgr.setActive(scopeKey);
                        reply(`🔄 Started a new session for ${scopeLabel}.`);
                    } else {
                        reply("🚀 Starting Copilot...");
                        await ctx.startCopilot?.();
                        scope.sessionId = acp?.sessionId || null;
                        if (ref) ref.sessionId = scope.sessionId;
                        if (scopeMgr && scopeKey) scopeMgr.setActive(scopeKey);
                        reply(`✅ New session ready for ${scopeLabel}.`);
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
                    "  /session new — new session for this conversation\n" +
                    "  /session stop — stop Copilot"
                );
                return true;
            }
            case "stop":
            case "cancel": {
                if (!acp?.alive) { reply("⚠️ Copilot not running"); return true; }
                if (!scopeMgr || !bridge?.promptActive || scopeMgr.activeScope !== scope) {
                    reply("⚠️ No active request in this conversation.");
                    return true;
                }
                try {
                    await acp.cancel();
                    reply("🛑 Cancelled current operation");
                } catch (err) {
                    reply(`⚠️ Cancel failed: ${err.message}`);
                }
                return true;
            }
            case "retry": {
                if (!scopeHistory) { reply("⚠️ No history available"); return true; }
                const lastUser = scopeHistory.getLastUserMessage();
                if (!lastUser) { reply("⚠️ No previous message to retry"); return true; }
                // Cancel current operation if it belongs to this scope, then resend
                if (acp?.alive && bridge?.promptActive && (!scopeMgr || scopeMgr.activeScope === scope)) {
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
                if (!scopeHistory) { reply("📜 No history available"); return true; }
                const n = parseInt(args) || 10;
                const formatted = scopeHistory.format(Math.min(n, 30));
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
                lines.push("  /autopilot /plan /fleet /stop /retry");
                lines.push("  /usage /session /clear");

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
                            { text: "📋 Plan", callback_data: "/plan" },
                            { text: "🚀 Fleet", callback_data: "/fleet" },
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
                    "  /fleet — parallel agent mode\n" +
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
                    "  /clear — reset conversation\n" +
                    "  /close — close current topic\n" +
                    "  /sessions — list scopes\n" +
                    "  /pair — pairing info\n" +
                    "  /allowall [on|off] — toggle tool auto-approve for this conversation\n" +
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
                if (promptActive) { reply("⏳ Copilot is busy — wait for it to finish before creating a new session."); return true; }
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
                if (!scopeMgr) { reply("📋 No scopes available."); return true; }
                const sessions = scopeMgr.list().sort((a, b) => b.lastActivity - a.lastActivity);
                if (sessions.length === 0) {
                    reply("📋 No scopes yet.");
                    return true;
                }
                const stats = scopeMgr.stats();
                const activeKey = scopeMgr.activeScope?.key;
                const lines = [`📋 Scopes (${stats.total} total):\n`];
                for (const s of sessions) {
                    const type = s.key.startsWith("forum:") ? "Forum" : s.key.startsWith("group:") ? "Group" : "DM";
                    const status = s.key === activeKey ? "▶️" : s.sessionId ? "💬" : "🆕";
                    const details = [];
                    if (s.sessionId) details.push(`${s.sessionId.slice(0, 8)}…`);
                    if (s.model) details.push(s.model);
                    if (s.mode) details.push(s.mode);
                    lines.push(`${status} ${type} — ${s.key}`);
                    if (details.length > 0) lines.push(`   ${details.join(" · ")}`);
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
                if (!scope || !bridge) { reply("⚠️ Not available"); return true; }
                const enabled = (args === "off" || args === "false") ? false
                    : (args === "on" || args === "true") ? true
                    : !scope.allowAll;
                scope.allowAll = enabled;
                bridge.resetPreamble();
                reply(enabled
                    ? `🔓 Allow-all ON for ${scopeLabel}`
                    : `🔐 Allow-all OFF for ${scopeLabel}`);
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
            case "clear": {
                // Alias for /session new — familiar to CLI users
                if (!scope) { reply("⚠️ Scope not available"); return true; }
                if (promptActive) { reply("⏳ Copilot is busy with another request. Try again shortly."); return true; }
                scope.reset();
                scope.sessionId = null;
                scope.model = "";
                scope.mode = "";
                if (ref) ref.sessionId = null;
                if (acp?.alive) {
                    const result = await acp.newSession({ cwd: config?.workingDirectory || "/config" });
                    scope.sessionId = result.sessionId;
                    if (ref) ref.sessionId = result.sessionId;
                    scope.preambleSent = false;
                    updateScopeSettings(result);
                    if (scopeMgr && scopeKey) scopeMgr.setActive(scopeKey);
                    reply(`🔄 Session cleared for ${scopeLabel}.`);
                } else {
                    reply("🚀 Starting Copilot...");
                    await ctx.startCopilot?.();
                    scope.sessionId = acp?.sessionId || null;
                    if (ref) ref.sessionId = scope.sessionId;
                    if (scopeMgr && scopeKey) scopeMgr.setActive(scopeKey);
                    reply(`✅ New session ready for ${scopeLabel}.`);
                }
                return true;
            }
            case "standing": {
                const orch = bridge?.standingOrchestrator;
                if (!orch) {
                    reply("⚠️ Standing instructions not available");
                    return true;
                }
                const mgr = orch.manager;
                const sub = args.split(/\s+/)[0]?.toLowerCase();

                if (sub === "enable" || sub === "disable") {
                    const id = args.split(/\s+/)[1];
                    if (!id) { reply(`⚠️ Usage: /standing ${sub} <id|all>`); return true; }
                    if (id === "all") {
                        const all = mgr.list();
                        let count = 0;
                        for (const inst of all) {
                            if (sub === "enable" && !inst.enabled) { mgr.enable(inst.id); count++; }
                            if (sub === "disable" && inst.enabled) { mgr.disable(inst.id); count++; }
                        }
                        reply(`${sub === "enable" ? "✅" : "⏸️"} ${count} instruction(s) ${sub}d`);
                        return true;
                    }
                    const match = mgr.list().find(i => i.id === id || i.id.startsWith(id));
                    if (!match) { reply(`❌ Instruction not found: ${id}`); return true; }
                    const result = sub === "enable" ? mgr.enable(match.id) : mgr.disable(match.id);
                    if (!result) { reply(`❌ Instruction not found: ${id}`); return true; }
                    reply(`${sub === "enable" ? "✅" : "⏸️"} "${result.description}" ${sub}d`);
                    return true;
                }

                if (sub === "delete" || sub === "remove") {
                    const id = args.split(/\s+/)[1];
                    if (!id) { reply(`⚠️ Usage: /standing delete <id|all>`); return true; }
                    if (id === "all") {
                        const all = mgr.list();
                        for (const inst of all) mgr.delete(inst.id);
                        reply(`🗑️ Deleted all ${all.length} instruction(s)`);
                        return true;
                    }
                    const match = mgr.list().find(i => i.id === id || i.id.startsWith(id));
                    if (!match) { reply(`❌ Instruction not found: ${id}`); return true; }
                    mgr.delete(match.id);
                    reply(`🗑️ Deleted: "${match.description}"`);
                    return true;
                }

                if (sub === "pause") {
                    orch.pause();
                    reply("⏸️ Standing instructions paused. Use /standing resume to re-enable.");
                    return true;
                }

                if (sub === "resume") {
                    orch.resume();
                    reply("▶️ Standing instructions resumed.");
                    return true;
                }

                if (sub === "mute") {
                    const durationStr = args.split(/\s+/)[1];
                    const minutes = parseDuration(durationStr);
                    if (!minutes) {
                        reply("⚠️ Usage: /standing mute <duration>\nExamples: /standing mute 30m, /standing mute 2h");
                        return true;
                    }
                    orch.mute(minutes * 60 * 1000);
                    const until = new Date(Date.now() + minutes * 60000).toLocaleTimeString();
                    reply(`🔇 Standing instructions muted until ${until}`);
                    return true;
                }

                // Default: list all
                const instructions = mgr.list();
                const st = orch.status();
                const uptimeStr = formatUptime(st.uptime);

                if (instructions.length === 0) {
                    let text = `📋 Standing Instructions\n\n`;
                    text += `📡 HA Events: ${st.haConnected ? "🟢 connected" : "🔴 disconnected"}\n`;
                    text += `⏱️ Uptime: ${uptimeStr}\n`;
                    text += `🎯 Triggers fired: ${st.triggerCount}\n\n`;
                    text += `No instructions registered.\nThe agent can create them during conversations.`;
                    reply(text);
                    return true;
                }

                let text = `📋 Standing Instructions (${st.enabled}/${st.total} active)\n`;
                text += `📡 HA Events: ${st.haConnected ? "🟢" : "🔴"} | ⏱️ ${uptimeStr} | 🎯 ${st.triggerCount} fired\n`;
                if (st.paused) {
                    text += `⏸️ PAUSED\n`;
                } else if (st.mutedUntil && Date.now() < st.mutedUntil) {
                    text += `🔇 Muted until ${new Date(st.mutedUntil).toLocaleTimeString()}\n`;
                }
                text += `\n`;
                for (const inst of instructions) {
                    const status = inst.enabled ? "✅" : "⏸️";
                    const triggerDesc = inst.trigger.type === "state_change"
                        ? `${Array.isArray(inst.trigger.entity_id) ? inst.trigger.entity_id.join(", ") : inst.trigger.entity_id}`
                        : inst.trigger.type === "cron"
                            ? `cron: ${inst.trigger.expression}`
                            : `timer: ${inst.trigger.fire_at}`;
                    const lastFired = inst.last_triggered_at
                        ? `\n   Last: ${new Date(inst.last_triggered_at).toLocaleString()}`
                        : "";
                    const expiryInfo = inst.expires_at
                        ? `\n   Expires: ${new Date(inst.expires_at).toLocaleString()}`
                        : "";
                    text += `${status} ${escapeHtml(inst.description)}\n`;
                    text += `   ${inst.action.type} | ${escapeHtml(triggerDesc)}${lastFired}${expiryInfo}\n`;
                    text += `   ID: <code>${escapeHtml(inst.id)}</code>\n\n`;
                }
                text += `Commands: /standing pause|resume|mute|enable|disable|delete &lt;id|all&gt;`;
                telegram.enqueue(() => telegram.sendMessage(chatId, text, "HTML"));
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

function parseDuration(str) {
    if (!str) return null;
    const match = str.match(/^(\d+)\s*(m|min|h|hr|hrs|hour|hours)?$/i);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = (match[2] || "m").toLowerCase();
    return unit.startsWith("h") ? value * 60 : value;
}

function formatUptime(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "unknown";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
