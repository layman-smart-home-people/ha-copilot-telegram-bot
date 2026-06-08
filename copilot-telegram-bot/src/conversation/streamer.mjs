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
};

export class ResponseStreamer {
    #telegram;
    #ref;             // { chatId, threadId?, chatType }
    #messageId = null;
    #draftMode = false;
    #draftId = null;
    #transportConfig;  // 'auto' | 'draft' | 'edit' | 'off'

    // Content accumulation
    #textBuffer = "";
    #thoughtBuffer = "";
    #toolSteps = [];  // { name, label, status: 'running'|'done'|'error', startTime }
    #planEntries = [];

    // Rendering state
    #lastRendered = "";
    #lastRenderTime = 0;
    #renderTimer = null;
    #elapsedTimer = null;
    #finalized = false;
    #startTime = null;
    #inflightRender = null;  // Promise tracking in-flight edit

    // Draft tracking
    #draftFailures = 0;
    #draftSending = false;

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
        this.#textBuffer = "";
        this.#thoughtBuffer = "";
        this.#toolSteps = [];
        this.#planEntries = [];
        this.#lastRendered = "";
        this.#lastRenderTime = 0;
        this.#finalized = false;
        this.#startTime = Date.now();
        this.#draftFailures = 0;
        this.#draftSending = false;
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
            this.#draftId = `stream-${Date.now()}`;
            this.#messageId = -1; // sentinel for draft mode
            await this.#sendDraft("🤔 Thinking...");
        } else if (this.#transportConfig === "off") {
            // No progress updates — send final as fresh message
            this.#draftMode = false;
            this.#messageId = -2; // sentinel: active but no progress
        } else {
            this.#draftMode = false;
            const params = {
                chat_id: ref.chatId, text: "🤔 <i>Thinking...</i>",
                parse_mode: "HTML", disable_notification: true,
            };
            if (ref.threadId) params.message_thread_id = ref.threadId;
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
        this.#textBuffer += text;
        this.#scheduleRender();
    }

    /** Stream a thought chunk (shown during processing, hidden in final). */
    onThoughtChunk(text) {
        if (this.#finalized) return;
        this.#thoughtBuffer += text;
        this.#scheduleRender();
    }

    /** Tool started. */
    onToolStart({ toolName, name, toolCallId }) {
        if (this.#finalized) return;
        const resolvedName = toolName || name;
        const label = TOOL_LABELS[resolvedName] || resolvedName || "Working";
        this.#toolSteps.push({
            name: resolvedName, label, toolCallId,
            status: "running",
            startTime: Date.now(),
            endTime: null,
        });
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
        this.#scheduleRender();
    }

    /** Plan entries received. */
    onPlan(entries) {
        if (this.#finalized) return;
        this.#planEntries = entries;
        this.#scheduleRender();
    }

    /** Finalize the response — render final message with expandable details. */
    async finalize(replyMarkup = null) {
        if (this.#finalized) return;
        this.#finalized = true;
        if (this.#renderTimer) { clearTimeout(this.#renderTimer); this.#renderTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }

        const html = this.#renderFinal(replyMarkup);
        await this.#commitFinal(html, replyMarkup);

        // React with ✅ (only on real messages, not sentinels)
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

    /** Get a progress snapshot for external queries (e.g., "what's it doing?"). */
    getProgress() {
        const elapsed = this.elapsedMs;
        const running = this.#toolSteps.filter(s => s.status === "running");
        const done = this.#toolSteps.filter(s => s.status === "done").length;
        const currentPlan = this.#planEntries.find(e => e.status === "in_progress");
        return {
            state: this.#finalized ? "done" : (this.#textBuffer ? "writing" : running.length > 0 ? "tools" : "thinking"),
            elapsedSec: Math.round(elapsed / 1000),
            toolsRunning: running.map(s => s.label),
            toolsDone: done,
            planStep: currentPlan?.content || null,
            hasText: this.#textBuffer.length > 0,
            textPreview: this.#textBuffer.slice(0, 100),
        };
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

    /** Build rich progress HTML — thinking, tools, plan, streaming text. */
    #buildProgressHtml() {
        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` <i>(${elapsed}s)</i>` : "";

        // Phase 1: Streaming text is present — show it with active tool indicator
        if (this.#textBuffer) {
            const parts = [];
            const converted = markdownToTelegramHtml(this.#textBuffer);
            parts.push(converted);

            // Show active tools below text
            const running = this.#toolSteps.filter(s => s.status === "running");
            if (running.length > 0) {
                const toolLines = running.map(s => `⏳ ${escapeHtml(s.label)}...`).join("\n");
                parts.push("");
                parts.push(`<blockquote>${toolLines}</blockquote>`);
            }
            return this.#truncate(parts.join("\n"));
        }

        // Phase 2: No text yet — show rich status
        const parts = [];

        // Header: current status indicator
        const running = this.#toolSteps.filter(s => s.status === "running");
        const doneCount = this.#toolSteps.filter(s => s.status === "done").length;

        if (this.#thoughtBuffer && elapsed >= 2) {
            // Show live reasoning (last meaningful line)
            const lines = this.#thoughtBuffer.split("\n").filter(l => l.trim());
            const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
            const display = lastLine.length > 180 ? "…" + lastLine.slice(-180) : lastLine;
            if (display) {
                parts.push(`🧠 <i>${escapeHtml(display)}</i>${timer}`);
            } else {
                parts.push(`🤔 <i>Thinking...</i>${timer}`);
            }
        } else if (running.length > 0) {
            // Active tool with name
            const current = running[running.length - 1];
            parts.push(`🔧 <i>${escapeHtml(current.label)}...</i>${timer}`);
        } else if (doneCount > 0) {
            // Between tools — processing results
            parts.push(`🤔 <i>Processing results...</i>${timer}`);
        } else {
            parts.push(`🤔 <i>Thinking...</i>${timer}`);
        }

        // Tool progress summary (compact)
        if (this.#toolSteps.length > 0) {
            const statusParts = [];
            if (doneCount > 0) statusParts.push(`✅ ${doneCount} done`);
            if (running.length > 0) statusParts.push(`🔄 ${running.length} running`);
            if (statusParts.length > 0) {
                parts.push(statusParts.join(" · "));
            }

            // Show last few tools as blockquote
            const recent = this.#toolSteps.slice(-4);
            const toolLines = recent.map(s => {
                const icon = s.status === "done" ? "✅" : s.status === "error" ? "⚠️" : "⏳";
                const dur = s.endTime ? ` ${((s.endTime - s.startTime) / 1000).toFixed(1)}s` : "";
                return `${icon} ${escapeHtml(s.label)}${dur}`;
            }).join("\n");
            parts.push(`<blockquote>${toolLines}</blockquote>`);
        }

        // Plan entries (if any)
        if (this.#planEntries.length > 0) {
            const current = this.#planEntries.find(e => e.status === "in_progress");
            if (current) {
                let desc = current.content || "";
                if (desc.length > 80) desc = desc.slice(0, 77) + "…";
                parts.push(`📋 <i>${escapeHtml(desc)}</i>`);
            }
        }

        const html = parts.join("\n") || `🤔 <i>Thinking...</i>${timer}`;
        return this.#truncate(html);
    }

    /** Build final HTML: content + expandable tool details. */
    #renderFinal(replyMarkup) {
        const parts = [];

        // Main content
        if (this.#textBuffer) {
            parts.push(markdownToTelegramHtml(this.#textBuffer));
        } else {
            parts.push("Done ✅");
        }

        // Expandable details: tool steps (only if there were tools)
        if (this.#toolSteps.length > 0) {
            const elapsed = ((Date.now() - this.#startTime) / 1000).toFixed(1);
            const toolLines = this.#toolSteps.map(s => {
                const icon = s.status === "done" ? "✅" : s.status === "error" ? "⚠️" : "⏳";
                const dur = s.endTime ? `${((s.endTime - s.startTime) / 1000).toFixed(1)}s` : "";
                return `${icon} ${escapeHtml(s.label)} ${dur}`;
            }).join("\n");

            parts.push("");
            parts.push(`<blockquote expandable>📋 ${this.#toolSteps.length} steps · ${elapsed}s\n${toolLines}</blockquote>`);
        }

        return this.#truncate(parts.join("\n"));
    }

    // ── Private: Telegram Transport ──────────────────────────

    async #sendDraft(html) {
        if (this.#draftSending || this.#draftFailures >= 3) {
            // Fallback to regular message on repeated failures
            if (this.#draftFailures >= 3 && this.#messageId === -1) {
                this.#draftMode = false;
                const params = { chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } };
                if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;
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
            // Send draft with final text, then commit (sendMessage with reply_to draft)
            await this.#sendDraft(html);
            // For drafts, we need to send a real message as well since drafts are ephemeral
            try {
                const params = { chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } };
                if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;
                if (replyMarkup) params.reply_markup = replyMarkup;
                const result = await this.#telegram.call("sendMessage", params);
                this.#messageId = result?.message_id ?? null;
                // Clear the draft
                this.#telegram.sendMessageDraft(this.#ref.chatId, this.#draftId, null).catch(() => {});
            } catch (err) {
                log.warn(`Final send failed: ${err.message}`);
                // Fallback: try plain text
                const plain = stripHtmlKeepStructure(html);
                const fallbackParams = { chat_id: this.#ref.chatId, text: plain,
                    link_preview_options: { is_disabled: true } };
                if (this.#ref.threadId) fallbackParams.message_thread_id = this.#ref.threadId;
                const result = await this.#telegram.call("sendMessage", fallbackParams);
                this.#messageId = result?.message_id ?? null;
            }
        } else if (this.#messageId && this.#messageId !== -2) {
            // Edit existing message to final content
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
            // "off" mode or no messageId — send final as fresh message
            try {
                const params = { chat_id: this.#ref.chatId, text: html, parse_mode: "HTML",
                    link_preview_options: { is_disabled: true } };
                if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;
                if (replyMarkup) params.reply_markup = replyMarkup;
                const result = await this.#telegram.call("sendMessage", params);
                this.#messageId = result?.message_id ?? null;
            } catch (err) {
                log.warn(`Fresh send failed: ${err.message}`);
                const plain = stripHtmlKeepStructure(html);
                const params = { chat_id: this.#ref.chatId, text: plain,
                    link_preview_options: { is_disabled: true } };
                if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;
                const result = await this.#telegram.call("sendMessage", params).catch(() => null);
                this.#messageId = result?.message_id ?? null;
            }
        }
    }

    #truncate(html) {
        if (html.length <= MAX_MSG_LEN) return html;
        // Find safe truncation point — avoid cutting inside HTML tags or entities
        let cutAt = MAX_MSG_LEN - 30;
        // Scan backwards to find a position not inside a tag
        const lastOpenTag = html.lastIndexOf("<", cutAt);
        const lastCloseTag = html.lastIndexOf(">", cutAt);
        if (lastOpenTag > lastCloseTag) {
            // We're inside a tag — cut before it
            cutAt = lastOpenTag;
        }
        // Also check for partial entities (&amp; etc)
        const lastAmp = html.lastIndexOf("&", cutAt);
        const lastSemi = html.lastIndexOf(";", cutAt);
        if (lastAmp > lastSemi && cutAt - lastAmp < 8) {
            cutAt = lastAmp;
        }
        return html.substring(0, cutAt) + "\n…(truncated)";
    }
}
