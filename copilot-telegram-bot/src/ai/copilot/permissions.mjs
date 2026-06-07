// ============================================================
// PermissionHandler — ACP permission request handling
// ============================================================
// Extracted from bridge.mjs (Phase 4). Handles permission_request
// events including auto-approve policies and plan approval.

import { createLogger } from "../../logger.mjs";

const log = createLogger('permissions');

// --- Callback user ID encoding/decoding utilities ---
// Used by permissions, tool notifications, and the main callback handler.

/** Encode a numeric userId for compact callback_data embedding. */
export function encodeCallbackUserId(userId) {
    const numericUserId = Number(userId);
    return Number.isSafeInteger(numericUserId) ? numericUserId.toString(36) : null;
}

/** Extract the target userId from a btn:-prefixed callback_data string. */
export function extractCallbackTargetUserId(data) {
    if (!data?.startsWith("btn:")) return null;
    const value = data.split(":").slice(2).join(":");
    const [kind, encodedUserId] = value.split(":");
    if ((kind !== "perm" && kind !== "undo") || !encodedUserId) return null;
    const numericUserId = Number.parseInt(encodedUserId, 36);
    return Number.isSafeInteger(numericUserId) ? numericUserId : null;
}

/** Unwrap a perm:-prefixed selection value to the raw optionId. */
export function unwrapPermissionSelection(value) {
    if (!value?.startsWith("perm:")) return value;
    const parts = value.split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") : value;
}

export class PermissionHandler {
    #buttons;
    #getAllowedChatIds;
    #rbac;

    /**
     * @param {object} opts
     * @param {object} opts.buttons - ButtonManager instance
     * @param {Function} opts.getAllowedChatIds - returns allowed chat IDs array
     * @param {object} [opts.rbac] - RBACManager instance for role-based permission checks
     */
    constructor({ buttons, getAllowedChatIds, rbac }) {
        this.#buttons = buttons;
        this.#getAllowedChatIds = getAllowedChatIds;
        this.#rbac = rbac || null;
    }

    /** Handle a permission_request event from ACP. */
    async handlePermissionRequest(req, acp, scope, getRef, tag) {
        log.info(`Permission request [${tag}]: ${req.toolCall?.name || req.tool || 'unknown'}`);
        const { requestId } = req;

        // Extract tool identification from the new session/request_permission format
        const toolCall = req.toolCall || {};
        const rawInput = toolCall.rawInput || {};
        const toolTitle = toolCall.title || "";
        const domain = rawInput.domain || "";
        const service = rawInput.service || "";
        const entityId = rawInput.entity_id || "";
        const tool = domain && service ? `ha_${domain}_${service}` :
                     toolTitle.toLowerCase().includes("call service") ? "ha_call_service" :
                     req.toolName || req.tool || req.name || "unknown_tool";
        const desc = entityId ? `${domain}.${service} → ${entityId}` :
                     toolTitle || "";

        // Plan approval / mode switch — special UX with dynamic option buttons
        if (toolCall.kind === "switch_mode") {
            await this.handlePlanApproval(req, acp, scope, getRef, tag);
            return;
        }

        // --- RBAC permission check (absolute barrier) ---
        // Must come before allowAll — role denials cannot be bypassed.
        if (this.#rbac) {
            const ref = getRef();
            const userId = ref?.userId;
            if (userId) {
                // Determine canonical tool name for RBAC lookup
                const rbacTool = toolCall.name || (domain && service ? "ha_call_service" : req.toolName || req.tool || req.name || "unknown_tool");
                const rbacArgs = { domain, entity_id: entityId };
                const rbacResult = this.#rbac.checkToolPermission(userId, rbacTool, rbacArgs);

                if (!rbacResult.allowed) {
                    const options = req.options || [];
                    const rejectId = options.find(o => o.kind === "reject_once")?.optionId || "reject_once";
                    acp.respondPermission(requestId, rejectId);
                    log.info(`Permission DENIED (RBAC): ${tool} for user ${userId} — ${rbacResult.reason} (cap: ${rbacResult.capability})`);
                    return;
                }
            }
        }

        // Allow-all mode: skip all permission prompts
        if (scope.allowAll) {
            const options = req.options || [];
            const allowId = options.find(o => o.kind === "allow_always")?.optionId || "allow_always";
            acp.respondPermission(requestId, allowId);
            log.info(`Permission auto-approved (allow-all mode): ${tool} (${desc})`);
            return;
        }

        // Policy: auto-approve read-only HA tools + standard copilot tools
        const readOnlyTools = new Set([
            "ha_search_entities", "ha_get_state", "ha_get_history",
            "ha_deep_search", "ha_get_overview", "ha_get_entity_state",
            "ha_search_automations", "ha_get_automation",
        ]);
        const isReadOnly = readOnlyTools.has(tool) || !tool.startsWith("ha_");

        const options = req.options || [];
        const findOption = (kind) => options.find(o => o.kind === kind)?.optionId;
        const allowOnceId = findOption("allow_once") || "allow_once";
        const allowAlwaysId = findOption("allow_always") || "allow_always";
        const rejectOnceId = findOption("reject_once") || "reject_once";

        // Per-user per-scope grants
        const ref = getRef();
        const userId = ref?.userId;
        if (isReadOnly || (userId && scope.isToolGranted(userId, tool))) {
            acp.respondPermission(requestId, allowAlwaysId);
            log.info(`Permission auto-approved: ${tool} (${desc})`);
            return;
        }

        // Ask user via inline buttons
        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#getAllowedChatIds()?.[0];
        if (!chatId || !this.#buttons) {
            acp.respondPermission(requestId, rejectOnceId);
            log.info(`Permission denied (no chat): ${tool}`);
            return;
        }

        const label = desc ? `${tool}\n${desc}` : tool;
        const encodedUserId = encodeCallbackUserId(targetRef?.userId);
        const allowOnceValue = encodedUserId ? `perm:${encodedUserId}:${allowOnceId}` : allowOnceId;
        const allowAlwaysValue = encodedUserId ? `perm:${encodedUserId}:${allowAlwaysId}` : allowAlwaysId;
        const rejectOnceValue = encodedUserId ? `perm:${encodedUserId}:${rejectOnceId}` : rejectOnceId;
        const rows = [
            [
                { text: "✅ Allow once", value: allowOnceValue },
                { text: "✅ Always allow", value: allowAlwaysValue },
                { text: "❌ Deny", value: rejectOnceValue },
            ],
        ];
        if (scope.composer) scope.composer.setInteractionPending("permission");
        let selected, permMsgId;
        try {
            ({ value: selected, messageId: permMsgId } = await this.#buttons.prompt(
                chatId,
                `🔐 Permission request:\n${label}`,
                rows,
                { timeoutMs: 0 }
            ));
        } finally {
            if (scope.composer) scope.composer.setInteractionPending(null);
        }

