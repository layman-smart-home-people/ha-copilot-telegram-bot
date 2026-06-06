// ============================================================
// InteractiveFlows — elicitation, question queue, MCP ask_user
// ============================================================
// Extracted from bridge.mjs (Phase 4). Handles structured questions
// from ACP (elicitation) and MCP tool ask_user via UDS IPC.

import { createLogger } from "../../logger.mjs";
import { createServer as createNetServer } from "node:net";
import { unlinkSync, chmodSync } from "node:fs";

const log = createLogger('interactive');
const TG_UX_SOCK = process.env.TG_UX_SOCK || "/run/tg-ux.sock";

export class InteractiveFlows {
    #buttons;
    #telegram;
    #acp;
    #scopeMgr;
    #getActiveScope;
    #getOverflowScope;
    #getActiveRef;
    #getAllowedChatIds;
    #onBackgroundTask;

    // UDS server for tg-ux MCP sidecar IPC
    #udsServer = null;

    // Question queue for MCP ask_user (FIFO)
    #questionQueue = [];
    #processingQuestion = false;
    static #MAX_QUESTION_QUEUE = 10;

    /**
     * @param {object} opts
     * @param {object} opts.buttons - ButtonManager instance
     * @param {object} opts.telegram - TelegramClient instance
     * @param {object} opts.acp - Primary ACP client instance
     * @param {object} opts.scopeMgr - ScopeManager instance
     * @param {Function} opts.getActiveScope - returns current active scope
     * @param {Function} opts.getOverflowScope - returns current overflow scope
     * @param {Function} opts.getActiveRef - returns current active ref
     * @param {Function} opts.getAllowedChatIds - returns allowed chat IDs array
     * @param {Function} [opts.onBackgroundTask] - callback for background_task MCP tool
     */
    constructor({ buttons, telegram, acp, scopeMgr, getActiveScope, getOverflowScope, getActiveRef, getAllowedChatIds, onBackgroundTask }) {
        this.#buttons = buttons;
        this.#telegram = telegram;
        this.#acp = acp;
        this.#scopeMgr = scopeMgr;
        this.#getActiveScope = getActiveScope;
        this.#getOverflowScope = getOverflowScope;
        this.#getActiveRef = getActiveRef;
        this.#getAllowedChatIds = getAllowedChatIds;
        this.#onBackgroundTask = onBackgroundTask || null;
    }

    // --- Elicitation (ACP structured questions) ---

    /** Handle elicitation_request events from ACP (structured questions). */
    async handleElicitationRequest(req, acp, scope, getRef, tag) {
        if (scope.pendingElicitation) {
            acp.respondElicitation(req.requestId, "cancel");
            log.warn(`Rejected concurrent elicitation (another pending)`);
            return;
        }
        log.info(`Elicitation [${tag}]: ${req.message}`);

        const targetRef = getRef();
        const chatId = targetRef?.chatId || this.#getAllowedChatIds()?.[0];
        if (!chatId) {
            acp.respondElicitation(req.requestId, "cancel");
            return;
        }

        const schema = req.requestedSchema;
        const props = schema?.properties || {};
        const propNames = Object.keys(props);

        // Single-property shortcut (most common case)
        if (propNames.length === 1) {
            const propName = propNames[0];
            const propSchema = props[propName];
            const result = await this.#elicitSingleField(
                chatId, req.requestId, req.message, propName, propSchema, scope, acp
            );
            if (result !== undefined) {
                acp.respondElicitation(req.requestId, "accept", { [propName]: result });
            }
            return;
        }

