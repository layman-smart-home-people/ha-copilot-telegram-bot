// ============================================================
// Response Composer — Unified progressive message for Telegram
// ============================================================
// Manages a single evolving message that shows:
// 1. "🤔 Thinking..." placeholder
// 2. Tool call progress (expandable blockquote)
// 3. Streaming answer text (throttled edits)
// 4. Final answer with collapsed tool steps

import { escapeHtml, markdownToTelegramHtml, chunkMessage, stripHtmlKeepStructure } from "./formatter.mjs";
import { createLogger } from "../../logger.mjs";

const EDIT_MIN_CHARS = 50;          // min new chars before editing (private chat)
const EDIT_MIN_INTERVAL_MS = 1500;  // min time between edits
const MAX_MSG_LEN = 4096;           // Telegram message length limit
const log = createLogger("composer");

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
    #editGeneration = 0;  // incremented on finalize/abort to invalidate stale retries
    #startTime = null;
    #interactionPending = null; // null | "permission" | "question" | "plan"
    #elapsedTimer = null;
    #thoughtBuffer = "";
    #thoughtActive = true;
    #trailingHtml = null;
    #planEntries = [];
    #intermediateMessages = [];
    #progressTimeline = []; // chronological: { type: "intermediate"|"tool", index?, id? }
    #draftMode = false;     // true = using sendMessageDraft (private chats)
    #draftId = null;        // draft_id for sendMessageDraft
    #draftDisplayText = ""; // persists streamed text across commitTurn() resets (C3)
    #draftFailures = 0;     // consecutive draft API failures; fallback after 3 (C6)
    #draftThrottleMs = 750; // adaptive throttle for draft updates (C4)
    #draftSending = false;  // serializes draft sends to prevent concurrent failure increments

    constructor(telegram) {
        this.#telegram = telegram;
    }

    get active() { return this.#messageId !== null && !this.#finalized; }
    get messageId() { return this.#draftMode && this.#messageId === -1 ? null : this.#messageId; }
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
        this.#editGeneration = 0;
        this.#editRetries = 0;
        this.#startTime = Date.now();
        this.#interactionPending = null;        this.#thoughtBuffer = "";
        this.#thoughtActive = true;
        this.#planEntries = [];
        this.#intermediateMessages = [];
        this.#progressTimeline = [];
        this.#draftMode = false;
        this.#draftId = null;
        this.#draftDisplayText = "";
        this.#draftFailures = 0;
        this.#draftThrottleMs = 750;
        this.#draftSending = false;

        // Try draft mode for private chats (ephemeral typing bubble)
        if (ref.chatType === "private") {
            try {
                this.#draftId = 1;
                await this.#telegram.call("sendMessageDraft", {
                    chat_id: ref.chatId,
                    draft_id: this.#draftId,
                    text: "",
                });
                this.#draftMode = true;
                this.#messageId = -1; // sentinel: active but no real message yet
                log.debug(`draft mode started for chat=${ref.chatId}`);
                this.#scheduleElapsedUpdate();
                return;
            } catch (err) {
                log.debug(`draft mode unavailable, using edit mode: ${err.message}`);
                this.#draftId = null;
            }
        }

        // Fallback: send a real placeholder message (edit-based flow)
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
            log.debug(`placeholder sent (msg=${this.#messageId})`);
            this.#scheduleElapsedUpdate();
        } catch (err) {
            log.warn(`placeholder failed: ${err.message}`);
            if (this.#elapsedTimer) {
                clearTimeout(this.#elapsedTimer);
                this.#elapsedTimer = null;
            }
        }
    }

    /**
     * Schedule the next elapsed-time update with adaptive interval.
     * Starts at 3s, scales to 20s as the turn gets longer.
     */
    #scheduleElapsedUpdate() {
        if (this.#finalized || !this.#messageId) return;
        const elapsed = this.#startTime ? (Date.now() - this.#startTime) / 1000 : 0;
        let delay;
        if (elapsed < 15)       delay = 3000;
        else if (elapsed < 60)  delay = 7000;
        else if (elapsed < 120) delay = 12000;
        else                    delay = 20000;
        this.#elapsedTimer = setTimeout(() => {
            this.#elapsedTimer = null;
            this.#scheduleEdit(true);
            this.#scheduleElapsedUpdate();
        }, delay);
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
            this.#progressTimeline.push({ type: "tool", id: toolCallId });
        }
        this.#scheduleEdit();
    }

    /**
     * Append streaming thought/reasoning text from the agent.
     */
    appendThought(text) {
        if (!this.active || !this.#thoughtActive) return;
        if (!text) return;
        if (!this.#thoughtBuffer) {
            this.#thoughtBuffer = text;
            this.#scheduleEdit();
            return;
        }

        // Some ACP providers emit cumulative thought chunks (full-so-far text),
        // while others emit deltas. Merge with overlap to avoid duplication.
        if (this.#thoughtBuffer.endsWith(text)) {
            this.#scheduleEdit();
            return;
        }
        let overlap = 0;
        const max = Math.min(this.#thoughtBuffer.length, text.length);
        for (let i = max; i > 0; i--) {
            if (this.#thoughtBuffer.endsWith(text.slice(0, i))) {
                overlap = i;
                break;
            }
        }
        this.#thoughtBuffer += text.slice(overlap);
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
     * Signal that the agent is waiting for user interaction.
     * @param {string|null} type - "permission", "question", "plan", or null to clear
     */
    setInteractionPending(type = "permission") {
        this.#interactionPending = type || null;
        this.#scheduleEdit();
    }

    /**
     * Update plan entries (replaces entire plan per ACP spec).
     */
    setPlan(entries) {
        if (this.#finalized) return;
        this.#planEntries = entries || [];
        this.#scheduleEdit();
    }

    /**
     * Commit current turn's text as an intermediate message.
     * Called when a new turn starts (message_start) to snapshot the previous turn.
     * Resets internal buffers for the next turn.
     */
    commitTurn() {
        const text = this.#textBuffer.trim();
        if (text) {
            this.#intermediateMessages.push(text);
            this.#progressTimeline.push({ type: "intermediate", index: this.#intermediateMessages.length - 1 });
        }
        // Draft mode: preserve committed text so draft bubble doesn't go blank (C3)
        if (this.#draftMode && text) {
            this.#draftDisplayText += (this.#draftDisplayText ? "\n\n" : "") + text;
        }
        this.#textBuffer = "";
        this.#lastEditedText = "";
        this.#thoughtBuffer = "";
        this.#thoughtActive = true;
        this.#scheduleEdit();
    }

    /**
     * Pop the last intermediate message (for single-turn fallback in finalize).
     * @returns {string} The last intermediate text, or empty string.
     */
    popLastIntermediate() {
        const text = this.#intermediateMessages.pop() || "";
        if (text) {
            // Remove corresponding timeline entry to keep indices consistent
            for (let i = this.#progressTimeline.length - 1; i >= 0; i--) {
                if (this.#progressTimeline[i].type === "intermediate") {
                    this.#progressTimeline.splice(i, 1);
                    break;
                }
            }
        }
        return text;
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
        this.#editGeneration++;
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }

        this.#textBuffer = fullText || this.#textBuffer;

        if (this.#draftMode) {
            return this.#finalizeDraft();
        }

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
     * Finalize draft mode: send the final answer as a real persistent message.
     * The draft auto-expires after 30s.
     */
    async #finalizeDraft() {
        const detailsHtml = this.#buildCombinedDetailsHtml();
        if (detailsHtml) this.#trailingHtml = detailsHtml;

        const hasAnswer = this.#textBuffer.trim().length > 0;

        if (hasAnswer) {
            const chunks = chunkMessage(this.#textBuffer);
            const firstHtml = this.#convertAnswer(chunks[0]);
            this.#messageId = await this.#sendFinalMessage(firstHtml, "HTML");
            return chunks.slice(1);
        } else if (detailsHtml) {
            this.#trailingHtml = null;
            this.#messageId = await this.#sendFinalMessage(detailsHtml, "HTML");
            return [];
        } else {
            // Nothing to show — draft auto-expires
            this.#messageId = null;
            return [];
        }
    }

    /**
     * Send a persistent message (used by draft mode finalization and abort).
     * Returns the message_id or null.
     */
    async #sendFinalMessage(text, parseMode) {
        if (!this.#ref) return null;
        const params = { chat_id: this.#ref.chatId, text, link_preview_options: { is_disabled: true } };
        if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;
        if (parseMode) params.parse_mode = parseMode;
        try {
            const sent = await this.#telegram.call("sendMessage", params);
            return sent?.message_id || null;
        } catch (err) {
            if (/can.t parse|entit/i.test(err?.message)) {
                try {
                    const sent = await this.#telegram.call("sendMessage", {
                        chat_id: this.#ref.chatId, text: stripHtmlKeepStructure(text),
                        link_preview_options: { is_disabled: true },
                    });
                    return sent?.message_id || null;
                } catch { return null; }
            }
            log.warn(`sendFinalMessage failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Cancel/reset without finalizing (e.g., on error or disconnect).
     */
    async abort(errorMsg) {
        if (this.#editTimer) { clearTimeout(this.#editTimer); this.#editTimer = null; }
        if (this.#elapsedTimer) { clearTimeout(this.#elapsedTimer); this.#elapsedTimer = null; }
        this.#finalized = true;
        this.#editGeneration++;

        if (this.#messageId && errorMsg) {
            if (this.#draftMode) {
                // Drafts are ephemeral — send error as a real persistent message
                this.#messageId = await this.#sendFinalMessage(
                    `⚠️ ${escapeHtml(errorMsg)}`, "HTML"
                );
            } else {
                await this.#editMessage(`⚠️ ${escapeHtml(errorMsg)}`);
            }
        }
    }

    /**
     * Delete the placeholder message (if nothing useful was shown).
     */
    async cleanup() {
        if (this.#draftMode) {
            // Drafts auto-expire after 30s, nothing to delete
            this.#messageId = null;
            return;
        }
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

        // Adaptive throttling: increase interval for long-running prompts
        const promptAge = this.#startTime ? (Date.now() - this.#startTime) / 1000 : 0;
        const interval = this.#draftMode
            ? this.#draftThrottleMs
            : (promptAge > 30 ? 3000 : EDIT_MIN_INTERVAL_MS);
        const minChars = this.#draftMode ? 20 : EDIT_MIN_CHARS;

        if (elapsed >= interval && (newChars >= minChars || forceAfterDelay)) {
            this.#doEdit();
        } else {
            const wait = Math.max(interval - elapsed, 300);
            this.#editTimer = setTimeout(() => {
                this.#editTimer = null;
                this.#doEdit();
            }, wait);
        }
    }

    #doEdit() {
        if (this.#finalized || !this.#messageId) return;
        if (this.#draftMode) return this.#doDraftEdit();

        const planHtml = this.#buildPlanHtml();
        const timelineHtml = this.#buildTimelineHtml();
        const progressHtml = [planHtml, timelineHtml].filter(Boolean).join("\n");
        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` <i>(${elapsed}s)</i>` : "";

        let html;
        if (this.#interactionPending) {
            const labels = {
                permission: "🔐 Awaiting permission...",
                question: "❓ Awaiting your input...",
                plan: "📋 Awaiting your decision...",
            };
            const label = labels[this.#interactionPending] || "⏳ Awaiting your input...";
            html = progressHtml
                ? `${label}${timer}\n${progressHtml}`
                : `${label}${timer}`;
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
                html = progressHtml ? `${thoughtHtml}\n${progressHtml}` : thoughtHtml;
            } else {
                html = progressHtml
                    ? `🤔 <i>Thinking...</i>${timer}\n${progressHtml}`
                    : `🤔 <i>Thinking...</i>${timer}`;
            }
        } else if (progressHtml) {
            // Show thinking indicator + plan/tool steps
            html = `🤔 <i>Thinking...</i>${timer}\n${progressHtml}`;
        } else if (this.#textBuffer.trim()) {
            // Text is streaming — show preview
            const preview = this.#textBuffer.trim().slice(0, 120);
            const truncated = this.#textBuffer.trim().length > 120 ? "..." : "";
            html = `✍️ <i>Writing response...</i>${timer}\n<blockquote>${escapeHtml(preview)}${truncated}</blockquote>`;
        } else {
            html = `🤔 <i>Thinking...</i>${timer}`;
        }

        // Budget-aware truncation
        if (html.length > MAX_MSG_LEN) {
            // Use only the first line (status indicator) as the header
            const actualHeader = html.split("\n")[0];
            html = this.#fitToLimit(actualHeader, planHtml, elapsed);
        }

        this.#editMessage(html);
        this.#lastEditedText = this.#textBuffer;
        this.#lastEditTime = Date.now();
    }

    /**
     * Draft-specific render path — compact progress + streaming answer text.
     * Sends plain text (no parse_mode) to avoid broken HTML from incomplete markdown (C1).
     */
    #doDraftEdit() {
        if (this.#finalized || !this.#messageId) return;

        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` (${elapsed}s)` : "";

        let text;

        if (this.#interactionPending) {
            const labels = {
                permission: "🔐 Awaiting permission...",
                question: "❓ Awaiting your input...",
                plan: "📋 Awaiting your decision...",
            };
            text = (labels[this.#interactionPending] || "⏳ Awaiting your input...") + timer;
        } else if (this.#textBuffer.trim()) {
            // Answer streaming — show actual text building up with cursor
            const combined = this.#draftDisplayText
                ? this.#draftDisplayText + "\n\n" + this.#textBuffer
                : this.#textBuffer;
            // Tail-window at 3800 chars to stay under 4096 limit (C2)
            text = combined.length > 3800
                ? "…" + combined.slice(-3800)
                : combined;
            text += " ▊";
        } else if (this.#thoughtActive && this.#thoughtBuffer && elapsed >= 3) {
            // Live reasoning — show last line of thought
            const lines = this.#thoughtBuffer.split("\n").filter(l => l.trim());
            const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
            const display = lastLine.length > 200 ? "…" + lastLine.slice(-200) : lastLine;
            text = display ? `🧠 ${display}${timer}` : `🤔 Thinking...${timer}`;
        } else {
            // Compact progress summary (no full timeline like edit mode)
            const parts = [];
            const running = this.#toolSteps.filter(s => s.status === "running");
            const completed = this.#toolSteps.filter(s => s.status === "completed").length;
            if (running.length > 0) {
                let desc = running[running.length - 1].description || running[running.length - 1].id;
                if (desc.length > 60) desc = desc.slice(0, 57) + "…";
                parts.push(`🔧 ${desc}`);
            }
            if (completed > 0) parts.push(`✅ ${completed} done`);
            if (running.length > 1) parts.push(`🔄 ${running.length} running`);
            if (this.#planEntries.length > 0) {
                const current = this.#planEntries.find(e => e.status === "in_progress");
                if (current) {
                    let desc = current.content || "";
                    if (desc.length > 60) desc = desc.slice(0, 57) + "…";
                    parts.push(`📋 ${desc}`);
                }
            }
            text = parts.length > 0
                ? parts.join(" · ") + timer
                : `🤔 Thinking...${timer}`;
        }

        // Serialize draft sends to prevent concurrent failure counter increments
        if (this.#draftSending) return;
        this.#draftSending = true;
        this.#sendDraft(text, false).finally(() => { this.#draftSending = false; });
        this.#lastEditedText = this.#textBuffer;
        this.#lastEditTime = Date.now();
    }

    #formatStepLine(step) {
        const icon = step.status === "completed" ? "✅"
                   : step.status === "failed" ? "❌"
                   : "🔄";
        let desc = step.description || step.id;
        if (desc.length > 80) {
            const cut = desc.lastIndexOf(" ", 77);
            desc = desc.slice(0, cut > 40 ? cut : 77) + "…";
        }
        return `${icon} ${escapeHtml(desc)}`;
    }

    #buildStepsHtml(isFinal) {
        if (this.#toolSteps.length === 0) return "";

        const steps = this.#toolSteps;
        const count = steps.length;
        const failedCount = steps.filter(s => s.status === "failed").length;

        if (isFinal) {
            const lines = steps.map(s => this.#formatStepLine(s));
            const header = `🔧 <b>${count} step${count > 1 ? "s" : ""}${failedCount > 0 ? ` (${failedCount} failed)` : ""}</b>`;
            return `<blockquote>${header}\n${lines.join("\n")}</blockquote>`;
        }

        // Live display: window to first 3 + last 12 (max 15 visible)
        const MAX_HEAD = 3;
        const MAX_TAIL = 12;
        const MAX_VISIBLE = MAX_HEAD + MAX_TAIL;

        let lines;
        if (count <= MAX_VISIBLE) {
            lines = steps.map(s => this.#formatStepLine(s));
        } else {
            const head = steps.slice(0, MAX_HEAD).map(s => this.#formatStepLine(s));
            const skipped = count - MAX_VISIBLE;
            const tail = steps.slice(-MAX_TAIL).map(s => this.#formatStepLine(s));
            lines = [...head, `<i>⏳ …and ${skipped} more step${skipped > 1 ? "s" : ""}</i>`, ...tail];
        }

        const header = `🔧 <b>Steps:</b>`;
        return `<blockquote>${header}\n${lines.join("\n")}</blockquote>`;
    }

    /**
     * Render timeline items with intermediates outside blockquotes and
     * consecutive tool steps grouped inside blockquotes.
     * @param {Array<{type:string, html:string}>} items - tagged items
     * @returns {string} HTML
     */
    #renderGroupedTimeline(items) {
        if (items.length === 0) return "";
        const parts = [];
        let toolGroup = [];

        const flushTools = () => {
            if (toolGroup.length > 0) {
                parts.push(`<blockquote>${toolGroup.join("\n")}</blockquote>`);
                toolGroup = [];
            }
        };

        for (const item of items) {
            if (item.type === "tool") {
                toolGroup.push(item.html);
            } else {
                // intermediates, skip markers, etc. — render outside blockquotes
                flushTools();
                parts.push(item.html);
            }
        }
        flushTools();
        return parts.join("\n");
    }

    /** Build interleaved timeline of intermediates + tool steps for live display */
    #buildTimelineHtml() {
        // Fallback: if timeline is empty but items exist (edge case), use legacy rendering
        if (this.#progressTimeline.length === 0) {
            const parts = [];
            const intermediateHtml = this.#buildIntermediateHtml();
            const stepsHtml = this.#buildStepsHtml(false);
            if (intermediateHtml) parts.push(intermediateHtml);
            if (stepsHtml) parts.push(stepsHtml);
            return parts.join("\n") || "";
        }

        const items = this.#progressTimeline.map(entry => {
            if (entry.type === "intermediate") {
                const msg = this.#intermediateMessages[entry.index];
                if (!msg) return null;
                const truncated = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
                return { type: "intermediate", html: `💬 <i>"${escapeHtml(truncated)}"</i>` };
            } else {
                const step = this.#toolSteps.find(s => s.id === entry.id);
                if (!step) return null;
                return { type: "tool", html: this.#formatStepLine(step) };
            }
        }).filter(Boolean);

        if (items.length === 0) return "";

        const MAX_VISIBLE = 15;
        let visibleItems;
        if (items.length <= MAX_VISIBLE) {
            visibleItems = items;
        } else {
            const head = items.slice(0, 2);
            const skipped = items.length - MAX_VISIBLE + 2;
            const tail = items.slice(-(MAX_VISIBLE - 2));
            visibleItems = [...head, { type: "skip", html: `<i>⏳ …${skipped} earlier</i>` }, ...tail];
        }

        return this.#renderGroupedTimeline(visibleItems);
    }

    #fitToLimit(header, planHtml, elapsed) {
        const totalItems = this.#progressTimeline.length;
        const stepCount = this.#toolSteps.length;
        const intermediateCount = this.#intermediateMessages.length;

        if (totalItems === 0 && stepCount === 0) {
            return (header + "\n").slice(0, MAX_MSG_LEN - 20) + "\n<i>…</i>";
        }

        // Render timeline items for truncation
        const allItems = this.#progressTimeline.map(entry => {
            if (entry.type === "intermediate") {
                const msg = this.#intermediateMessages[entry.index];
                if (!msg) return null;
                const truncated = msg.length > 80 ? msg.slice(0, 80) + "…" : msg;
                return { type: "intermediate", html: `💬 <i>"${escapeHtml(truncated)}"</i>` };
            } else {
                const step = this.#toolSteps.find(s => s.id === entry.id);
                if (!step) return null;
                return { type: "tool", html: this.#formatStepLine(step) };
            }
        }).filter(Boolean);

        // Guard: if all timeline entries resolved to null, fall through to summary
        if (allItems.length === 0) {
            const completedCount = this.#toolSteps.filter(s => s.status === "completed").length;
            const failedCount = this.#toolSteps.filter(s => s.status === "failed").length;
            const parts = [];
            if (intermediateCount > 0) parts.push(`💬 ${intermediateCount}`);
            if (stepCount > 0) {
                const runningCount = stepCount - completedCount - failedCount;
                const statusParts = [`${completedCount} done`];
                if (runningCount > 0) statusParts.push(`${runningCount} running`);
                if (failedCount > 0) statusParts.push(`${failedCount} failed`);
                parts.push(`🔧 ${stepCount} (${statusParts.join(", ")})`);
            }
            const summary = parts.length > 0
                ? `<blockquote>${parts.join(" · ")}</blockquote>`
                : "";
            const progress = [planHtml, summary].filter(Boolean).join("\n");
            return `${header}\n${progress}`;
        }

        // Try progressively smaller windows
        for (let tailSize = 12; tailSize >= 3; tailSize -= 3) {
            let visibleItems;
            if (allItems.length <= tailSize + 2) {
                visibleItems = allItems;
            } else {
                const head = allItems.slice(0, 2);
                const skipped = allItems.length - tailSize - 2;
                const tail = allItems.slice(-tailSize);
                visibleItems = [...head, { type: "skip", html: `<i>⏳ …${skipped} earlier</i>` }, ...tail];
            }

            const timelineBlock = this.#renderGroupedTimeline(visibleItems);
            const progress = [planHtml, timelineBlock].filter(Boolean).join("\n");
            const result = `${header}\n${progress}`;
            if (result.length <= MAX_MSG_LEN) return result;
        }

        // Ultra-compact: summary counts only
        const completedCount = this.#toolSteps.filter(s => s.status === "completed").length;
        const failedCount = this.#toolSteps.filter(s => s.status === "failed").length;
        const parts = [];
        if (intermediateCount > 0) parts.push(`💬 ${intermediateCount}`);
        if (stepCount > 0) {
            const runningCount = stepCount - completedCount - failedCount;
            const statusParts = [`${completedCount} done`];
            if (runningCount > 0) statusParts.push(`${runningCount} running`);
            if (failedCount > 0) statusParts.push(`${failedCount} failed`);
            parts.push(`🔧 ${stepCount} (${statusParts.join(", ")})`);
        }
        const summary = `<blockquote>${parts.join(" · ")}</blockquote>`;
        const progress = [planHtml, summary].filter(Boolean).join("\n");
        return `${header}\n${progress}`;
    }

    #buildPlanHtml() {
        if (this.#planEntries.length === 0) return "";

        const maxEntries = 20;
        const entries = this.#planEntries.slice(0, maxEntries);
        const lines = entries.map(e => {
            const icon = e.status === "completed" ? "✅"
                       : e.status === "in_progress" ? "🔄"
                       : "⏳";
            const content = (e.content || "").length > 120
                ? escapeHtml(e.content.slice(0, 120)) + "…"
                : escapeHtml(e.content || "");
            return `${icon} ${content}`;
        });
        if (this.#planEntries.length > maxEntries) {
            lines.push(`<i>…and ${this.#planEntries.length - maxEntries} more</i>`);
        }

        return `<blockquote>📋 <b>Plan:</b>\n${lines.join("\n")}</blockquote>`;
    }

    /** Build inline display of intermediate agent messages (brief italic quotes) */
    #buildIntermediateHtml() {
        if (this.#intermediateMessages.length === 0) return "";
        const maxShow = 3;
        const msgs = this.#intermediateMessages.slice(-maxShow);
        const lines = msgs.map(msg => {
            const truncated = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
            return `💬 <i>"${escapeHtml(truncated)}"</i>`;
        });
        if (this.#intermediateMessages.length > maxShow) {
            lines.unshift(`<i>…${this.#intermediateMessages.length - maxShow} earlier</i>`);
        }
        return lines.join("\n");
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

    /** Build a single collapsible blockquote combining reasoning + intermediates + steps */
    #buildCombinedDetailsHtml() {
        const hasThought = this.#thoughtBuffer.trim().length > 0;
        const hasSteps = this.#toolSteps.length > 0;
        const hasIntermediates = this.#intermediateMessages.length > 0;
        if (!hasThought && !hasSteps && !hasIntermediates) return "";

        const parts = [];

        // Collapsed header line: "🧠 Reasoning · 💬 3 messages · 🔧 N steps"
        const headerParts = [];
        if (hasThought) headerParts.push("🧠 Reasoning");
        if (hasIntermediates) {
            const n = this.#intermediateMessages.length;
            headerParts.push(`💬 ${n} message${n > 1 ? "s" : ""}`);
        }
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

        // Interleaved timeline (intermediates + steps in chronological order)
        if (hasIntermediates || hasSteps) {
            if (hasThought) parts.push("");

            if (this.#progressTimeline.length > 0) {
                let timelineLines = this.#progressTimeline.map(entry => {
                    if (entry.type === "intermediate") {
                        const msg = this.#intermediateMessages[entry.index];
                        if (!msg) return null;
                        const truncated = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
                        return `💬 "${escapeHtml(truncated)}"`;
                    } else {
                        const step = this.#toolSteps.find(s => s.id === entry.id);
                        if (!step) return null;
                        const icon = step.status === "completed" ? "✅"
                                   : step.status === "failed" ? "❌"
                                   : "🔄";
                        return `${icon} ${escapeHtml(step.description || step.id)}`;
                    }
                }).filter(Boolean);
                // Window long timelines: first 3 + last 10
                if (timelineLines.length > 16) {
                    const head = timelineLines.slice(0, 3);
                    const skipped = timelineLines.length - 13;
                    const tail = timelineLines.slice(-10);
                    timelineLines = [...head, `<i>⏳ …${skipped} more</i>`, ...tail];
                }
                parts.push(timelineLines.join("\n"));
            } else {
                // Fallback: legacy separate rendering (no timeline data)
                if (hasIntermediates) {
                    const intLines = this.#intermediateMessages.map(msg => {
                        const truncated = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
                        return `💬 "${escapeHtml(truncated)}"`;
                    });
                    parts.push(intLines.join("\n"));
                }
                if (hasSteps) {
                    const lines = this.#toolSteps.map(s => {
                        const icon = s.status === "completed" ? "✅"
                                   : s.status === "failed" ? "❌"
                                   : "🔄";
                        return `${icon} ${escapeHtml(s.description || s.id)}`;
                    });
                    if (hasIntermediates) parts.push("");
                    parts.push(lines.join("\n"));
                }
            }
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
        if (this.#draftMode) {
            return this.#sendDraft(html, true);
        }
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
                    log.warn(`rate limit retry cap reached, dropping edit`);
                    return;
                }
                this.#editRetries++;
                // Parse retry_after from Telegram error: "Too Many Requests: retry after 5"
                const match = err?.message?.match(/retry after (\d+)/i);
                const retryMs = (match ? parseInt(match[1], 10) : 2) * 1000;
                log.warn(`rate limited, retry ${this.#editRetries}/3 in ${retryMs}ms`);
                const gen = this.#editGeneration;
                setTimeout(() => {
                    // Discard stale retry if composer was finalized/aborted since scheduling
                    if (this.#editGeneration !== gen) return;
                    this.#editMessage(html);
                }, retryMs);
            } else {
                log.warn(`edit error: ${err.message}`);
            }
        }
    }

    /**
     * Send a draft update (ephemeral typing bubble).
     * @param {string} text - content to display
     * @param {boolean} useHtml - whether to apply parse_mode: "HTML"
     */
    async #sendDraft(text, useHtml = false) {
        if (!this.#ref || !this.#draftId) return;
        const params = {
            chat_id: this.#ref.chatId,
            draft_id: this.#draftId,
            text: text,
        };
        if (useHtml) params.parse_mode = "HTML";

        try {
            await this.#telegram.call("sendMessageDraft", params);
            this.#draftFailures = 0;
        } catch (err) {
            if (/429|retry/i.test(err?.message)) {
                // Rate limited — adaptive backoff (C4)
                this.#draftThrottleMs = Math.min(this.#draftThrottleMs * 2, 3000);
                log.warn(`draft rate limited, throttle → ${this.#draftThrottleMs}ms`);
                return;
            }
            if (useHtml && /can.t parse|entit/i.test(err?.message)) {
                try {
                    await this.#telegram.call("sendMessageDraft", {
                        chat_id: this.#ref.chatId,
                        draft_id: this.#draftId,
                        text: stripHtmlKeepStructure(text),
                    });
                    this.#draftFailures = 0;
                    return;
                } catch {}
            }

            this.#draftFailures++;
            log.warn(`draft error (${this.#draftFailures}/3): ${err.message}`);

            // Fallback to edit mode after 3 consecutive failures (C6)
            if (this.#draftFailures >= 3) {
                log.warn("draft mode failed 3x, falling back to edit mode");
                await this.#fallbackToEditMode();
            }
        }
    }

    /**
     * Switch from draft mode to edit mode mid-conversation (C6).
     * Sends a real placeholder message and switches all subsequent updates to edits.
     */
    async #fallbackToEditMode() {
        if (!this.#draftMode) return;
        this.#draftMode = false;
        this.#draftId = null;
        this.#messageId = null; // null out before async gap to prevent edits against -1 sentinel

        const elapsed = this.#startTime ? Math.round((Date.now() - this.#startTime) / 1000) : 0;
        const timer = elapsed > 0 ? ` <i>(${elapsed}s)</i>` : "";
        const params = {
            chat_id: this.#ref.chatId,
            text: `🤔 <i>Thinking...</i>${timer}`,
            parse_mode: "HTML",
            disable_notification: true,
        };
        if (this.#ref.threadId) params.message_thread_id = this.#ref.threadId;

        try {
            const sent = await this.#telegram.call("sendMessage", params);
            this.#messageId = sent?.message_id;
            log.debug(`fallback: edit mode started (msg=${this.#messageId})`);
            // If finalize() ran during our async gap, clean up the orphan placeholder
            if (this.#finalized && this.#messageId) {
                await this.cleanup();
            }
        } catch (err) {
            log.warn(`fallback placeholder failed: ${err.message}`);
            this.#messageId = null;
        }
    }
}
