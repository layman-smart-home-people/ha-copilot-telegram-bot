// ============================================================
// ResponseStreamer — 4-layer progressive Telegram rendering
// ============================================================
// Replaces ResponseComposer (1033 lines) with a cleaner design.
// Layers: 1) content text, 2) code blocks, 3) expandable details
//         4) action buttons (inline keyboard)
//
// Lifecycle: start() → stream chunks → finalize() | abort()
// Uses sendMessageDraft for ephemeral streaming in private chats,
// editMessageText for groups, and setMessageReaction for status.

import { escapeHtml, markdownToTelegramHtml, stripHtmlKeepStructure } from "../transport/telegram/formatter.mjs";
import { withThread } from "../transport/telegram/thread.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("streamer");
const MAX_MSG_LEN = 4096;
const DRAFT_THROTTLE_MS = 750;
const EDIT_THROTTLE_MS = 1500;
const EDIT_MIN_CHARS = 40;

// Tool name → friendly description for user display
const TOOL_LABELS = {
    ha_get_state: "Checking device state",
    ha_call_service: "Controlling device",
    ha_search_entities: "Searching entities",
    ha_get_history: "Fetching history",
    ha_eval_template: "Evaluating template",
    ha_bulk_control: "Controlling multiple devices",
    ha_config_get_dashboard: "Reading dashboard",
    ha_config_set_dashboard: "Updating dashboard",
    ha_config_get_automation: "Reading automation",
    ha_config_set_automation: "Updating automation",
    ha_get_system_health: "Checking system health",
    bash: "Running command",
    grep: "Searching code",
    glob: "Finding files",
    view: "Reading file",
    edit: "Editing file",
    create: "Creating file",
    web_search: "Searching the web",
    web_fetch: "Fetching page",
    dispatch_to_agent: "Routing to full agent",
    si_create: "Creating standing instruction",
    si_list: "Listing standing instructions",
    si_get: "Reading standing instruction",
    si_update: "Updating standing instruction",
    si_delete: "Deleting standing instruction",
    si_toggle: "Toggling standing instruction",
    ask_user: "Asking user",
    background_task: "Dispatching background task",
    notify_user: "Sending notification",
    pkm_memory: "Managing memory",
    pkm_search: "Searching memory",
    pkm_navigate: "Browsing memory",
    pkm_collection: "Managing collection",
    pkm_manage: "Memory maintenance",
    remember: "Saving memory",
    recall: "Searching memory",
    memory_admin: "Managing memory",
};

export class ResponseStreamer {
    #telegram;
    #ref;             // { chatId, threadId?, chatType }
    #messageId = null;
    #draftMode = false;
    #draftId = null;
    #transportConfig;  // 'auto' | 'draft' | 'edit' | 'off'

    // Content accumulation — VSCode-style phases
    #phases = [];          // [{ thinking: string, tools: [{...}], text: string }]
    #currentPhase = null;  // current phase being built
    #thoughtBuffer = "";
    #toolSteps = [];       // flat list for progress tracking
    #planEntries = [];

    // Rendering state
    #lastRendered = "";
    #lastRenderTime = 0;
    #renderTimer = null;
    #elapsedTimer = null;
    #finalized = false;
    #startTime = null;
    #inflightRender = null;

    // Draft tracking
    #draftFailures = 0;
    #draftSending = false;
    #overflowPages = null;  // multi-message overflow for long responses

    constructor(telegram, { streamingTransport = "auto" } = {}) {
        this.#telegram = telegram;
        this.#transportConfig = streamingTransport;
    }