        const selectedOption = unwrapPermissionSelection(selected);
        if (selectedOption === allowOnceId || selectedOption === allowAlwaysId) {
            if (selectedOption === allowAlwaysId && userId) {
                scope.grantTool(userId, tool);
            }
            acp.respondPermission(requestId, selectedOption);
            log.info(`Permission granted (${selectedOption}): ${tool}`);
            if (permMsgId) {
                try {
                    await this.#buttons.finalize(chatId, permMsgId, `✅ Allowed: ${desc || tool}`);
                } catch (err) {
                    log.warn(`Error finalizing allow message: ${err.message}`);
                }
            }
        } else {
            acp.respondPermission(requestId, rejectOnceId);
            log.info(`Permission denied: ${tool} (permMsgId=${permMsgId})`);
            try {
                if (permMsgId) {
                    log.debug(`Finalizing deny message: chat=${chatId} msg=${permMsgId}`);
                    await this.#buttons.finalize(chatId, permMsgId, `❌ Denied: ${desc || tool}`);
                } else {
                    log.warn(`No permMsgId for deny feedback`);
                }
            } catch (err) {
                log.warn(`Error finalizing deny message: ${err.message}`);
            }
        }
    }

    /** Handle plan approval (switch_mode permission requests). */
    async handlePlanApproval(req, acp, scope, getRef, tag) {
        const { requestId } = req;
        const toolCall = req.toolCall || {};
        const toolTitle = toolCall.title || "";
        const options = req.options || [];

        if (options.length === 0) {
            log.warn('Plan approval: no options provided');
            acp.respondPermission(requestId, "reject_once");
            return;
        }
        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#getAllowedChatIds()?.[0];
        if (!chatId || !this.#buttons) {
            const fallbackId = options.find(o => o.kind === "allow_once")?.optionId || options[0]?.optionId;
            if (fallbackId) acp.respondPermission(requestId, fallbackId);
            return;
        }

        // Extract plan content from toolCall.content
        let planSummary = "";
        if (Array.isArray(toolCall.content)) {
            for (const c of toolCall.content) {
                const text = c?.content?.text || c?.text || "";
                if (text) planSummary += (planSummary ? "\n" : "") + text;
            }
        }

        const header = toolTitle || "📋 Ready for implementation";
        const maxSummary = 3800 - header.length;
        if (planSummary.length > maxSummary) planSummary = planSummary.slice(0, maxSummary) + "…";
        const label = planSummary
            ? `📋 ${header}\n\n${planSummary}`
            : `📋 ${header}`;

        // Build buttons from dynamic options — one per row for clarity
        const encodedUserId = encodeCallbackUserId(targetRef?.userId);
        const rows = options.map(opt => {
            const icon = opt.kind === "reject_once" || opt.kind === "reject_always" ? "❌"
                       : opt.kind === "allow_always" ? "🚀"
                       : "✅";
            const val = encodedUserId ? `perm:${encodedUserId}:${opt.optionId}` : opt.optionId;
            return [{ text: `${icon} ${opt.name}`, value: val }];
        });

        if (scope.composer) scope.composer.setInteractionPending("plan");
        let selected, permMsgId;
        try {
            ({ value: selected, messageId: permMsgId } = await this.#buttons.prompt(
                chatId, label, rows,
                { timeoutMs: 0, timeoutText: "📋 Plan approval cancelled" }
            ));
        } finally {
            if (scope.composer) scope.composer.setInteractionPending(null);
        }

        const selectedOption = unwrapPermissionSelection(selected);
        if (selectedOption) {
            acp.respondPermission(requestId, selectedOption);
            const chosenName = options.find(o => o.optionId === selectedOption)?.name || selectedOption;
            log.info(`Plan approval: ${chosenName}`);
            if (permMsgId) {
                try {
                    await this.#buttons.finalize(chatId, permMsgId, `📋 ${chosenName}`);
                } catch {}
            }
        } else {
            const rejectId = options.find(o => o.kind === "reject_once")?.optionId || "reject_once";
            acp.respondPermission(requestId, rejectId);
            log.info(`Plan approval cancelled/timed out`);
        }
    }
}
