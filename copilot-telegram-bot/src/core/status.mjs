// ============================================================
// StatusMenu — Copilot status display and refresh
// ============================================================
// Extracted from bridge.mjs (Phase 3). Manages the singleton
// status menu message with auto-refresh capability.

import { normalizeModeId } from "../ai/copilot/acp-client.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger('status');
const STATUS_TTL_MS = 5 * 60 * 1000; // 5 min expiry

export class StatusMenu {
    #telegram;
    #acp;
    #config;
    #scopeMgr;
    #getActiveScope;
    #getModels;
    #getModes;
    #getAllowedChatIds;
    #getPairing;
    #getStandingOrchestrator;

    // Mutable state — public for Bridge callback handler access
    statusMsg = null;       // { chatId, messageId, createdAt, scopeKey }
    refreshPaused = false;  // true during intentional restart

    /**
     * @param {object} opts
     * @param {object} opts.telegram - TelegramClient instance
     * @param {object} opts.acp - ACP client instance
     * @param {object} opts.config - Bot config
     * @param {object} opts.scopeMgr - ScopeManager instance
     * @param {Function} opts.getActiveScope - returns current active scope
     * @param {Function} opts.getModels - returns available models array
     * @param {Function} opts.getModes - returns available modes array
     * @param {Function} opts.getAllowedChatIds - returns allowed chat IDs array
     * @param {Function} opts.getPairing - returns PairingManager or null
     * @param {Function} opts.getStandingOrchestrator - returns StandingInstructionOrchestrator or null
     */
    constructor({ telegram, acp, config, scopeMgr, getActiveScope, getModels, getModes, getAllowedChatIds, getPairing, getStandingOrchestrator }) {
        this.#telegram = telegram;
        this.#acp = acp;
        this.#config = config;
        this.#scopeMgr = scopeMgr;
        this.#getActiveScope = getActiveScope;
        this.#getModels = getModels;
        this.#getModes = getModes;
        this.#getAllowedChatIds = getAllowedChatIds;
        this.#getPairing = getPairing;
        this.#getStandingOrchestrator = getStandingOrchestrator;
    }

    /** Show the status menu in a chat, dismissing any previous one. */
    async show(chatId, scope = null) {
        // Dismiss old status message if exists
        await this.dismiss(chatId);

        const requestedScope = scope || this.#getActiveScope() || this.#scopeMgr?.activeScope || null;
        const { text, buttons } = this.buildContent(requestedScope);
        const sent = await this.#telegram.sendMessage(chatId, text, undefined, buttons);
        if (sent?.message_id) {
            this.statusMsg = {
                chatId,
                messageId: sent.message_id,
                createdAt: Date.now(),
                scopeKey: requestedScope?.key || null,
            };
        }
    }

