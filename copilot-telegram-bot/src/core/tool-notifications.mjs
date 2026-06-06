// ============================================================
// ToolNotifications — tool result display and undo buttons
// ============================================================
// Extracted from bridge.mjs (Phase 4). Shows notifications for
// HA write operations with optional undo buttons.

import { encodeCallbackUserId } from "../ai/copilot/permissions.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger('tool-notify');

const UNDO_ALLOWED_DOMAINS = new Set([
    "light", "switch", "fan", "cover", "lock", "climate",
    "media_player", "input_boolean", "automation", "script", "scene",
]);
const UNDO_ALLOWED_SERVICES = new Set([
    "turn_on", "turn_off", "toggle",
    "open_cover", "close_cover",
    "lock", "unlock",
    "set_temperature", "activate", "deactivate",
]);
const UNDO_ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const UNDO_REVERSE_MAP = Object.freeze({
    "turn_on": "turn_off",
    "turn_off": "turn_on",
    "open_cover": "close_cover",
    "close_cover": "open_cover",
    "lock": "unlock",
    "unlock": "lock",
    "activate": "deactivate",
    "deactivate": "activate",
});

export class ToolNotifications {
    #buttons;
    #telegram;
    #getAllowedChatIds;
    #getActiveScope;
    #getActiveRef;
    #queuePrompt;

    /**
     * @param {object} opts
     * @param {object} opts.buttons - ButtonManager instance
     * @param {object} opts.telegram - TelegramClient instance
     * @param {Function} opts.getAllowedChatIds - returns allowed chat IDs array
     * @param {Function} opts.getActiveScope - returns current active scope
     * @param {Function} opts.getActiveRef - returns current active ref
     * @param {Function} opts.queuePrompt - callback to queue a prompt (text, opts, ref, messageId)
     */
    constructor({ buttons, telegram, getAllowedChatIds, getActiveScope, getActiveRef, queuePrompt }) {
        this.#buttons = buttons;
        this.#telegram = telegram;
        this.#getAllowedChatIds = getAllowedChatIds;
        this.#getActiveScope = getActiveScope;
        this.#getActiveRef = getActiveRef;
        this.#queuePrompt = queuePrompt;
    }

    /** Check if a domain/service/entityId combination is safe to undo. */
    isSafeUndoAction(domain, service, entityId) {
        return typeof domain === "string"
            && typeof service === "string"
            && typeof entityId === "string"
            && UNDO_ALLOWED_DOMAINS.has(domain)
            && UNDO_ALLOWED_SERVICES.has(service)
            && UNDO_ENTITY_ID_RE.test(entityId);
    }

    /** Show a tool notification for HA write operations, with optional undo button. */
    showToolNotification(toolName, result, getScope, getRef) {
        const scope = getScope ? getScope() : this.#getActiveScope();
        log.debug(`Tool notification check: ${toolName}, allowAll=${scope?.allowAll}`);

        // Only notify for HA write tools
        const writeTools = new Set([
            "ha-mcp-ha_call_service", "ha-mcp-ha_call_event",
            "ha-mcp-ha_bulk_control", "ha-mcp-ha_backup_create",
            "ha-mcp-ha_backup_restore", "ha-mcp-ha_remove_entity",
            "ha-mcp-ha_config_set_automation",
        ]);
        if (!writeTools.has(toolName)) {
            log.debug(`Tool notification skipped: ${toolName} not a write tool`);
            return;
        }

        // Parse result to build notification — handle multiple formats
        let content;
        try {
            let raw;
            if (typeof result === "string") {
                raw = result;
            } else if (typeof result?.content === "string") {
                raw = result.content;
            } else if (Array.isArray(result)) {
                // ACP content blocks array: [{type:"content", content:{type:"text", text:"..."}}]
                const textBlock = result.find(b => b?.content?.type === "text");
                raw = textBlock?.content?.text || JSON.stringify(result);
            } else {
                raw = JSON.stringify(result);
            }
            content = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {
            log.debug(`Tool notification parse error: ${e.message}`);
            content = {};
        }

        const domain = content?.domain || "";
        const service = content?.service || "";
        const entityId = content?.entity_id || "";
        const success = content?.success !== false;

        log.debug(`Tool notification parsed: ${domain}.${service} → ${entityId} success=${success}`);

        if (!domain && !service) return;

        const emoji = success ? "⚡" : "❌";
        const action = `${domain}.${service}`;
        const target = entityId ? ` → ${entityId}` : "";
        const text = `${emoji} ${action}${target}`;

        // Determine undo action (reversible services)
        const reverseService = UNDO_REVERSE_MAP[service];

        const ref = getRef ? getRef() : this.#getActiveRef();
        const undoRef = ref ? {
            ...ref,
            scopeKey: ref.scopeKey || (getScope ? getScope() : this.#getActiveScope())?.key || null,
        } : null;
        const chatId = undoRef?.chatId || this.#getAllowedChatIds()?.[0];
        if (!chatId) return;

        if (success && this.isSafeUndoAction(domain, reverseService, entityId)) {
            // Show with undo button
            const encodedUserId = encodeCallbackUserId(undoRef?.userId);
            const undoValue = encodedUserId ? `undo:${encodedUserId}` : "undo";
            const rows = [[
                { text: "↩️ Undo", value: undoValue },
                { text: "✅ OK", value: "dismiss" },
            ]];
            log.info(`Sending undo notification to chat ${chatId}: ${text}`);
            this.#buttons.prompt(chatId, text, rows, {
                timeoutMs: 30000,
                timeoutText: null, // silently expire
            }).then(({ value: selected }) => {
                if (selected !== undoValue || !undoRef) return;

                log.info(`Undo: ${domain}.${reverseService} → ${entityId}`);
                this.#queuePrompt(
                    `Please call service ${domain}.${reverseService} on entity ${entityId} to undo the previous action. Do it immediately without asking.`,
                    {}, undoRef, null
                );
            }).catch(err => {
                log.error(`Tool notification error: ${err.message}`);
            });
        } else {
            // Just show notification (no undo available)
            const extra = ref?.threadId ? { message_thread_id: ref.threadId } : {};
            this.#telegram.enqueue(() =>
                this.#telegram.call("sendMessage", { chat_id: chatId, text, disable_notification: true, ...extra })
            );
        }
    }
}
