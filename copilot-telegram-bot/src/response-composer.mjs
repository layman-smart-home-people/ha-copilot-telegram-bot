// ============================================================
// Response Composer — Unified progressive message for Telegram
// ============================================================
// Manages a single evolving message that shows:
// 1. "🤔 Thinking..." placeholder
// 2. Tool call progress (expandable blockquote)
// 3. Streaming answer text (throttled edits)
// 4. Final answer with collapsed tool steps

import { escapeHtml, markdownToTelegramHtml, chunkMessage, stripHtmlKeepStructure } from "./formatter.mjs";

const EDIT_MIN_CHARS = 50;          // min new chars before editing (private chat)
const EDIT_MIN_INTERVAL_MS = 1500;  // min time between edits
const MAX_MSG_LEN = 4096;           // Telegram message length limit

export class ResponseComposer {
    #telegram;
    #ref;           // { chatId, threadId? }
    #messageId = null;
    #toolSteps = [];
    #textBuffer = "";
    #lastEditedText = "";
    #lastEditTime = 0;
    #editTimer = null;
    #finalized = false;
    #editRetries = 0;
    #startTime = null;
    #permissionPending = false;
    #elapsedTimer = null;
    #log;
    #thoughtBuffer = "";
    #thoughtActive = true;
    #trailingHtml = null;

    constructor(telegram, log = () => {}) {
        this.#telegram = telegram;
        this.#log = log;
    }