    /** Edit the existing status menu if it's still fresh. Called on state changes. */
    async refreshIfAlive() {
        if (!this.statusMsg) {
            log.debug("Status refresh: no active status message");
            return;
        }
        if (this.refreshPaused) {
            log.debug("Status refresh: paused (restart in progress)");
            return;
        }
        if (Date.now() - this.statusMsg.createdAt > STATUS_TTL_MS) {
            log.debug("Status refresh: expired");
            this.statusMsg = null;
            return;
        }
        const scope = this.statusMsg.scopeKey ? this.#scopeMgr?.get(this.statusMsg.scopeKey) : null;
        const { text, buttons } = this.buildContent(scope);
        const firstLine = text.split("\n")[0];
        log.debug(`Status refresh: updating to "${firstLine}" (msgId=${this.statusMsg.messageId})`);
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: this.statusMsg.chatId,
                message_id: this.statusMsg.messageId,
                text,
                reply_markup: buttons,
            });
            log.debug("Status refresh: edit succeeded");
        } catch (err) {
            if (/message is not modified/i.test(err?.message)) {
                log.debug("Status refresh: no change needed");
                return;
            }
            log.warn(`Status refresh: edit failed — ${err.message}`);
            this.statusMsg = null; // message gone
        }
    }

    /** Delete the current status message. */
    async dismiss(chatId) {
        if (!this.statusMsg) return;
        try {
            await this.#telegram.call("deleteMessage", {
                chat_id: this.statusMsg.chatId,
                message_id: this.statusMsg.messageId,
            });
        } catch {}
        this.statusMsg = null;
    }

    /** Build the status content text and inline keyboard buttons. */
    buildContent(requestedScope = null) {
        const alive = this.#acp?.alive;
        const hasSession = !!this.#acp?.sessionId;
        const ready = alive && hasSession;
        const scope = requestedScope || this.#getActiveScope() || this.#scopeMgr?.activeScope;
        const scopeType = scope?.key?.startsWith("forum:") ? "Forum"
            : scope?.key?.startsWith("group:") ? "Group"
            : "DM";
        const scopeSessionId = scope?.sessionId || this.#acp?.sessionId || null;
        const models = this.#getModels();
        const modes = this.#getModes();
        const allowedChatIds = this.#getAllowedChatIds();
        const pairing = this.#getPairing();
        const standingOrchestrator = this.#getStandingOrchestrator();

        const lines = [];
        lines.push(ready ? "✅ Copilot Ready" : alive ? "⏳ Copilot Starting..." : "⏹️ Copilot Stopped");
        if (this.#config?.version) lines.push(`📦 Version: ${this.#config.version}`);
        lines.push("");

        if (scope) {
            lines.push(`🗂️ Scope: ${scopeType}`);
            lines.push(`🔑 Scope key: ${scope.key}`);
        }

        if (ready) {
            const currentModel = scope?.model || "";
            const currentMode = scope?.mode || "";
            const modelName = models?.find(m => m.modelId === currentModel)?.name || currentModel || "unknown";
            const modeName = modes?.find(m => normalizeModeId(m.id) === currentMode)?.name || currentMode || "unknown";
            const modeIcon = currentMode === "autopilot" ? "🟢" : currentMode === "plan" ? "📝" : "💬";
            lines.push(`🤖 Model: ${modelName}`);
            lines.push(`${modeIcon} Mode: ${modeName}`);
            lines.push(`🔗 Session: ${scopeSessionId ? `${scopeSessionId.slice(0, 8)}…` : "none"}`);
            lines.push(`📊 Models available: ${models?.length || 0}`);
        }

        const scopeAllowAll = scope?.allowAll ?? false;
        if (scopeAllowAll) {
            lines.push(`🔓 Permissions: allow-all`);
        } else {
            lines.push(`🔐 Permissions: interactive`);
        }

        // HA integration status
        if (this.#config?.haConnected) {
            lines.push(`🏠 HA API: ✅ ${this.#config.haVersion || "connected"}`);
        } else {
            lines.push(`🏠 HA API: ❌ unavailable`);
        }
        if (this.#config?.mcpServers?.length > 0) {
            lines.push(`🔌 MCP: ${this.#config.mcpServers.length} server(s)`);
        }

        // Standing instructions status
        if (standingOrchestrator) {
            const mgr = standingOrchestrator.manager;
            const instructions = mgr.list();
            const enabled = instructions.filter(i => i.enabled).length;
            const haWs = standingOrchestrator.eventListener.connected ? "🟢" : "🔴";
            lines.push(`📡 HA Events: ${haWs} | Standing: ${enabled}/${instructions.length} active`);
        }

        lines.push(`📱 Telegram: connected`);
        lines.push(`👥 Chats: ${allowedChatIds.length}`);
        if (pairing) {
            lines.push(`🔐 Paired users: ${pairing.getPairedUsers().length}`);
        }
        if (this.#scopeMgr) {
            const stats = this.#scopeMgr.stats();
            lines.push(`🗂️ Scopes: ${stats.total} (${stats.dm} DM, ${stats.group} group, ${stats.forum} forum)`);
        }
        if (scope?.history) lines.push(`📜 History: ${scope.history.length} messages`);

        const currentMode = scope?.mode || "";
        const modeButtonIcon = currentMode === "autopilot" ? "🟢" : currentMode === "plan" ? "📝" : "💬";
        const modeButtonLabel = currentMode && currentMode !== "interactive"
            ? `${modeButtonIcon} ${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)}`
            : `${modeButtonIcon} Mode`;

        const statusButtons = {
            inline_keyboard: ready ? [
                [
                    { text: "🤖 Model", callback_data: "/model" },
                    { text: modeButtonLabel, callback_data: "/mode" },
                ],
                [
                    { text: "📊 Usage", callback_data: "/usage" },
                    { text: "🗜️ Compact", callback_data: "/compact" },
                ],
                [
                    { text: scopeAllowAll ? "\u{1F512} Allow-all OFF" : "\u{1F513} Allow-all ON",
                      callback_data: scopeAllowAll ? "/allowall off" : "/allowall on" },
                    { text: "📡 Standing", callback_data: "/standing" },
                ],
                [
                    { text: "🔄 Restart", callback_data: "/session new" },
                    { text: "⏹️ Stop", callback_data: "/session stop" },
                ],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ] : alive ? [
                [{ text: "🔄 Refresh", callback_data: "/status" }],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ] : [
                [{ text: "🚀 Start Copilot", callback_data: "/session new" }],
                [
                    { text: "📋 Changelog", callback_data: "changelog" },
                    { text: "✕ Dismiss", callback_data: "dismiss" },
                ],
            ],
        };

        return { text: lines.join("\n"), buttons: statusButtons };
    }

    /** Edit status message for shutdown notification. Returns a promise or null. */
    async handleShutdown() {
        if (!this.statusMsg) return;
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: this.statusMsg.chatId,
                message_id: this.statusMsg.messageId,
                text: "⏹️ Copilot Stopped\n\nAdd-on was shut down.",
                reply_markup: { inline_keyboard: [] },
            });
        } catch {}
        this.statusMsg = null;
    }
}