    get active() { return this.#messageId !== null && !this.#finalized; }
    get messageId() { return this.#messageId; }

    // ── Lifecycle ────────────────────────────────────────────

    /** Start streaming for a new prompt. Returns the placeholder message ID. */
    async start(ref) {
        // Clear any pending timers from previous session
        if (this.#renderTimer) { clearTimeout(this.#renderTimer); this.#renderTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }

        this.#ref = ref;
        this.#phases = [];
        this.#currentPhase = null;
        this.#thoughtBuffer = "";
        this.#toolSteps = [];
        this.#planEntries = [];
        this.#lastRendered = "";
        this.#lastRenderTime = 0;
        this.#finalized = false;
        this.#startTime = Date.now();
        this.#draftFailures = 0;
        this.#draftSending = false;
        this.#overflowPages = null;
        this.#messageId = null;
        this.#draftId = null;

        // Transport selection based on config
        // 'auto': draft for private DMs (no thread), edit for everything else
        // 'draft': force draft (only works in private DMs, fallback for others)
        // 'edit': always use editMessageText
        // 'off': only show final message (no progress)
        const useDraft = this.#shouldUseDraft(ref);

        if (useDraft) {
            this.#draftMode = true;
            this.#draftId = 1; // Telegram API requires integer draft_id
            this.#messageId = -1; // sentinel for draft mode
            try {
                await this.#sendDraft("🤔 Thinking...");
            } catch (err) {
                // Draft failed on first attempt — fall back to edit mode
                log.warn(`Draft mode unavailable: ${err.message} — falling back to edit mode`);
                this.#draftMode = false;
                this.#draftId = null;
                const params = withThread({
                    chat_id: ref.chatId, text: "🤔 <i>Thinking...</i>",
                    parse_mode: "HTML", disable_notification: true,
                }, ref);
                const result = await this.#telegram.call("sendMessage", params).catch(() => null);
                this.#messageId = result?.message_id ?? null;
            }
        } else if (this.#transportConfig === "off") {
            // No progress updates — send final as fresh message
            this.#draftMode = false;
            this.#messageId = -2; // sentinel: active but no progress
        } else {
            this.#draftMode = false;
            const params = withThread({
                chat_id: ref.chatId, text: "🤔 <i>Thinking...</i>",
                parse_mode: "HTML", disable_notification: true,
            }, ref);
            const result = await this.#telegram.call("sendMessage", params);
            this.#messageId = result?.message_id ?? null;
        }

        // Start elapsed timer for periodic re-renders (keeps timer updating)
        this.#scheduleElapsedUpdate();

        return this.#messageId;
    }

    /** Stream a text chunk from ACP. */
    onTextChunk(text) {
        if (this.#finalized) return;
        // Classify: if tools are active in current phase, this is reasoning.
        // If no tools active (or all done), this is response text.
        const phase = this.#ensurePhase();
        const hasActiveTools = phase.tools.some(t => t.status === "running");
        if (hasActiveTools) {
            phase.thinking += text;
        } else {
            phase.text += text;
        }
        this.#scheduleRender();
    }

    /** Stream a thought chunk (shown during processing, hidden in final). */
    onThoughtChunk(text) {
        if (this.#finalized) return;
        this.#thoughtBuffer += text;
        const phase = this.#ensurePhase();
        phase.thinking += text;
        this.#scheduleRender();
    }

    /** Tool started — opens a new thinking phase if needed. */
    onToolStart({ toolName, name, toolCallId }) {
        if (this.#finalized) return;
        const resolvedName = toolName || name;
        const label = TOOL_LABELS[resolvedName] || resolvedName || "Working";
        const step = {
            name: resolvedName, label, toolCallId,
            status: "running",
            startTime: Date.now(),
            endTime: null,
        };
        this.#toolSteps.push(step);

        // If current phase already has response text, start a new phase
        const phase = this.#ensurePhase();
        if (phase.text.trim()) {
            this.#currentPhase = null; // force new phase
            this.#ensurePhase().tools.push(step);
        } else {
            phase.tools.push(step);
        }
        this.#scheduleRender();
    }

    /** Tool completed. */
    onToolEnd({ toolCallId, error, status }) {
        if (this.#finalized) return;
        const step = this.#toolSteps.find(s => s.toolCallId === toolCallId);
        if (step) {
            step.status = (error || status === "failed") ? "error" : "done";
            step.endTime = Date.now();
        }
        // Also update in the phase's tool list
        for (const phase of this.#phases) {
            const phaseStep = phase.tools.find(s => s.toolCallId === toolCallId);
            if (phaseStep) {
                phaseStep.status = step.status;
                phaseStep.endTime = step.endTime;
            }
        }
        this.#scheduleRender();
    }

    /** Plan entries received. */
    onPlan(entries) {
        if (this.#finalized) return;
        this.#planEntries = entries;
        this.#scheduleRender();
    }

    /** Agent turn ended — snapshot current text for multi-turn display. */
    onTurnEnd() {
        if (this.#finalized) return;
        // Close current phase, next text starts a new one
        this.#currentPhase = null;
    }

    /** Finalize the response — render final message with expandable details. */
    async finalize(replyMarkup = null) {
        if (this.#finalized) return;
        this.#finalized = true;
        if (this.#renderTimer) { clearTimeout(this.#renderTimer); this.#renderTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }

        const html = this.#renderFinal(replyMarkup);
        await this.#commitFinal(html, replyMarkup);

        if (this.#ref && this.#messageId && this.#messageId > 0) {
            this.#telegram.setMessageReaction(this.#ref.chatId, this.#messageId, "✅").catch(() => {});
        }
    }

    /** Abort — error state. */
    async abort(errorMessage = "Something went wrong.") {
        if (this.#finalized) return;
        this.#finalized = true;
        if (this.#renderTimer) { clearTimeout(this.#renderTimer); this.#renderTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }

        const html = `⚠️ ${escapeHtml(errorMessage)}`;
        await this.#commitFinal(html, null);
    }

    /** Get elapsed time since start. */
    get elapsedMs() {
        return this.#startTime ? Date.now() - this.#startTime : 0;
    }

    /** Get a progress snapshot for external queries. */
    getProgress() {
        const elapsed = this.elapsedMs;
        const running = this.#toolSteps.filter(s => s.status === "running");
        const done = this.#toolSteps.filter(s => s.status === "done").length;
        const currentPlan = this.#planEntries.find(e => e.status === "in_progress");
        const responseText = this.#phases.map(p => p.text).join("").trim();
        return {
            state: this.#finalized ? "done" : (responseText ? "writing" : running.length > 0 ? "tools" : "thinking"),
            elapsedSec: Math.round(elapsed / 1000),
            toolsRunning: running.map(s => s.label),
            toolsDone: done,
            planStep: currentPlan?.content || null,
            hasText: responseText.length > 0,
            textPreview: responseText.slice(0, 100),
        };
    }

    // ── Private: Phase Management ────────────────────────────

    /** Ensure a current phase exists. Creates one if needed. */
    #ensurePhase() {
        if (!this.#currentPhase) {
            this.#currentPhase = { thinking: "", tools: [], text: "" };
            this.#phases.push(this.#currentPhase);
        }
        return this.#currentPhase;
    }

    // ── Private: Rendering ───────────────────────────────────

    /**
     * Determine whether to use draft mode (sendMessageDraft) for this ref.
     * Draft mode only works in private DMs without topic threads.
     */
    #shouldUseDraft(ref) {
        switch (this.#transportConfig) {
        case "off":
        case "edit":
            return false;
        case "draft":
            // Force draft — but only if technically supported (private chat)
            return ref.chatType === "private";
        case "auto":
        default:
            // Auto: draft for private DMs without topic threads
            // DM topics likely need edit mode (sendMessageDraft may not work in threads)
            return ref.chatType === "private" && !ref.threadId;
        }
    }

    /** Periodically trigger re-render to keep elapsed timer fresh. */
    #scheduleElapsedUpdate() {
        if (this.#finalized) return;
        const age = this.#startTime ? (Date.now() - this.#startTime) / 1000 : 0;
        // Adaptive interval: fast initially, slow down as turn gets longer
        let delay;
        if (age < 10) delay = 3000;
        else if (age < 30) delay = 5000;
        else if (age < 60) delay = 8000;
        else delay = 15000;

        this.#elapsedTimer = setTimeout(() => {
            this.#elapsedTimer = null;
            if (!this.#finalized) {
                this.#lastRendered = ""; // force re-render (timer changed)
                this.#scheduleRender();
                this.#scheduleElapsedUpdate();
            }
        }, delay);
    }

    #scheduleRender() {
        if (this.#renderTimer || this.#finalized) return;
        const elapsed = Date.now() - this.#lastRenderTime;
        // Adaptive throttling: faster early, slower as response gets long
        const age = this.#startTime ? (Date.now() - this.#startTime) / 1000 : 0;
        const throttle = this.#draftMode
            ? DRAFT_THROTTLE_MS
            : (age > 30 ? 3000 : EDIT_THROTTLE_MS);
        const delay = Math.max(0, throttle - elapsed);
        this.#renderTimer = setTimeout(() => {
            this.#renderTimer = null;
            this.#renderProgress().catch(err =>
                log.warn(`Render error: ${err.message}`)
            );
        }, delay);
    }

    async #renderProgress() {
        if (this.#finalized) return;
        if (this.#messageId === -2) return; // "off" mode — no progress updates

        const html = this.#buildProgressHtml();
        if (html === this.#lastRendered) return;
        // In draft mode, always send; in edit mode, require meaningful change
        if (!this.#draftMode && Math.abs(html.length - this.#lastRendered.length) < EDIT_MIN_CHARS
            && !html.includes("⏱")) return;

        this.#lastRendered = html;
        this.#lastRenderTime = Date.now();

        if (this.#draftMode) {
            await this.#sendDraft(html);
        } else if (this.#messageId) {
            await this.#editMessage(html);
        }
    }

    /** Build progress HTML — VSCode-style: tool status during thinking, text when writing. */
    #buildProgressHtml() {
        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` <i>(${elapsed}s)</i>` : "";

        const parts = [];

        // Render completed phases as collapsed thinking blocks
        for (let i = 0; i < this.#phases.length - 1; i++) {
            const phase = this.#phases[i];
            if (phase.tools.length > 0) {
                const toolLines = phase.tools.map(s => {
                    const icon = s.status === "done" ? "✅" : s.status === "error" ? "⚠️" : "⏳";
                    const dur = s.endTime ? ` ${((s.endTime - s.startTime) / 1000).toFixed(1)}s` : "";
                    return `${icon} ${escapeHtml(s.label)}${dur}`;
                }).join("\n");
                parts.push(`<blockquote expandable>🧠 ${phase.tools.length} steps\n${toolLines}</blockquote>`);
            }
            // Show response text from completed phases
            if (phase.text.trim()) {
                parts.push(markdownToTelegramHtml(phase.text));
            }
        }

        // Current (last) phase — show live progress
        const current = this.#phases.length > 0 ? this.#phases[this.#phases.length - 1] : null;

        if (current?.text.trim()) {
            // Agent is writing response — stream it clean
            parts.push(markdownToTelegramHtml(current.text));

            // Show any still-running tools below
            const running = current.tools.filter(s => s.status === "running");
            if (running.length > 0) {
                parts.push(`\n<blockquote>${running.map(s => `⏳ ${escapeHtml(s.label)}...`).join("\n")}</blockquote>`);
            }
        } else if (current?.tools.length > 0) {
            // Agent is thinking/using tools — show compact status
            const running = current.tools.filter(s => s.status === "running");
            const doneCount = current.tools.filter(s => s.status === "done").length;

            if (running.length > 0) {
                parts.push(`🔧 <i>${escapeHtml(running[running.length - 1].label)}...</i>${timer}`);
            } else if (doneCount > 0) {
                parts.push(`🤔 <i>Processing...</i>${timer}`);
            }

            // Show recent tools
            const recent = current.tools.slice(-5);
            const toolLines = recent.map(s => {
                const icon = s.status === "done" ? "✅" : s.status === "error" ? "⚠️" : "⏳";
                const dur = s.endTime ? ` ${((s.endTime - s.startTime) / 1000).toFixed(1)}s` : "";
                return `${icon} ${escapeHtml(s.label)}${dur}`;
            }).join("\n");
            if (doneCount > 0) parts.push(`${doneCount} done · ${running.length} running`);
            parts.push(`<blockquote>${toolLines}</blockquote>`);
        } else {
            // No tools, no text — pure thinking
            parts.push(`🤔 <i>Thinking...</i>${timer}`);
        }

        // Plan (if any)
        if (this.#planEntries.length > 0) {
            const currentPlan = this.#planEntries.find(e => e.status === "in_progress");
            if (currentPlan) {
                let desc = currentPlan.content || "";
                if (desc.length > 80) desc = desc.slice(0, 77) + "…";
                parts.push(`📋 <i>${escapeHtml(desc)}</i>`);
            }
        }

        return this.#truncate(parts.join("\n") || `🤔 <i>Thinking...</i>${timer}`);
    }

    /** Build final HTML — clean response + collapsed thinking phases. */
    #renderFinal(replyMarkup) {
        const parts = [];
        const thinkingBlocks = [];
        let totalToolCount = 0;

        for (const phase of this.#phases) {
            if (phase.tools.length > 0) {
                totalToolCount += phase.tools.length;
                const toolLines = phase.tools.map(s => {
                    const icon = s.status === "done" ? "✅" : s.status === "error" ? "⚠️" : "⏳";
                    const dur = s.endTime ? `${((s.endTime - s.startTime) / 1000).toFixed(1)}s` : "";
                    return `${icon} ${escapeHtml(s.label)} ${dur}`;
                }).join("\n");
                thinkingBlocks.push(toolLines);
            }

            if (phase.text.trim()) {
                parts.push(markdownToTelegramHtml(phase.text));
            }
        }

        if (parts.length === 0) {
            parts.push("Done ✅");
        }

        // Append collapsed thinking/tool summary
        let toolSuffix = "";
        if (thinkingBlocks.length > 0) {
            const elapsed = ((Date.now() - this.#startTime) / 1000).toFixed(1);
            const allToolLines = thinkingBlocks.join("\n");
            toolSuffix = `\n\n<blockquote expandable>📋 ${totalToolCount} steps · ${elapsed}s\n${allToolLines}</blockquote>`;
        }

        const fullHtml = parts.join("\n") + toolSuffix;

        // If it fits in one message, done
        if (fullHtml.length <= MAX_MSG_LEN) return fullHtml;

        // Split into pages — store overflow for multi-message send in commitFinal
        this.#overflowPages = this.#splitForTelegram(parts.join("\n"), toolSuffix);
        return this.#overflowPages.shift();
    }

    /**
     * Split long HTML into Telegram-safe pages (~4000 chars each).
     * Splits at paragraph/code-block boundaries to avoid breaking formatting.
     */
    #splitForTelegram(contentHtml, toolSuffix) {
        const TARGET = MAX_MSG_LEN - 200; // room for tags/suffix on last page
        const pages = [];
        let remaining = contentHtml;

        while (remaining.length > TARGET) {
            let cutAt = TARGET;

            // Prefer splitting at double-newline (paragraph boundary)
            const paraBreak = remaining.lastIndexOf("\n\n", cutAt);
            if (paraBreak > TARGET * 0.3) {
                cutAt = paraBreak;
            } else {
                // Fall back to single newline
                const lineBreak = remaining.lastIndexOf("\n", cutAt);
                if (lineBreak > TARGET * 0.3) cutAt = lineBreak;
            }

            pages.push(this.#closeOpenTags(remaining.substring(0, cutAt)));
            remaining = remaining.substring(cutAt).replace(/^\n+/, "");
        }

        // Last page gets the tool suffix
        if (remaining.trim() || toolSuffix) {
            pages.push(this.#closeOpenTags(remaining + toolSuffix));
        }

        return pages;
    }

    /** Close any unclosed HTML tags in a fragment. */
    #closeOpenTags(html) {
        const openTags = [];
        const tagRe = /<\/?([a-z]+)[^>]*>/gi;
        let m;
        while ((m = tagRe.exec(html))) {
            const tag = m[1].toLowerCase();
            if (m[0].startsWith("</")) {
                const idx = openTags.lastIndexOf(tag);
                if (idx !== -1) openTags.splice(idx, 1);
            } else if (!m[0].endsWith("/>")) {
                openTags.push(tag);
            }
        }
        let closed = html;
        for (let i = openTags.length - 1; i >= 0; i--) {
            closed += `</${openTags[i]}>`;
        }
        return closed;
    }

    // ── Private: Telegram Transport ──────────────────────────

    async #sendDraft(html) {
        if (this.#draftSending || this.#draftFailures >= 3) {
            // Fallback to regular message on repeated failures
            if (this.#draftFailures >= 3 && this.#messageId === -1) {
                this.#draftMode = false;
                const params = withThread({ chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } }, this.#ref);
                const result = await this.#telegram.call("sendMessage", params);
                this.#messageId = result?.message_id ?? null;
            }
            return;
        }
        this.#draftSending = true;
        try {
            await this.#telegram.sendMessageDraft(
                this.#ref.chatId, this.#draftId, html, "HTML"
            );
        } catch (err) {
            this.#draftFailures++;
            log.debug(`Draft send failed (${this.#draftFailures}): ${err.message}`);
        } finally {
            this.#draftSending = false;
        }
    }

    async #editMessage(html) {
        try {
            await this.#telegram.editMessageText(
                this.#ref.chatId, this.#messageId, html, "HTML"
            );
        } catch (err) {
            if (err.message?.includes("message is not modified")) return;
            log.debug(`Edit failed: ${err.message}`);
            // Try plain text fallback
            const plain = stripHtmlKeepStructure(html);
            await this.#telegram.editMessageText(
                this.#ref.chatId, this.#messageId, plain
            ).catch(() => {});
        }
    }

    async #commitFinal(html, replyMarkup) {
        if (this.#draftMode) {
            await this.#sendDraft(html);
            try {
                const params = withThread({ chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } }, this.#ref);
                if (replyMarkup) params.reply_markup = replyMarkup;
                const result = await this.#telegram.call("sendMessage", params);
                this.#messageId = result?.message_id ?? null;
                this.#telegram.sendMessageDraft(this.#ref.chatId, this.#draftId, null).catch(() => {});
            } catch (err) {
                log.warn(`Final send failed: ${err.message}`);
                const plain = stripHtmlKeepStructure(html);
                const fallbackParams = withThread({ chat_id: this.#ref.chatId, text: plain,
                    link_preview_options: { is_disabled: true } }, this.#ref);
                const result = await this.#telegram.call("sendMessage", fallbackParams);
                this.#messageId = result?.message_id ?? null;
            }
        } else if (this.#messageId && this.#messageId !== -2) {
            try {
                const params = { chat_id: this.#ref.chatId, message_id: this.#messageId,
                    text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
                if (replyMarkup) params.reply_markup = replyMarkup;
                await this.#telegram.call("editMessageText", params);
            } catch (err) {
                if (!err.message?.includes("message is not modified")) {
                    log.warn(`Final edit failed: ${err.message}`);
                    const plain = stripHtmlKeepStructure(html);
                    await this.#telegram.editMessageText(
                        this.#ref.chatId, this.#messageId, plain
                    ).catch(() => {});
                }
            }
        } else {
            try {
                const params = withThread({ chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } }, this.#ref);
                if (replyMarkup) params.reply_markup = replyMarkup;
                const result = await this.#telegram.call("sendMessage", params);
                this.#messageId = result?.message_id ?? null;
            } catch (err) {
                log.warn(`Fresh send failed: ${err.message}`);
                const plain = stripHtmlKeepStructure(html);
                const params = withThread({ chat_id: this.#ref.chatId, text: plain,
                    link_preview_options: { is_disabled: true } }, this.#ref);
                const result = await this.#telegram.call("sendMessage", params).catch(() => null);
                this.#messageId = result?.message_id ?? null;
            }
        }

        // Send overflow pages as follow-up messages
        if (this.#overflowPages?.length > 0) {
            for (const page of this.#overflowPages) {
                try {
                    const params = withThread({ chat_id: this.#ref.chatId, text: page, parse_mode: "HTML",
                        link_preview_options: { is_disabled: true } }, this.#ref);
                    await this.#telegram.call("sendMessage", params);
                } catch (err) {
                    log.warn(`Overflow page send failed: ${err.message}`);
                    const plain = stripHtmlKeepStructure(page);
                    await this.#telegram.call("sendMessage", withThread({
                        chat_id: this.#ref.chatId, text: plain,
                        link_preview_options: { is_disabled: true },
                    }, this.#ref)).catch(() => {});
                }
            }
            this.#overflowPages = null;
        }
    }

    #truncate(html) {
        if (html.length <= MAX_MSG_LEN) return html;
        const suffix = "\n…(truncated)";
        let cutAt = MAX_MSG_LEN - 80; // extra room for closing tags + suffix
        // Scan backwards to find a position not inside a tag
        const lastOpenTag = html.lastIndexOf("<", cutAt);
        const lastCloseTag = html.lastIndexOf(">", cutAt);
        if (lastOpenTag > lastCloseTag) {
            cutAt = lastOpenTag;
        }
        // Also check for partial entities (&amp; etc)
        const lastAmp = html.lastIndexOf("&", cutAt);
        const lastSemi = html.lastIndexOf(";", cutAt);
        if (lastAmp > lastSemi && cutAt - lastAmp < 8) {
            cutAt = lastAmp;
        }
        let truncated = html.substring(0, cutAt) + suffix;
        // Close any unclosed HTML tags
        const openTags = [];
        const tagRe = /<\/?([a-z]+)[^>]*>/gi;
        let m;
        while ((m = tagRe.exec(truncated))) {
            const tag = m[1].toLowerCase();
            if (m[0].startsWith("</")) {
                const idx = openTags.lastIndexOf(tag);
                if (idx !== -1) openTags.splice(idx, 1);
            } else if (!m[0].endsWith("/>")) {
                openTags.push(tag);
            }
        }
        for (let i = openTags.length - 1; i >= 0; i--) {
            truncated += `</${openTags[i]}>`;
        }
        return truncated;
    }
}
