import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { SAFE_DOMAINS, SENSITIVE_DOMAINS } from "./rbac.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("approval-service");
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const READ_ONLY_TOOLS = new Set([
    "ha_search_entities", "ha_get_state", "ha_get_history",
    "ha_deep_search", "ha_get_overview", "ha_get_entity_state",
    "ha_search_automations", "ha_get_automation",
    "list_agents", "read_agent",
    "web_fetch", "web_search", "recall",
]);

export class ApprovalService extends EventEmitter {
    #telegram;
    #store;
    #rbac;
    #getPermissionPolicy;
    #isWebuiOperator;
    #pending = new Map(); // approvalId -> pending

    constructor({ telegram, store, rbac, getPermissionPolicy, isWebuiOperator }) {
        super();
        this.#telegram = telegram;
        this.#store = store;
        this.#rbac = rbac || null;
        this.#getPermissionPolicy = getPermissionPolicy || (() => "interactive");
        this.#isWebuiOperator = isWebuiOperator || (() => false);
    }

    close() {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
        }
        this.#pending.clear();
    }

    async handlePermissionRequest({ conversation, scopeKey, ...request }) {
        if (!conversation?.acp) return;

        const approval = this.#buildApproval({ conversation, scopeKey, request });
        const allowAll = this.#getPermissionPolicy() === "allow_all";

        if (approval.actorType === "system" && !approval.isReadOnly) {
            return this.#rejectWithoutPrompt(approval, "system_restricted");
        }

        if (approval.actorType === "telegram" && this.#rbac) {
            const rbacResult = this.#rbac.checkToolPermission(Number(approval.actorId), approval.rbacToolName, approval.rbacArgs);
            if (!rbacResult.allowed) {
                return this.#rejectWithoutPrompt(approval, "rbac_deny", {
                    reason: rbacResult.reason,
                    capability: rbacResult.capability,
                });
            }
        }

        if (approval.actorType === "webui" && !approval.isReadOnly && !this.#isWebuiOperator(approval.actorId)) {
            return this.#rejectWithoutPrompt(approval, "webui_restricted");
        }

        if (approval.isPlanApproval) {
            return this.#promptApproval(approval);
        }

        if (allowAll) {
            return this.#resolveApproval(approval, this.#findOptionId(approval.options, ["allow_always", "allow_once"]), "allow_all_mode");
        }

        if (approval.isReadOnly) {
            return this.#resolveApproval(approval, this.#findOptionId(approval.options, ["allow_once", "allow_always"]) || "allow_once", "read_only");
        }

        if (approval.userGrantId && this.#store.hasScopeGrant(approval.scopeKey, approval.userGrantId, approval.grantKey)) {
            return this.#resolveApproval(approval, this.#findOptionId(approval.options, ["allow_always", "allow_once"]) || "allow_always", "existing_grant");
        }

        return this.#promptApproval(approval);
    }

    async handleTelegramCallback(query) {
        const data = query?.data || "";
        if (!data.startsWith("permreq:")) return false;

        const parts = data.split(":");
        const approvalId = parts[1];
        const choiceIndex = Number(parts[2]);
        const pending = this.#pending.get(approvalId);
        if (!pending) return false;

        const actorId = String(query.from?.id || "");
        if (pending.actorType === "telegram" && actorId !== pending.actorId) {
            const ownerOverride = this.#rbac?.isOwner?.(Number(actorId));
            if (!ownerOverride) {
                await this.#telegram.call("answerCallbackQuery", {
                    callback_query_id: query.id,
                    text: "⛔ Not your approval request.",
                    show_alert: true,
                }).catch(() => {});
                return true;
            }
        }

        await this.#telegram.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
        const option = pending.options[choiceIndex];
        if (!option) {
            await this.#expireApproval(pending, "invalid_choice");
            return true;
        }

        await this.#resolveApproval(pending, option.optionId, option.kind || option.name || option.optionId, {
            decisionActorId: actorId,
        });
        return true;
    }

    async respondWebuiApproval(principalId, approvalId, optionId) {
        const pending = this.#pending.get(String(approvalId));
        if (!pending || pending.actorType !== "webui" || pending.actorId !== String(principalId)) {
            return { ok: false, error: "Approval request not found" };
        }

        const option = pending.options.find(o => o.optionId === optionId);
        if (!option) {
            return { ok: false, error: "Invalid approval option" };
        }

        await this.#resolveApproval(pending, option.optionId, option.kind || option.name || option.optionId, {
            decisionActorId: String(principalId),
        });
        return { ok: true };
    }

    async expireScope(scopeKey, reason = "scope_closed") {
        const targets = [...this.#pending.values()].filter(p => p.scopeKey === String(scopeKey));
        for (const pending of targets) {
            await this.#expireApproval(pending, reason);
        }
    }

    getPendingWebuiApproval(principalId, scopeKey) {
        for (const pending of this.#pending.values()) {
            if (pending.actorType === "webui" &&
                pending.actorId === String(principalId) &&
                pending.scopeKey === String(scopeKey)) {
                return {
                    approvalId: pending.approvalId,
                    title: this.#buildApprovalMessage(pending),
                    options: pending.options.map((option) => ({
                        optionId: option.optionId,
                        name: option.name || option.kind || option.optionId,
                        kind: option.kind || option.name || option.optionId,
                    })),
                };
            }
        }
        return null;
    }

    #buildApproval({ conversation, scopeKey, request }) {
        const requestId = request.requestId;
        const options = request.options || [];
        const toolCall = request.toolCall || request.tool_call || {};
        const rawInput = toolCall.rawInput || {};
        const domain = rawInput.domain || "";
        const service = rawInput.service || "";
        const entityId = rawInput.entity_id || rawInput.entityId || null;
        const toolName = toolCall.name || request?.toolName || request?.tool || request?.name || "unknown_tool";
        const title = toolCall.title || toolName;
        const planSummary = Array.isArray(toolCall.content)
            ? toolCall.content
                .map((item) => item?.content?.text || item?.text || "")
                .filter(Boolean)
                .join("\n")
            : "";
        const isPlanApproval = toolCall.kind === "switch_mode";
        const derivedTool = domain && service ? "ha_call_service" : toolName;
        const grantKey = this.#buildGrantKey({ toolName: derivedTool, domain, service, entityId, kind: toolCall.kind });
        const actorId = String(conversation.ref?.userId ?? "");
        const actorType = scopeKey.startsWith("webui:") ? "webui" : scopeKey.startsWith("si:") ? "system" : "telegram";
        const isReadOnly = !isPlanApproval && READ_ONLY_TOOLS.has(derivedTool);
        const actionClass = this.#classifyAction({ toolName: derivedTool, domain, service });
        const approvalId = randomUUID();
        return {
            approvalId,
            scopeKey,
            requestId,
            actorId,
            actorType,
            userGrantId: actorType === "telegram" ? actorId : actorId || null,
            acp: conversation.acp,
            conversation,
            title,
            planSummary,
            toolName: derivedTool,
            grantKey,
            rbacToolName: derivedTool,
            rbacArgs: { domain, entity_id: entityId },
            domain,
            service,
            entityId,
            actionClass,
            isReadOnly,
            isPlanApproval,
            options,
        };
    }

    #buildGrantKey({ toolName, domain, service, entityId, kind }) {
        if (kind === "switch_mode") return "plan:switch_mode";
        if (toolName === "ha_call_service") {
            return `ha:${domain || "unknown"}:${service || "unknown"}:${entityId || "*"}`;
        }
        return `tool:${toolName}`;
    }

    #classifyAction({ toolName, domain }) {
        if (READ_ONLY_TOOLS.has(toolName)) return "read";
        if (toolName === "ha_call_service") {
            if (SENSITIVE_DOMAINS.has(domain)) return "sensitive_write";
            if (SAFE_DOMAINS.has(domain)) return "low_write";
            return "low_write";
        }
        if (!toolName.startsWith("ha_")) return "read";
        return "low_write";
    }

    async #promptApproval(approval) {
        const pending = {
            ...approval,
            timer: setTimeout(() => {
                this.#expireApproval(pending, "timeout").catch(err => log.warn(`Approval timeout cleanup failed: ${err.message}`));
            }, APPROVAL_TIMEOUT_MS),
            messageId: null,
        };
        this.#pending.set(approval.approvalId, pending);

        if (approval.actorType === "webui") {
            this.emit("webui-approval-request", {
                approvalId: approval.approvalId,
                principalId: approval.actorId,
                scopeKey: approval.scopeKey,
                title: this.#buildApprovalMessage(approval),
                options: approval.options.map((option) => ({
                    optionId: option.optionId,
                    name: option.name || option.kind || option.optionId,
                    kind: option.kind || option.name || option.optionId,
                })),
            });
            return;
        }

        const chatId = approval.conversation.ref?.chatId;
        if (!chatId) {
            await this.#expireApproval(pending, "no_chat");
            return;
        }

        const inline_keyboard = approval.options.map((option, index) => ([{
            text: this.#buttonLabel(option),
            callback_data: `permreq:${approval.approvalId}:${index}`,
        }]));

        try {
            const params = {
                chat_id: chatId,
                text: this.#buildApprovalMessage(approval),
                parse_mode: "HTML",
                reply_markup: { inline_keyboard },
                link_preview_options: { is_disabled: true },
            };
            if (approval.conversation.ref?.threadId) {
                params.message_thread_id = approval.conversation.ref.threadId;
            }
            const sent = await this.#telegram.call("sendMessage", params);
            pending.messageId = sent?.message_id ?? null;
        } catch (err) {
            log.warn(`Failed to send approval prompt: ${err.message}`);
            await this.#expireApproval(pending, "send_failed");
        }
    }

    async #resolveApproval(pending, optionId, decision, { decisionActorId = null } = {}) {
        clearTimeout(pending.timer);
        this.#pending.delete(pending.approvalId);

        const option = pending.options.find(o => o.optionId === optionId) || null;
        if (!optionId) {
            await this.#expireApproval(pending, "missing_option");
            return;
        }

        if ((option?.kind || option?.name || option?.optionId) === "allow_always" && pending.userGrantId) {
            this.#store.grantScope(pending.scopeKey, pending.userGrantId, pending.grantKey);
        }

        try {
            pending.acp.respondPermission(pending.requestId, optionId);
        } catch (err) {
            log.warn(`Failed to resolve approval ${pending.approvalId}: ${err.message}`);
        }
        this.#store.logApproval({
            scopeKey: pending.scopeKey,
            actorId: pending.actorId,
            actorType: pending.actorType,
            tool: pending.grantKey,
            entityId: pending.entityId,
            actionClass: pending.actionClass,
            decision,
            correlationId: pending.requestId,
            details: {
                approvalId: pending.approvalId,
                decisionActorId,
                optionId,
            },
        });

        if (pending.actorType === "webui") {
            this.emit("webui-approval-resolved", {
                approvalId: pending.approvalId,
                principalId: pending.actorId,
                scopeKey: pending.scopeKey,
                decision,
            });
            return;
        }

        if (pending.messageId && pending.conversation.ref?.chatId) {
            const params = {
                chat_id: pending.conversation.ref.chatId,
                message_id: pending.messageId,
                text: `${this.#buildApprovalMessage(pending)}\n\n${this.#decisionLabel(decision)}`,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] },
            };
            await this.#telegram.call("editMessageText", params).catch(() => {});
        }
    }

    async #expireApproval(pending, reason) {
        clearTimeout(pending.timer);
        this.#pending.delete(pending.approvalId);
        const rejectId = this.#findOptionId(pending.options, ["reject_once", "reject_always"]);
        try {
            if (rejectId) {
                pending.acp.respondPermission(pending.requestId, rejectId);
            } else {
                pending.acp.respondPermission(pending.requestId, null, true);
            }
        } catch (err) {
            log.warn(`Failed to expire approval ${pending.approvalId}: ${err.message}`);
        }

        this.#store.logApproval({
            scopeKey: pending.scopeKey,
            actorId: pending.actorId,
            actorType: pending.actorType,
            tool: pending.grantKey,
            entityId: pending.entityId,
            actionClass: pending.actionClass,
            decision: "expired",
            correlationId: pending.requestId,
            details: { approvalId: pending.approvalId, reason },
        });

        if (pending.actorType === "webui") {
            this.emit("webui-approval-resolved", {
                approvalId: pending.approvalId,
                principalId: pending.actorId,
                scopeKey: pending.scopeKey,
                decision: "expired",
            });
            return;
        }

        if (pending.messageId && pending.conversation.ref?.chatId) {
            const params = {
                chat_id: pending.conversation.ref.chatId,
                message_id: pending.messageId,
                text: `${this.#buildApprovalMessage(pending)}\n\n⏰ Approval expired.`,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] },
            };
            await this.#telegram.call("editMessageText", params).catch(() => {});
        }
    }

    #buttonLabel(option) {
        const kind = option.kind || option.name || option.optionId;
        if (kind === "allow_once") return "✅ Allow once";
        if (kind === "allow_always") return "✅ Always allow";
        if (kind === "reject_once") return "❌ Deny";
        if (kind === "reject_always") return "⛔ Always deny";
        return option.name || option.optionId;
    }

    #buildApprovalMessage(approval) {
        if (approval.isPlanApproval) {
            const summary = approval.planSummary?.trim() || approval.title;
            const truncated = summary.length > 1000 ? `${summary.slice(0, 997)}...` : summary;
            return `<b>📋 Plan approval required</b>\n${truncated}`;
        }
        const detail = approval.entityId
            ? `${approval.domain || approval.toolName}.${approval.service || ""} → ${approval.entityId}`
            : approval.domain && approval.service
                ? `${approval.domain}.${approval.service}`
                : approval.toolName;
        return `<b>🔐 Approval required</b>\n${detail}`;
    }

    #decisionLabel(decision) {
        if (String(decision).includes("allow")) return "✅ Allowed";
        if (String(decision).includes("deny") || String(decision).includes("reject")) return "❌ Denied";
        if (String(decision).includes("expired")) return "⏰ Expired";
        return `ℹ️ ${decision}`;
    }

    #findOptionId(options, preferredKinds) {
        for (const kind of preferredKinds) {
            const match = options.find(o => (o.kind || o.name || o.optionId) === kind);
            if (match?.optionId) return match.optionId;
        }
        return options[0]?.optionId || null;
    }

    async #rejectWithoutPrompt(approval, decision, details = {}) {
        const rejectId = this.#findOptionId(approval.options, ["reject_once", "reject_always"]);
        try {
            if (rejectId) {
                approval.acp.respondPermission(approval.requestId, rejectId);
            } else {
                approval.acp.respondPermission(approval.requestId, null, true);
            }
        } catch (err) {
            log.warn(`Failed to reject approval ${approval.approvalId}: ${err.message}`);
        }
        this.#store.logApproval({
            scopeKey: approval.scopeKey,
            actorId: approval.actorId,
            actorType: approval.actorType,
            tool: approval.grantKey,
            entityId: approval.entityId,
            actionClass: approval.actionClass,
            decision,
            correlationId: approval.requestId,
            details,
        });
    }
}
