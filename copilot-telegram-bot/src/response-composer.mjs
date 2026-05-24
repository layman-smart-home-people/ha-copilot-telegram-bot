// ============================================================
// Response Composer — Unified progressive message for Telegram
// ============================================================
// Manages a single evolving message that shows:
// 1. "🤔 Thinking..." placeholder
// 2. Tool call progress (expandable blockquote)
// 3. Streaming answer text (throttled edits)
// 4. Final answer with collapsed tool steps

import { escapeHtml, markdownToTelegramHtml, chunkMessage } from "./formatter.mjs";

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
    #log;

    constructor(telegram, log = () => {}) {
        this.#telegram = telegram;
        this.#log = log;
    }

    get active() { return this.#messageId !== null && !this.#finalized; }
    get messageId() { return this.#messageId; }

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

        const params = {
            chat_id: ref.chatId,
            text: "🤔 <i>Thinking...</i>",
            parse_mode: "HTML",
        };
        if (ref.threadId) params.message_thread_id = ref.threadId;

        try {
            const sent = await this.#telegram.call("sendMessage", params);
            this.#messageId = sent?.message_id;
            this.#log(`Composer: placeholder sent (msg=${this.#messageId})`);
        } catch (err) {
            this.#log(`Composer: placeholder failed: ${err.message}`);
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
     * Append streaming text from the agent.
     */
    appendText(text) {
        if (this.#finalized) return;
        this.#textBuffer += text;
        this.#scheduleEdit();
    }

    /**
     * Finalize with the complete response text.
     * Returns any overflow chunks that don't fit in the edited message.
     */
    async finalize(fullText) {
        if (this.#finalized) return [];
        this.#finalized = true;
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }

        this.#textBuffer = fullText || this.#textBuffer;

        if (!this.#messageId) {
            return fullText ? chunkMessage(fullText) : [];
        }

        const stepsHtml = this.#buildStepsHtml(true);
        const hasSteps = this.#toolSteps.length > 0;
        const hasAnswer = this.#textBuffer.trim().length > 0;

        if (hasSteps && hasAnswer) {
            // Edit placeholder → collapsed steps summary
            await this.#editMessage(stepsHtml);
            // Return answer as separate message(s)
            return chunkMessage(this.#textBuffer);
        } else if (hasSteps && !hasAnswer) {
            // Only steps, no text answer — edit to show steps
            await this.#editMessage(stepsHtml);
            return [];
        } else if (!hasSteps && hasAnswer) {
            // No tool steps — edit placeholder into the answer directly
            const answerHtml = this.#convertAnswer(this.#textBuffer);
            if (answerHtml.length <= MAX_MSG_LEN) {
                await this.#editMessage(answerHtml);
                return [];
            }
            // Answer too long — edit first chunk, return rest
            const chunks = chunkMessage(this.#textBuffer);
            await this.#editMessage(this.#convertAnswer(chunks[0]));
            return chunks.slice(1);
        } else {
            // Nothing — delete placeholder
            await this.cleanup();
            return [];
        }
    }

    /**
     * Cancel/reset without finalizing (e.g., on error or disconnect).
     */
    async abort(errorMsg) {
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }
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

    #scheduleEdit() {
        if (this.#finalized || !this.#messageId) return;
        if (this.#editTimer) return; // already scheduled

        const elapsed = Date.now() - this.#lastEditTime;
        const newChars = this.#textBuffer.length - this.#lastEditedText.length;

        if (elapsed >= EDIT_MIN_INTERVAL_MS && newChars >= EDIT_MIN_CHARS) {
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

        let html;
        if (stepsHtml) {
            // Show thinking indicator + tool steps
            html = `🤔 <i>Thinking...</i>\n${stepsHtml}`;
        } else if (this.#textBuffer.trim()) {
            // No tool steps but text is streaming — show typing indicator
            html = "✍️ <i>Writing response...</i>";
        } else {
            html = "🤔 <i>Thinking...</i>";
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
        const header = isFinal
            ? `🔧 <b>${count} step${count > 1 ? "s" : ""} completed</b>`
            : `🔧 <b>Steps:</b>`;

        return `<blockquote expandable>${header}\n${lines.join("\n")}</blockquote>`;
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
        } catch (err) {
            if (/message is not modified/i.test(err?.message)) return;
            if (/can.t parse|entit/i.test(err?.message)) {
                // HTML parse error — try without parse_mode
                try {
                    await this.#telegram.call("editMessageText", {
                        chat_id: this.#ref.chatId,
                        message_id: this.#messageId,
                        text: html.replace(/<[^>]+>/g, ""), // strip HTML
                    });
                } catch {}
            } else if (/429|retry/i.test(err?.message)) {
                // Rate limited — retry after delay
                const retryMs = (err.retryAfter || 2) * 1000;
                this.#log(`Composer: rate limited, retry in ${retryMs}ms`);
                setTimeout(() => this.#editMessage(html), retryMs);
            } else {
                this.#log(`Composer: edit error: ${err.message}`);
            }
        }
    }
}
