// ============================================================
// Conversation — Self-contained ACP session with streaming
// ============================================================
// States: idle | prompting | eliciting | dead
//
// Owns: PoolInstance (from pool.acquire), ResponseStreamer, elicitation state.
// On receive(): idle→prompt, prompting→steer, eliciting→cancel+prompt.

import { EventEmitter } from "node:events";
import { ResponseStreamer } from "./streamer.mjs";
import { withThread } from "../transport/telegram/thread.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("conversation");

export class Conversation extends EventEmitter {
    #scopeKey;
    #poolInstance;   // PoolInstance from ACPPool
    #streamer;       // ResponseStreamer
    #telegram;
    #ref;            // { chatId, threadId?, chatType, userId }
    #state = "idle"; // idle | prompting | eliciting | dead
    #lastActivity;
    #createdAt;
    #promptCount = 0;
    #crashRetries = 0;
    #maxRetries = 2;
    #mcpProfile;     // preserved for crash recovery
    #receiveQueue = Promise.resolve(); // serialize concurrent receives

    // Elicitation
    #pendingElicitation = null; // { requestId, message, resolve }

    // Turn tracking
    #currentPromptText = null;
    #rawUserText = null;  // Original user text (before enrichment)
    #resumeContext = null;

    constructor({ scopeKey, poolInstance, telegram, ref, mcpProfile, config, resumeContext = null }) {
        super();
        this.#scopeKey = scopeKey;
        this.#poolInstance = poolInstance;
        this.#telegram = telegram;
        this.#ref = ref;
        this.#mcpProfile = mcpProfile || poolInstance?.mcpProfile || "owner";
        this.#streamer = new ResponseStreamer(telegram, {
            streamingTransport: config?.streamingTransport || "auto",
        });
        this.#lastActivity = Date.now();
        this.#createdAt = Date.now();
        this.#resumeContext = resumeContext || null;

        this.#attachAcpListeners();
    }

    // ── Public Getters ───────────────────────────────────────

    get scopeKey() { return this.#scopeKey; }
    get state() { return this.#state; }
    get instanceId() { return this.#poolInstance?.id; }
    get sessionId() { return this.#poolInstance?.sessionId || this.#poolInstance?.acp?.sessionId || null; }
    get model() { return this.#poolInstance?.model; }
    get mcpProfile() { return this.#mcpProfile; }
    get ref() { return this.#ref; }
    get lastActivity() { return this.#lastActivity; }
    get createdAt() { return this.#createdAt; }
    get promptCount() { return this.#promptCount; }
    get streamer() { return this.#streamer; }
    get currentPromptText() { return this.#currentPromptText; }
    get rawUserText() { return this.#rawUserText; }

    get idleMs() {
        return this.#state === "idle" ? Date.now() - this.#lastActivity : 0;
    }

    // ── Public API ───────────────────────────────────────────

    /**
     * Receive a user message. Handles state transitions:
     * - idle → start prompt
     * - prompting → steer (cancel + re-prompt)
     * - eliciting → resolve elicitation with this text
     */
    async receive(text, opts = {}) {
        // Serialize concurrent receives to prevent race conditions
        const result = this.#receiveQueue = this.#receiveQueue
            .catch(() => {}) // don't let previous failures block the queue
            .then(() => this.#doReceive(text, opts));
        return result;
    }

    async #doReceive(text, opts = {}) {
        this.#lastActivity = Date.now();
        if (opts.rawText) this.#rawUserText = opts.rawText;

        switch (this.#state) {
            case "idle":
                return this.#prompt(text, opts);

            case "prompting":
                return this.#steer(text, opts);

            case "eliciting":
                return this.#resolveElicitation(text);

            case "dead":
                this.emit("error", new Error("Conversation is dead"));
                return null;
        }
    }

    /**
     * Respond to an elicitation via callback button.
     */
    async respondElicitation(action, content = null) {
        if (this.#state !== "eliciting" || !this.#pendingElicitation) return;
        if (!this.#poolInstance?.alive) {
            // Instance died while waiting — kill conversation
            this.#pendingElicitation = null;
            this.kill();
            return;
        }
        const { requestId } = this.#pendingElicitation;
        this.#pendingElicitation = null;
        this.#state = "prompting";
        this.#poolInstance.acp.respondElicitation(requestId, action, content);
    }

    /**
     * Mark conversation as dead (instance lost).
     */
    kill() {
        this.#state = "dead";
        if (this.#streamer.active) {
            this.#streamer.abort("Session ended unexpectedly.").catch(() => {});
        }
        this.#detachAcpListeners();
        this.emit("dead", { scopeKey: this.#scopeKey });
    }

    /**
     * Replace pool instance (crash recovery).
     * Called by ConversationManager when it acquires a new instance.
     */
    replaceInstance(newPoolInstance) {
        // Detach from old instance (may be dead — use stored reference)
        const oldAcp = this.#poolInstance?.acp;
        if (oldAcp) {
            for (const [event, fn] of Object.entries(this.#listeners)) {
                if (fn) oldAcp.off(event === "textChunk" ? "text_chunk" :
                    event === "thoughtChunk" ? "thought_chunk" :
                    event === "toolStart" ? "tool_start" :
                    event === "toolEnd" ? "tool_end" :
                    event === "messageEnd" ? "message_end" :
                    event === "elicitation" ? "elicitation_request" :
                    event === "permission" ? "permission_request" :
                    event, fn);
            }
        }
        this.#poolInstance = newPoolInstance;
        this.#state = "idle"; // Reset state — new instance has no in-flight prompt
        this.#attachAcpListeners();
        log.info(`${this.#scopeKey} instance replaced: ${newPoolInstance.id}`);
    }

    /** Set one-shot recovery context to prepend to the next prompt. */
    setResumeContext(text) {
        this.#resumeContext = text || null;
    }

    /**
     * Serializable status.
     */
    toStatus() {
        return {
            scopeKey: this.#scopeKey,
            state: this.#state,
            instanceId: this.instanceId,
            model: this.model,
            promptCount: this.#promptCount,
            idleMs: this.idleMs,
            lastActivity: this.#lastActivity,
        };
    }

    // ── Private: Prompt Flow ─────────────────────────────────

    async #prompt(text, opts = {}) {
        this.#state = "prompting";
        const promptText = this.#resumeContext ? `${this.#resumeContext}\n${text}` : text;
        this.#currentPromptText = promptText;
        this.#promptCount++;

        // React ⚡ on the user's message if we have a message ID
        if (opts.messageId && this.#ref.chatId) {
            this.#telegram.setMessageReaction(this.#ref.chatId, opts.messageId, "⚡").catch(() => {});
        }

        // Start streaming
        await this.#streamer.start(this.#ref);

        // Send prompt to ACP
        const startTime = Date.now();
        try {
            const result = await this.#poolInstance.acp.prompt(promptText, { images: opts.images });
            const elapsed = Date.now() - startTime;
            this.#resumeContext = null;
            this.#poolInstance.recordPrompt(elapsed);
            this.#state = "idle";
            this.#lastActivity = Date.now();

            // Finalize streamer
            await this.#streamer.finalize(opts.replyMarkup || null);
            this.emit("prompt_complete", { elapsed, scopeKey: this.#scopeKey });
            return result;
        } catch (err) {
            this.#state = "idle";
            this.#lastActivity = Date.now();

            if (err.message?.includes("Operation cancelled")) {
                // Steering happened — not an error
                log.debug(`Prompt cancelled (steered) for ${this.#scopeKey}`);
                return null;
            }

            // Crash recovery: if instance died, emit crash for manager to provide new instance
            if (err.message?.includes("not running") || err.message?.includes("ECONNRESET") ||
                err.message?.includes("stdin not writable")) {
                if (this.#crashRetries < this.#maxRetries) {
                    this.#crashRetries++;
                    log.warn(`${this.#scopeKey} instance crashed (retry ${this.#crashRetries}/${this.#maxRetries})`);
                    this.emit("needs_new_instance", { scopeKey: this.#scopeKey, text, opts });
                    return null;
                }
            }

            log.error(`Prompt error for ${this.#scopeKey}: ${err.message}`);
            await this.#streamer.abort(err.message);
            this.emit("error", err);
            return null;
        }
    }

    /**
     * Steer: cancel current prompt and start a new one.
     * ACP supports cancel-and-replace: sending a new prompt while one is in-flight
     * causes the old to resolve with "Operation cancelled by user".
     */
    async #steer(text, opts = {}) {
        // Grace period: if an elicitation just arrived (user replied to agent question),
        // handle it as elicitation instead of cancelling the prompt
        await new Promise(r => setTimeout(r, 150));
        if (this.#state === "eliciting") {
            log.info(`${this.#scopeKey}: elicitation arrived during steer grace — resolving`);
            return this.#resolveElicitation(text);
        }

        log.info(`Steering ${this.#scopeKey}: cancelling current, re-prompting`);

        // Abort the current streamer (old response)
        if (this.#streamer.active) {
            await this.#streamer.abort("↩️ New message received — redirecting...");
        }

        // Cancel current prompt in ACP
        try {
            await this.#poolInstance.acp.cancel();
        } catch {
            // Cancel may fail if prompt already completed — that's fine
        }

        // Brief pause for ACP to process cancellation
        await new Promise(r => setTimeout(r, 200));

        // Start fresh prompt
        return this.#prompt(text, opts);
    }

    /** Resolve pending elicitation with user's free-text response. */
    #resolveElicitation(text) {
        if (!this.#pendingElicitation) return;
        const { requestId } = this.#pendingElicitation;
        this.#pendingElicitation = null;
        this.#state = "prompting";
        // Treat text as acceptance with content
        this.#poolInstance.acp.respondElicitation(requestId, "accept", { text });
    }

    /** Send elicitation question with accept/decline buttons. */
    async #sendElicitationButtons(message) {
        const text = `❓ ${message || "The agent needs your input."}\n\n<i>Reply with text, or tap a button:</i>`;
        const replyMarkup = {
            inline_keyboard: [[
                { text: "✅ Accept", callback_data: `${this.#scopeKey}:elicit:accept` },
                { text: "❌ Decline", callback_data: `${this.#scopeKey}:elicit:decline` },
            ]],
        };
        const params = withThread({ chat_id: this.#ref.chatId, text, parse_mode: "HTML",
            reply_markup: replyMarkup, link_preview_options: { is_disabled: true } }, this.#ref);
        await this.#telegram.call("sendMessage", params);
    }

    // ── Private: ACP Event Listeners ─────────────────────────

    #listeners = {};

    #attachAcpListeners() {
        const acp = this.#poolInstance.acp;

        this.#listeners.textChunk = (text) => {
            this.#streamer.onTextChunk(text);
            this.emit("text_chunk", { text });
        };
        this.#listeners.thoughtChunk = (text) => {
            this.#streamer.onThoughtChunk(text);
            this.emit("thought_chunk", { text });
        };
        this.#listeners.toolStart = (data) => {
            this.#streamer.onToolStart(data);
            this.emit("tool_start", data);
        };
        this.#listeners.toolEnd = (data) => {
            this.#streamer.onToolEnd(data);
            this.emit("tool_end", data);
        };
        this.#listeners.plan = (entries) => {
            this.#streamer.onPlan(entries);
            this.emit("plan", entries);
        };
        this.#listeners.messageEnd = () => {
            // ACP signals message_end when a turn is complete — notify streamer for multi-turn display
            this.#streamer.onTurnEnd();
            this.emit("message_end");
        };
        this.#listeners.elicitation = ({ requestId, message, schema }) => {
            this.#state = "eliciting";
            this.#pendingElicitation = { requestId, message, schema };

            // Finalize streamer (commits draft as real message, clears draft)
            // so the user's input field is unblocked for typing a reply.
            // Send elicitation buttons only after draft is cleared.
            (this.#streamer.active ? this.#streamer.finalize() : Promise.resolve())
                .then(() => this.#sendElicitationButtons(message))
                .catch(err => log.warn(`Elicitation setup failed: ${err.message}`));

            this.emit("elicitation", { requestId, message, schema, scopeKey: this.#scopeKey });
        };
        this.#listeners.permission = ({ requestId, permissions, options }) => {
            // Auto-accept permissions (permission_policy=allow_all handles this in ACP,
            // but if interactive mode, we'd need user confirmation here)
            this.emit("permission_request", { requestId, permissions, options, scopeKey: this.#scopeKey });
        };

        acp.on("text_chunk", this.#listeners.textChunk);
        acp.on("thought_chunk", this.#listeners.thoughtChunk);
        acp.on("tool_start", this.#listeners.toolStart);
        acp.on("tool_end", this.#listeners.toolEnd);
        acp.on("plan", this.#listeners.plan);
        acp.on("message_end", this.#listeners.messageEnd);
        acp.on("elicitation_request", this.#listeners.elicitation);
        acp.on("permission_request", this.#listeners.permission);
    }

    #detachAcpListeners() {
        const acp = this.#poolInstance?.acp;
        if (!acp) return;
        acp.off("text_chunk", this.#listeners.textChunk);
        acp.off("thought_chunk", this.#listeners.thoughtChunk);
        acp.off("tool_start", this.#listeners.toolStart);
        acp.off("tool_end", this.#listeners.toolEnd);
        acp.off("plan", this.#listeners.plan);
        acp.off("message_end", this.#listeners.messageEnd);
        acp.off("elicitation_request", this.#listeners.elicitation);
        acp.off("permission_request", this.#listeners.permission);
    }
}