    get active() { return this.#messageId !== null && !this.#finalized; }
    get messageId() { return this.#messageId; }
    get trailingHtml() { return this.#trailingHtml; }

    /**
     * Send initial placeholder message.
     */
    async start(ref) {
        this.#ref = ref;
        this.#toolSteps = [];
        this.#textBuffer = "";
        this.#lastEditedText = "";
        this.#lastEditTime = 0;
        this.#finalized = false;
        this.#startTime = Date.now();
        this.#permissionPending = false;
        this.#thoughtBuffer = "";
        this.#thoughtActive = true;

        // Periodic elapsed time updates (every 5s)
        this.#elapsedTimer = setInterval(() => this.#scheduleEdit(true), 5000);

        const params = {
            chat_id: ref.chatId,
            text: "🤔 <i>Thinking...</i>",
            parse_mode: "HTML",
            disable_notification: true,
        };
        if (ref.threadId) params.message_thread_id = ref.threadId;
        if (ref.triggerMessageId && (ref.chatType === "group" || ref.chatType === "supergroup")) {
            params.reply_to_message_id = ref.triggerMessageId;
        }

        try {
            const sent = await this.#telegram.call("sendMessage", params);
            this.#messageId = sent?.message_id;
            this.#log(`Composer: placeholder sent (msg=${this.#messageId})`);
        } catch (err) {
            this.#log(`Composer: placeholder failed: ${err.message}`);
            if (this.#elapsedTimer) {
                clearInterval(this.#elapsedTimer);
                this.#elapsedTimer = null;
            }
        }
    }

    /**
     * Add or update a tool call step.
     */
    addToolStep(toolCallId, description, status = "running") {
        if (this.#finalized || !this.#messageId) return;

        const existing = this.#toolSteps.find(s => s.id === toolCallId);
        if (existing) {
            existing.status = status;
            existing.description = description || existing.description;
        } else {
            this.#toolSteps.push({ id: toolCallId, description, status });
        }
        this.#scheduleEdit();
    }

    /**
     * Append streaming thought/reasoning text from the agent.
     */
    appendThought(text) {
        if (!this.active || !this.#thoughtActive) return;
        this.#thoughtBuffer += text;
        this.#scheduleEdit();
    }

    /**
     * Append streaming text from the agent.
     */
    appendText(text) {
        if (this.#finalized) return;
        if (this.#thoughtActive) {
            this.#thoughtActive = false;
        }
        this.#textBuffer += text;
        this.#scheduleEdit();
    }

    /**
     * Signal that the agent is waiting for user permission.
     */
    setPermissionPending(pending = true) {
        this.#permissionPending = pending;
        this.#scheduleEdit();
    }

    /**
     * Finalize with the complete response text.
     * Edits the placeholder into the answer.
     * Stores collapsible reasoning+steps in trailingHtml for the bridge to send.
     * Returns any overflow answer chunks that don't fit in the edited message.
     */
    async finalize(fullText) {
        if (this.#finalized) return [];
        this.#finalized = true;
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }
        if (this.#elapsedTimer) { clearInterval(this.#elapsedTimer); this.#elapsedTimer = null; }

        this.#textBuffer = fullText || this.#textBuffer;

        if (!this.#messageId) {
            return fullText ? chunkMessage(fullText) : [];
        }

        // Build collapsible details (reasoning + steps) for trailing message
        const detailsHtml = this.#buildCombinedDetailsHtml();
        if (detailsHtml) this.#trailingHtml = detailsHtml;

        const hasAnswer = this.#textBuffer.trim().length > 0;

        if (hasAnswer) {
            // Edit placeholder → answer
            const answerHtml = this.#convertAnswer(this.#textBuffer);
            if (answerHtml.length <= MAX_MSG_LEN) {
                await this.#editMessage(answerHtml);
                return [];
            }
            // Answer too long — edit first chunk, return rest
            const chunks = chunkMessage(this.#textBuffer);
            await this.#editMessage(this.#convertAnswer(chunks[0]));
            return chunks.slice(1);
        } else if (detailsHtml) {
            // No answer text, only details — put details in the placeholder directly
            this.#trailingHtml = null;
            await this.#editMessage(detailsHtml);
            return [];
        } else {
            // Nothing at all — delete placeholder
            await this.cleanup();
            return [];
        }
    }

    /**
     * Cancel/reset without finalizing (e.g., on error or disconnect).
     */
    async abort(errorMsg) {
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }
        if (this.#elapsedTimer) { clearInterval(this.#elapsedTimer); this.#elapsedTimer = null; }
        this.#finalized = true;

        if (this.#messageId && errorMsg) {
            await this.#editMessage(`⚠️ ${escapeHtml(errorMsg)}`);
        }
    }

    /**
     * Delete the placeholder message (if nothing useful was shown).
     */
    async cleanup() {
        if (this.#messageId && this.#ref) {
            try {
                await this.#telegram.call("deleteMessage", {
                    chat_id: this.#ref.chatId,
                    message_id: this.#messageId,
                });
            } catch {}
            this.#messageId = null;
        }
    }

    // --- Internal ---

    #scheduleEdit(forceAfterDelay = false) {
        if (this.#finalized || !this.#messageId) return;
        if (this.#editTimer) return; // already scheduled

        const elapsed = Date.now() - this.#lastEditTime;
        const newChars = this.#textBuffer.length - this.#lastEditedText.length;

        if (elapsed >= EDIT_MIN_INTERVAL_MS && (newChars >= EDIT_MIN_CHARS || forceAfterDelay)) {
            this.#doEdit();
        } else {
            const wait = Math.max(EDIT_MIN_INTERVAL_MS - elapsed, 300);
            this.#editTimer = setTimeout(() => {
                this.#editTimer = null;
                this.#doEdit();
            }, wait);
        }
    }

    #doEdit() {
        if (this.#finalized || !this.#messageId) return;

        const stepsHtml = this.#buildStepsHtml(false);
        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` <i>(${elapsed}s)</i>` : "";

        let html;
        if (this.#permissionPending) {
            // Waiting for user permission
            html = stepsHtml
                ? `🔐 <i>Awaiting permission...</i>${timer}\n${stepsHtml}`
                : `🔐 <i>Awaiting permission...</i>${timer}`;
        } else if (this.#thoughtActive && this.#thoughtBuffer) {
            // Live reasoning — only show after 3s to avoid flicker on fast responses
            if (elapsed >= 3) {
                const lines = this.#thoughtBuffer.split("\n").filter(l => l.trim());
                const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
                const display = lastLine.length > 200
                    ? "…" + lastLine.slice(-200)
                    : lastLine;
                const thoughtHtml = display
                    ? `🧠 <i>${escapeHtml(display)}</i>${timer}`
                    : `🤔 <i>Thinking...</i>${timer}`;
                html = stepsHtml ? `${thoughtHtml}\n${stepsHtml}` : thoughtHtml;
            } else {
                html = stepsHtml
                    ? `🤔 <i>Thinking...</i>${timer}\n${stepsHtml}`
                    : `🤔 <i>Thinking...</i>${timer}`;
            }
        } else if (stepsHtml) {
            // Show thinking indicator + tool steps
            html = `🤔 <i>Thinking...</i>${timer}\n${stepsHtml}`;
        } else if (this.#textBuffer.trim()) {
            // Text is streaming — show preview
            const preview = this.#textBuffer.trim().slice(0, 120);
            const truncated = this.#textBuffer.trim().length > 120 ? "..." : "";
            html = `✍️ <i>Writing response...</i>${timer}\n<blockquote>${escapeHtml(preview)}${truncated}</blockquote>`;
        } else {
            html = `🤔 <i>Thinking...</i>${timer}`;
        }

        // Truncate to Telegram limit
        if (html.length > MAX_MSG_LEN) {
            html = html.slice(0, MAX_MSG_LEN - 20) + "\n<i>...</i>";
        }

        this.#editMessage(html);
        this.#lastEditedText = this.#textBuffer;
        this.#lastEditTime = Date.now();
    }

    #buildStepsHtml(isFinal) {
        if (this.#toolSteps.length === 0) return "";

        const lines = this.#toolSteps.map(s => {
            const icon = s.status === "completed" ? "✅"
                       : s.status === "failed" ? "❌"
                       : "🔄";
            return `${icon} ${escapeHtml(s.description || s.id)}`;
        });

        const count = this.#toolSteps.length;
        const failedCount = this.#toolSteps.filter(s => s.status === "failed").length;
        const header = isFinal
            ? `🔧 <b>${count} step${count > 1 ? "s" : ""}${failedCount > 0 ? ` (${failedCount} failed)` : ""}</b>`
            : `🔧 <b>Steps:</b>`;

        return `<blockquote>${header}\n${lines.join("\n")}</blockquote>`;
    }

    #buildThoughtHtml() {
        if (!this.#thoughtBuffer.trim()) return "";
        const thought = this.#thoughtBuffer.trim();
        // Escape first, then truncate to avoid cutting HTML entities
        const escaped = escapeHtml(thought);
        const display = escaped.length > 2000
            ? escaped.slice(0, 2000) + "…"
            : escaped;
        return `<blockquote expandable>🧠 <b>Reasoning</b>\n${display}</blockquote>`;
    }

    /** Build a single collapsible blockquote combining reasoning + steps */
    #buildCombinedDetailsHtml() {
        const hasThought = this.#thoughtBuffer.trim().length > 0;
        const hasSteps = this.#toolSteps.length > 0;
        if (!hasThought && !hasSteps) return "";

        const parts = [];

        // Collapsed header line: "🧠 Reasoning · 🔧 N steps"
        const headerParts = [];
        if (hasThought) headerParts.push("🧠 Reasoning");
        if (hasSteps) {
            const count = this.#toolSteps.length;
            const failedCount = this.#toolSteps.filter(s => s.status === "failed").length;
            const suffix = failedCount > 0 ? ` (${failedCount} failed)` : "";
            headerParts.push(`🔧 ${count} step${count > 1 ? "s" : ""}${suffix}`);
        }
        parts.push(`<b>${headerParts.join(" · ")}</b>`);

        // Reasoning content
        if (hasThought) {
            const escaped = escapeHtml(this.#thoughtBuffer.trim());
            const display = escaped.length > 2000
                ? escaped.slice(0, 2000) + "…"
                : escaped;
            parts.push(display);
        }

        // Steps list
        if (hasSteps) {
            const lines = this.#toolSteps.map(s => {
                const icon = s.status === "completed" ? "✅"
                           : s.status === "failed" ? "❌"
                           : "🔄";
                return `${icon} ${escapeHtml(s.description || s.id)}`;
            });
            if (hasThought) parts.push("");  // blank line separator
            parts.push(`<b>Steps:</b>\n${lines.join("\n")}`);
        }

        let html = `<blockquote expandable>${parts.join("\n")}</blockquote>`;
        // Safety: truncate to Telegram limit
        if (html.length > MAX_MSG_LEN) {
            html = html.slice(0, MAX_MSG_LEN - 30) + "\n…</blockquote>";
        }
        return html;
    }

    #convertAnswer(markdown) {
        if (!markdown?.trim()) return "";
        try {
            return markdownToTelegramHtml(markdown);
        } catch {
            return escapeHtml(markdown);
        }
    }

    async #editMessage(html) {
        if (!this.#messageId || !this.#ref) return;
        try {
            await this.#telegram.call("editMessageText", {
                chat_id: this.#ref.chatId,
                message_id: this.#messageId,
                text: html,
                parse_mode: "HTML",
            });
            this.#editRetries = 0; // reset on success
        } catch (err) {
            if (/message is not modified/i.test(err?.message)) return;
            if (/can.t parse|entit/i.test(err?.message)) {
                // HTML parse error — try without parse_mode
                try {
                    await this.#telegram.call("editMessageText", {
                        chat_id: this.#ref.chatId,
                        message_id: this.#messageId,
                        text: stripHtmlKeepStructure(html),
                    });
                } catch {}
            } else if (/429|retry/i.test(err?.message)) {
                // Rate limited — retry with cap
                if (this.#editRetries >= 3) {
                    this.#log(`Composer: rate limit retry cap reached, dropping edit`);
                    return;
                }
                this.#editRetries++;
                // Parse retry_after from Telegram error: "Too Many Requests: retry after 5"
                const match = err?.message?.match(/retry after (\d+)/i);
                const retryMs = (match ? parseInt(match[1], 10) : 2) * 1000;
                this.#log(`Composer: rate limited, retry ${this.#editRetries}/3 in ${retryMs}ms`);
                setTimeout(() => this.#editMessage(html), retryMs);
            } else {
                this.#log(`Composer: edit error: ${err.message}`);
            }
        }
    }
}