        // Multi-field: collect answers sequentially
        if (propNames.length > 1) {
            const content = {};
            for (const propName of propNames) {
                const propSchema = props[propName];
                const fieldMsg = propSchema.title
                    ? `${req.message}\n\n${propSchema.title}${propSchema.description ? `\n${propSchema.description}` : ""}`
                    : req.message;
                const result = await this.#elicitSingleField(
                    chatId, req.requestId, fieldMsg, propName, propSchema, scope, acp
                );
                if (result === undefined) return; // cancelled
                content[propName] = result;
            }
            acp.respondElicitation(req.requestId, "accept", content);
            return;
        }

        // Empty schema — just show message with OK button
        if (this.#buttons) {
            const { value } = await this.#buttons.prompt(chatId, `❓ ${req.message}`, [
                [{ text: "✅ OK", value: "ok" }, { text: "❌ Cancel", value: "cancel" }]
            ]);
            acp.respondElicitation(req.requestId, value === "ok" ? "accept" : "decline", {});
        } else {
            acp.respondElicitation(req.requestId, "accept", {});
        }
    }

    /**
     * Elicit a single field from the user via Telegram UI.
     * Returns the value on accept, or undefined if cancelled/declined
     * (in which case the elicitation response is already sent).
     */
    async #elicitSingleField(chatId, requestId, message, propName, schema, scope, acp) {
        acp = acp || this.#acp;
        const title = schema.title || propName;

        // Enum with titles (oneOf) → inline keyboard
        if (Array.isArray(schema.oneOf)) {
            const optionValues = schema.oneOf.map(opt => opt.const);
            const rows = schema.oneOf.map((opt, i) => [{
                text: opt.title || opt.const,
                value: `elicit:${i}`,
            }]);
            rows.push([{ text: "❌ Skip", value: "elicit:__cancel__" }]);
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, rows
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return optionValues[Number.parseInt(val, 10)];
        }

        // Enum without titles → inline keyboard
        if (Array.isArray(schema.enum)) {
            const optionValues = [...schema.enum];
            const rows = schema.enum.map((v, i) => [{
                text: String(v),
                value: `elicit:${i}`,
            }]);
            rows.push([{ text: "❌ Skip", value: "elicit:__cancel__" }]);
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, rows
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return optionValues[Number.parseInt(val, 10)];
        }

        // Boolean → Yes/No buttons
        if (schema.type === "boolean") {
            const defaultVal = schema.default;
            const yesLabel = defaultVal === true ? "✅ Yes (default)" : "✅ Yes";
            const noLabel = defaultVal === false ? "❌ No (default)" : "❌ No";
            if (scope.composer) scope.composer.setInteractionPending("question");
            let selected;
            try {
                ({ value: selected } = await this.#buttons.prompt(
                    chatId, `❓ ${message}`, [
                        [{ text: yesLabel, value: "elicit:true" }, { text: noLabel, value: "elicit:false" }],
                        [{ text: "⏭️ Skip", value: "elicit:__cancel__" }],
                    ]
                ));
            } finally {
                if (scope.composer) scope.composer.setInteractionPending(null);
            }
            const val = selected?.replace(/^elicit:/, "");
            if (!val || val === "__cancel__") {
                acp.respondElicitation(requestId, "decline");
                return undefined;
            }
            return val === "true";
        }

        // Multi-select array → sequential toggle buttons
        if (schema.type === "array" && schema.items) {
            const itemOptions = schema.items.enum || schema.items.anyOf?.map(o => o.const) || [];
            const itemLabels = schema.items.anyOf?.map(o => o.title) || itemOptions.map(String);
            if (itemOptions.length > 0) {
                const rows = itemOptions.map((v, i) => [{
                    text: itemLabels[i] || String(v),
                    value: `elicit:${i}`,
                }]);
                rows.push([{ text: "✅ Done", value: "elicit:__done__" },
                           { text: "❌ Cancel", value: "elicit:__cancel__" }]);

                const selected = [];
                if (scope.composer) scope.composer.setInteractionPending("question");
                try {
                    const { value } = await this.#buttons.prompt(
                        chatId,
                        `❓ ${message}\n\nSelect one option:`,
                        rows
                    );
                    const val = value?.replace(/^elicit:/, "");
                    if (!val || val === "__cancel__") {
                        acp.respondElicitation(requestId, "decline");
                        return undefined;
                    }
                    if (val !== "__done__") selected.push(itemOptions[Number.parseInt(val, 10)]);
                } finally {
                    if (scope.composer) scope.composer.setInteractionPending(null);
                }
                return selected;
            }
        }

        // String/number/integer → text input via pending elicitation
        const defaultHint = schema.default !== undefined ? `\n(Default: ${schema.default})` : "";
        const constraintHints = [];
        if (schema.minLength) constraintHints.push(`min ${schema.minLength} chars`);
        if (schema.maxLength) constraintHints.push(`max ${schema.maxLength} chars`);
        if ((schema.type === "number" || schema.type === "integer") && schema.minimum !== undefined) {
            constraintHints.push(`min: ${schema.minimum}`);
        }
        if ((schema.type === "number" || schema.type === "integer") && schema.maximum !== undefined) {
            constraintHints.push(`max: ${schema.maximum}`);
        }
        const constraintText = constraintHints.length > 0 ? `\n(${constraintHints.join(", ")})` : "";

        const promptText = `❓ ${message}${defaultHint}${constraintText}\n\nReply with your answer, or tap Skip.`;

        // Send message with Skip button AND set up text reply intercept
        return new Promise((resolve) => {
            // Store pending elicitation on scope for text intercept
            scope.pendingElicitation = {
                requestId,
                propName,
                schema,
                resolve: (val) => {
                    scope.pendingElicitation = null;
                    resolve(val);
                },
            };

            // Send the prompt with a skip button
            this.#buttons.prompt(chatId, promptText, [
                [{ text: "⏭️ Skip", value: "elicit:__cancel__" }],
            ]).then(({ value }) => {
                if (scope.pendingElicitation?.requestId === requestId) {
                    // User tapped Skip
                    scope.pendingElicitation = null;
                    acp.respondElicitation(requestId, "decline");
                    resolve(undefined);
                }
            }).catch(() => {
                if (scope.pendingElicitation?.requestId === requestId) {
                    scope.pendingElicitation = null;
                    acp.respondElicitation(requestId, "cancel");
                    resolve(undefined);
                }
            });
        });
    }

    // --- UDS IPC server for tg-ux MCP sidecar ---

    startUdsServer() {
        try { unlinkSync(TG_UX_SOCK); } catch {}
        this.#udsServer = createNetServer({ allowHalfOpen: true }, (conn) => {
            let buf = "";
            conn.on("data", (c) => {
                buf += c.toString();
                const nlIdx = buf.indexOf("\n");
                if (nlIdx === -1) return;
                const line = buf.slice(0, nlIdx);
                buf = "";
                let req;
                try {
                    req = JSON.parse(line);
                } catch (e) {
                    log.debug(`UDS: JSON parse error: ${e.message}`);
                    try { conn.end(JSON.stringify({ error: "Invalid JSON" })); } catch {}
                    return;
                }
                const scopeKey = req.scopeKey;
                const method = req.method || "ask_user";
                log.debug(`UDS: ${method} received (scope=${scopeKey || "unknown"})`);

                this.#routeUdsRequest(method, req.params || {}, scopeKey)
                    .then((result) => {
                        log.debug(`UDS: ${method} result (scope=${scopeKey || "unknown"}): ${result.error ? "error: " + result.error : "ok"}`);
                        try { conn.end(JSON.stringify(result)); } catch {}
                    })
                    .catch((err) => {
                        log.debug(`UDS: ${method} error: ${err.message}`);
                        try { conn.end(JSON.stringify({ error: err.message })); } catch {}
                    });
            });
            conn.on("error", (err) => {
                log.debug(`UDS: connection error: ${err.message}`);
            });
        });
        this.#udsServer.on("error", (err) => {
            log.debug(`UDS server error: ${err.message}`);
        });
        this.#udsServer.listen(TG_UX_SOCK, () => {
            try { chmodSync(TG_UX_SOCK, 0o600); } catch {}
            log.info(`UDS server listening on ${TG_UX_SOCK}`);
        });
    }

    async #routeUdsRequest(method, params, scopeKey) {
        switch (method) {
            case "ask_user":
                return this.handleMcpAskUser(params, scopeKey);
            case "background_task":
                return this.#handleBackgroundTask(params, scopeKey);
            default:
                return { error: `Unknown UDS method: ${method}` };
        }
    }

    #handleBackgroundTask(params, scopeKey) {
        const { prompt, description } = params;
        if (!prompt) return Promise.resolve({ error: "prompt is required" });
        if (!description) return Promise.resolve({ error: "description is required" });

        if (!this.#onBackgroundTask) {
            return Promise.resolve({ error: "Background tasks not available" });
        }

        // Resolve chatId from scope for result delivery
        let ref;
        if (scopeKey && this.#scopeMgr) {
            const scope = this.#scopeMgr.get(scopeKey);
            ref = scope?.activeRef || this.#getActiveRef();
        }
        if (!ref) ref = this.#getActiveRef();
        const chatId = ref?.chatId;
        if (!chatId) return Promise.resolve({ error: "No active chat for result delivery" });

        const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        log.info(`Background task dispatched: ${taskId} — "${description}"`);

        // Fire-and-forget: inject into background queue, return immediately
        try {
            this.#onBackgroundTask({
                taskId,
                prompt,
                description,
                chatId,
                source: "mcp_tool",
            });
        } catch (err) {
            log.warn(`Background task injection failed: ${err.message}`);
            return Promise.resolve({ error: `Failed to queue: ${err.message}` });
        }

        return Promise.resolve({ taskId, status: "queued" });
    }

    stopUdsServer() {
        if (this.#udsServer) {
            this.#udsServer.close();
            this.#udsServer = null;
            try { unlinkSync(TG_UX_SOCK); } catch {}
        }
    }

    // --- MCP ask_user question queue ---

    async handleMcpAskUser({ message, options }, scopeKey) {
        // Resolve scope from scopeKey (UDS payload) or fall back to activeScope
        let scope, ref;
        if (scopeKey && this.#scopeMgr) {
            scope = this.#scopeMgr.get(scopeKey);
            ref = scope?.activeRef || this.#getActiveRef();
        }
        if (!scope) {
            scope = this.#getActiveScope();
            ref = this.#getActiveRef();
        }
        const chatId = ref?.chatId;
        if (!chatId || !scope) return { error: "No active session" };
        if (!message) return { error: "No message provided" };

        // Queue overflow protection
        if (this.#questionQueue.length >= InteractiveFlows.#MAX_QUESTION_QUEUE) {
            log.warn(`Question queue full (${this.#questionQueue.length}), rejecting`);
            return { error: "Too many pending questions" };
        }

        // Enqueue and return a Promise that resolves when this question is answered
        return new Promise((resolve) => {
            this.#questionQueue.push({
                message, options, resolve, scope, chatId, ref,
                queuedAt: Date.now(),
            });
            log.debug(`Question queued (queue=${this.#questionQueue.length})`);
            this.#drainQuestionQueue();
        });
    }

    /** Process questions FIFO — one at a time. */
    async #drainQuestionQueue() {
        if (this.#processingQuestion) return;
        if (this.#questionQueue.length === 0) return;

        this.#processingQuestion = true;
        try {
            while (this.#questionQueue.length > 0) {
                const item = this.#questionQueue[0];
                const total = this.#questionQueue.length;
                const prefix = total > 1 ? `(1/${total}) ` : "";

                // Stale scope check
                if (item.scope !== this.#getActiveScope() && item.scope !== this.#getOverflowScope()) {
                    log.warn(`Question skipped: scope no longer active`);
                    item.resolve({ error: "Session ended" });
                    this.#questionQueue.shift();
                    continue;
                }

                try {
                    const result = await this.#doAskUser(item, prefix);
                    item.resolve(result);
                } catch (err) {
                    log.warn(`Question error: ${err.message}`);
                    item.resolve({ error: err.message });
                }
                this.#questionQueue.shift();

                // Brief delay between questions for smooth UX
                if (this.#questionQueue.length > 0) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        } finally {
            this.#processingQuestion = false;
        }
    }

    /** Cancel all queued questions (e.g., on /stop or ACP exit). */
    cancelQuestionQueue(reason) {
        const count = this.#questionQueue.length;
        if (count === 0) return;
        log.debug(`Cancelling ${count} queued questions: ${reason}`);
        for (const item of this.#questionQueue) {
            item.resolve({ error: reason });
        }
        this.#questionQueue.length = 0;
    }

    /**
     * Show a single question to the user and wait for answer.
     */
    async #doAskUser(item, prefix) {
        const { message, options, scope, chatId } = item;

        const composerRef = scope?.composer;
        const replyToMsg = composerRef?.messageId;
        const sendOpts = replyToMsg ? { reply_to_message_id: replyToMsg } : {};
        const displayMsg = `${prefix}${message}`;

        // Reserve pendingElicitation slot
        if (scope) scope.pendingElicitation = { reserved: true };

        if (options && Array.isArray(options) && options.length > 0) {
            if (options.length <= 8) {
                // Inline buttons — one per row + custom escape hatch + cancel
                const rows = options.map((opt, i) => [
                    { text: opt.label || opt.value, value: `mcpq:${i}` },
                ]);
                rows.push([{ text: "✏️ Something else", value: "mcpq:custom" }]);
                rows.push([{ text: "❌ Cancel", value: "mcpq:cancel" }]);

                if (composerRef) composerRef.setInteractionPending("question");
                try {
                    const { value, messageId: btnMsgId } = await this.#buttons.prompt(
                        chatId, `❓ ${displayMsg}`, rows,
                        { timeoutMs: 0, ...sendOpts }
                    );
                    if (!value || value === "mcpq:cancel") {
                        if (btnMsgId) {
                            this.#buttons.finalize(chatId, btnMsgId, `❌ Cancelled: ${message}`).catch(() => {});
                        }
                        return { error: "User cancelled" };
                    }
                    if (value === "mcpq:custom") {
                        // Escape hatch — finalize button msg and fall through to free-text
                        if (btnMsgId) {
                            this.#buttons.finalize(chatId, btnMsgId, `✏️ Typing custom answer...`).catch(() => {});
                        }
                        if (scope) scope.pendingElicitation = null;
                        if (composerRef) composerRef.setInteractionPending(null);
                        return await this.#doAskUserFreeText(item, prefix);
                    }
                    const idx = parseInt(value.replace("mcpq:", ""), 10);
                    const answer = options[idx]?.value ?? value;
                    const label = options[idx]?.label || answer;
                    if (btnMsgId) {
                        this.#buttons.finalize(chatId, btnMsgId, `✅ ${label}`).catch(() => {});
                    }
                    return { answer };
                } finally {
                    if (scope) scope.pendingElicitation = null;
                    if (composerRef) composerRef.setInteractionPending(null);
                }
            } else {
                // Too many options — numbered list + text reply
                const numbered = options.map((opt, i) => `${i + 1}. ${opt.label || opt.value}`).join("\n");
                const prompt = `❓ ${displayMsg}\n\n${numbered}\n\nReply with the number of your choice, or "cancel".`;
                const sendParams = { chat_id: chatId, text: prompt, link_preview_options: { is_disabled: true } };
                if (sendOpts.reply_to_message_id) sendParams.reply_to_message_id = sendOpts.reply_to_message_id;
                await this.#telegram.call("sendMessage", sendParams);

                if (composerRef) composerRef.setInteractionPending("question");
                try {
                    const answer = await new Promise((resolve) => {
                        if (scope) {
                            scope.pendingElicitation = {
                                resolve, schema: { type: "string" }, propName: "answer",
                            };
                        }
                    });
                    if (!answer || answer.toLowerCase() === "cancel") {
                        return { error: "User cancelled" };
                    }
                    const num = parseInt(answer, 10);
                    if (num >= 1 && num <= options.length) {
                        return { answer: options[num - 1].value };
                    }
                    return { answer };
                } finally {
                    if (scope) scope.pendingElicitation = null;
                    if (composerRef) composerRef.setInteractionPending(null);
                }
            }
        } else {
            // Free text — prompt and wait for next message
            return await this.#doAskUserFreeText(item, prefix);
        }
    }

    /** Show a free-text prompt with a cancel button and wait for typed answer. */
    async #doAskUserFreeText(item, prefix) {
        const { message, scope, chatId } = item;
        const composerRef = scope?.composer;
        const replyToMsg = composerRef?.messageId;
        const sendOpts = replyToMsg ? { reply_to_message_id: replyToMsg } : {};
        const displayMsg = `${prefix}${message}`;
        const cancelRows = [[{ text: "❌ Cancel", value: "mcpq:cancel" }]];

        if (scope) scope.pendingElicitation = { reserved: true };
        if (composerRef) composerRef.setInteractionPending("question");
        try {
            const btnPromise = this.#buttons.prompt(
                chatId, `❓ ${displayMsg}\n\nType your answer below:`, cancelRows,
                { timeoutMs: 0, ...sendOpts }
            );

            const textPromise = new Promise((resolve) => {
                if (scope) {
                    scope.pendingElicitation = {
                        resolve, schema: { type: "string" }, propName: "answer",
                    };
                }
            });

            const result = await Promise.race([
                btnPromise.then(r => ({ type: "button", value: r.value })),
                textPromise.then(v => ({ type: "text", value: v })),
            ]);

            if (result.type === "button") {
                if (scope) scope.pendingElicitation = null;
                return { error: "User cancelled" };
            } else {
                this.#buttons.cancelForChat(chatId, `✅ Answered`);
                return { answer: result.value ?? "" };
            }
        } finally {
            if (scope) scope.pendingElicitation = null;
            if (composerRef) composerRef.setInteractionPending(null);
        }
    }
}
