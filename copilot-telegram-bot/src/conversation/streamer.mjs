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
};

export class ResponseStreamer {
    #telegram;
    #ref;             // { chatId, threadId?, chatType }
    #messageId = null;
    #draftMode = false;
    #draftId = null;

    // Content accumulation
    #textBuffer = "";
    #thoughtBuffer = "";
    #toolSteps = [];  // { name, label, status: 'running'|'done'|'error', startTime }
    #planEntries = [];

    // Rendering state
    #lastRendered = "";
    #lastRenderTime = 0;
    #renderTimer = null;
    #finalized = false;
    #startTime = null;

    // Draft tracking
    #draftFailures = 0;
    #draftSending = false;

    constructor(telegram) {
        this.#telegram = telegram;
    }

    get active() { return this.#messageId !== null && !this.#finalized; }
    get messageId() { return this.#messageId; }

    // ── Lifecycle ────────────────────────────────────────────

    /** Start streaming for a new prompt. Returns the placeholder message ID. */
    async start(ref) {
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

        // Use draft mode for private chats
        if (ref.chatType === "private") {
            this.#draftMode = true;
            this.#draftId = `stream-${Date.now()}`;
            this.#messageId = -1; // sentinel for draft mode
            await this.#sendDraft("⚡ Working...");
        } else {
            this.#draftMode = false;
            const result = await this.#telegram.sendMessage(
                ref.chatId, "⚡ Working...", null, null
            );
            this.#messageId = result?.result?.message_id ?? null;
        }

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
    onToolStart({ name, toolCallId }) {
        if (this.#finalized) return;
        const label = TOOL_LABELS[name] || name;
        this.#toolSteps.push({
            name, label, toolCallId,
            status: "running",
            startTime: Date.now(),
            endTime: null,
        });
        this.#scheduleRender();
    }

    /** Tool completed. */
    onToolEnd({ toolCallId, error }) {
        if (this.#finalized) return;
        const step = this.#toolSteps.find(s => s.toolCallId === toolCallId);
        if (step) {
            step.status = error ? "error" : "done";
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
        if (this.#renderTimer) {
            clearTimeout(this.#renderTimer);
            this.#renderTimer = null;
        }

        const html = this.#renderFinal(replyMarkup);
        await this.#commitFinal(html, replyMarkup);

        // React with ✅
        if (this.#ref && this.#messageId && this.#messageId !== -1) {
            this.#telegram.setMessageReaction(this.#ref.chatId, this.#messageId, "✅").catch(() => {});
        }
    }

    /** Abort — error state. */
    async abort(errorMessage = "Something went wrong.") {
        if (this.#finalized) return;
        this.#finalized = true;
        if (this.#renderTimer) {
            clearTimeout(this.#renderTimer);
            this.#renderTimer = null;
        }

        const html = `⚠️ ${escapeHtml(errorMessage)}`;
        await this.#commitFinal(html, null);
    }

    /** Get elapsed time since start. */
    get elapsedMs() {
        return this.#startTime ? Date.now() - this.#startTime : 0;
    }

    // ── Private: Rendering ───────────────────────────────────

    #scheduleRender() {
        if (this.#renderTimer || this.#finalized) return;
        const elapsed = Date.now() - this.#lastRenderTime;
        const throttle = this.#draftMode ? DRAFT_THROTTLE_MS : EDIT_THROTTLE_MS;
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

        const html = this.#buildProgressHtml();
        if (html === this.#lastRendered) return;
        if (!this.#draftMode && html.length - this.#lastRendered.length < EDIT_MIN_CHARS) return;

        this.#lastRendered = html;
        this.#lastRenderTime = Date.now();

        if (this.#draftMode) {
            await this.#sendDraft(html);
        } else if (this.#messageId) {
            await this.#editMessage(html);
        }
    }

    /** Build progress HTML: text so far + active tool indicator. */
    #buildProgressHtml() {
        const parts = [];

        // Active text
        if (this.#textBuffer) {
            const converted = markdownToTelegramHtml(this.#textBuffer);
            parts.push(converted);
        }

        // Active tools indicator (non-expandable during streaming)
        const running = this.#toolSteps.filter(s => s.status === "running");
        if (running.length > 0) {
            const toolLines = running.map(s => `⏳ ${escapeHtml(s.label)}...`).join("\n");
            if (parts.length > 0) parts.push("");
            parts.push(`<blockquote>${toolLines}</blockquote>`);
        } else if (!this.#textBuffer && this.#toolSteps.length > 0) {
            // No text yet but tools have run — show what just finished
            const last = this.#toolSteps[this.#toolSteps.length - 1];
            const icon = last.status === "done" ? "✅" : "⚠️";
            parts.push(`<blockquote>${icon} ${escapeHtml(last.label)}</blockquote>`);
        } else if (!this.#textBuffer && this.#thoughtBuffer) {
            // Only thoughts — show thinking indicator
            parts.push("💭 Thinking...");
        }

        const html = parts.join("\n") || "⚡ Working...";
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
                const result = await this.#telegram.sendMessage(this.#ref.chatId, html, "HTML");
                this.#messageId = result?.result?.message_id ?? null;
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
                this.#messageId = result?.result?.message_id ?? null;
                // Clear the draft
                this.#telegram.sendMessageDraft(this.#ref.chatId, this.#draftId, null).catch(() => {});
            } catch (err) {
                log.warn(`Final send failed: ${err.message}`);
                // Fallback: try plain text
                const plain = stripHtmlKeepStructure(html);
                const result = await this.#telegram.sendMessage(this.#ref.chatId, plain);
                this.#messageId = result?.result?.message_id ?? null;
            }
        } else if (this.#messageId) {
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
        }
    }

    #truncate(html) {
        if (html.length <= MAX_MSG_LEN) return html;
        // Truncate preserving HTML safety
        return html.substring(0, MAX_MSG_LEN - 20) + "\n…(truncated)";
    }
}
