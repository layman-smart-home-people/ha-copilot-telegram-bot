// ============================================================
// Conversation — Self-contained ACP session with streaming
// ============================================================
// States: idle | prompting | eliciting | autopilot | dead
//
// Owns: PoolInstance (from pool.acquire), ResponseStreamer, elicitation state.
// On receive(): idle→prompt, prompting→steer, eliciting→cancel+prompt,
//               autopilot→cancel autopilot+prompt.
//
// Autopilot: when the agent uses background tools (e.g., `task`),
// the conversation enters a short follow-up pass after the prompt resolves.
// It performs one delayed status check on background agents, then returns
// to idle. Public async/background work is still considered experimental.

import { EventEmitter } from "node:events";
import { ResponseStreamer } from "./streamer.mjs";
import { withThread } from "../transport/telegram/thread.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("conversation");

// Autopilot: tools that spawn background agents inside the ACP process
const ASYNC_TOOL_RE = /^task$/;
const AUTOPILOT_CHECK_DELAY_MS = 15_000;    // 15s between checks
const AUTOPILOT_CHECK_PROMPT =
    `[System — Autopilot Check]\n` +
    `You used background agents in your previous turn. Check their status:\n` +
    `1. Call list_agents to see all active/completed agents\n` +
    `2. For any running agents, call read_agent with wait:true (timeout:30)\n` +
    `3. Once all agents are complete, provide a final summary of their results\n` +
    `4. If agents are still running after checking, say so clearly in your reply`;

export class Conversation extends EventEmitter {
    #scopeKey;
    #poolInstance;   // PoolInstance from ACPPool
    #streamer;       // ResponseStreamer
    #telegram;
    #ref;            // { chatId, threadId?, chatType, userId }
    #state = "idle"; // idle | prompting | eliciting | autopilot | dead
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

    // Silent mode: suppress all user-facing output and auto-decline elicitations
    #silent = false;

    // Autopilot: keeps instance alive while background agents run
    #asyncToolsDetected = false;
    #autopilotAc = null;         // AbortController for the autopilot loop

    constructor({ scopeKey, poolInstance, telegram, ref, mcpProfile, config, resumeContext = null, silent = false, forcedTransport = null }) {
        super();
        this.#scopeKey = scopeKey;
        this.#poolInstance = poolInstance;
        this.#telegram = telegram;
        this.#ref = ref;
        this.#mcpProfile = mcpProfile || poolInstance?.mcpProfile || "owner";
        this.#silent = silent;
        const transport = silent ? "off" : (forcedTransport || config?.streamingTransport || "auto");
        this.#streamer = new ResponseStreamer(telegram, {
            streamingTransport: transport,
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
    get acp() { return this.#poolInstance?.acp || null; }
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

    get isAutopilot() { return this.#state === "autopilot"; }
    get silent() { return this.#silent; }

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

            case "autopilot":
                // User interrupted autopilot — cancel and handle their message
                await this.#cancelAutopilot();
                await new Promise(r => setTimeout(r, 200)); // grace period for ACP cancellation
                return this.#prompt(text, opts);

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
     * Stop the current activity without steering a new prompt into the session.
     * Returns true if something was actually cancelled/cleared.
     */
    async stop(reason = "⏹️ Stopped.") {
        switch (this.#state) {
        case "prompting":
            if (this.#autopilotAc) {
                this.#autopilotAc.abort();
                this.#autopilotAc = null;
            }
            if (this.#streamer.active) {
                await this.#streamer.abort(reason).catch(() => {});
            }
            try {
                await this.#poolInstance?.acp?.cancel();
            } catch {}
            this.#state = "idle";
            this.#lastActivity = Date.now();
            return true;

        case "autopilot":
            await this.#cancelAutopilot();
            this.#lastActivity = Date.now();
            return true;

        case "eliciting":
            if (this.#pendingElicitation) {
                const { requestId } = this.#pendingElicitation;
                this.#pendingElicitation = null;
                try {
                    this.#poolInstance?.acp?.respondElicitation(requestId, "decline", null);
                } catch {}
            }
            try {
                await this.#poolInstance?.acp?.cancel();
            } catch {}
            this.#state = "idle";
            this.#lastActivity = Date.now();
            return true;

        default:
            return false;
        }
    }

    /**
     * Mark conversation as dead (instance lost).
     */
    kill() {
        this.#state = "dead";
        if (this.#autopilotAc) {
            this.#autopilotAc.abort();
            this.#autopilotAc = null;
        }
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
            autopilot: this.#state === "autopilot",
        };
    }

    // ── Private: Prompt Flow ─────────────────────────────────

    async #prompt(text, opts = {}) {
        this.#state = "prompting";
        this.#asyncToolsDetected = false; // reset per turn
        const promptText = this.#resumeContext ? `${this.#resumeContext}\n${text}` : text;
        this.#currentPromptText = promptText;
        this.#promptCount++;
        const promptIndex = this.#promptCount;

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
            if (this.#promptCount !== promptIndex) return result;
            this.#resumeContext = null;
            this.#poolInstance.recordPrompt(elapsed);
            this.#lastActivity = Date.now();

            // Finalize streamer
            await this.#streamer.finalize(opts.replyMarkup || null);
            this.emit("prompt_complete", { elapsed, scopeKey: this.#scopeKey });

            // Autopilot: if agent used background tools, keep instance alive and follow up
            if (this.#asyncToolsDetected && this.#state === "prompting") {
                this.#startAutopilot();
            } else if (this.#state === "prompting") {
                this.#state = "idle";
            }

            return result;
        } catch (err) {
            if (this.#state === "prompting" && this.#promptCount === promptIndex) {
                this.#state = "idle";
            }
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

        if (this.#autopilotAc) {
            this.#autopilotAc.abort();
            this.#autopilotAc = null;
        }

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
            // Detect background agent tools for autopilot
            const toolName = data.toolName || data.name;
            const toolArgs = data.arguments || {};
            if (ASYNC_TOOL_RE.test(toolName) && toolArgs.mode === "background") {
                this.#asyncToolsDetected = true;
                log.debug(`${this.#scopeKey} async tool detected: ${toolName}`);
            }
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
            // Auto-decline for silent and SI conversations — no human to answer
            if (this.#silent || this.#scopeKey.startsWith("si:")) {
                log.info(`${this.#scopeKey} auto-declining elicitation: "${(message || "").substring(0, 80)}"`);
                this.#poolInstance.acp.respondElicitation(requestId, "decline", null);
                return;
            }

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
        this.#listeners.permission = (request) => {
            this.emit("permission_request", { ...request, scopeKey: this.#scopeKey });
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

    // ── Private: Autopilot ───────────────────────────────────

    /**
     * Start the autopilot follow-up asynchronously.
     * Keeps the conversation alive for one delayed background-agent status check.
     */
    #startAutopilot() {
        this.#state = "autopilot";
        this.#autopilotAc = new AbortController();
        log.info(`${this.#scopeKey} entering autopilot`);

        this.#runAutopilotLoop().catch(err => {
            if (err.message?.includes("Operation cancelled")) return;
            log.error(`${this.#scopeKey} autopilot error: ${err.message}`);
        }).finally(() => {
            this.#autopilotAc = null;
            if (this.#state === "autopilot") {
                this.#state = "idle";
                this.#lastActivity = Date.now();
                this.emit("autopilot_complete", { scopeKey: this.#scopeKey });
            }
        });
    }

    async #runAutopilotLoop() {
        const signal = this.#autopilotAc.signal;
        if (signal.aborted || this.#state === "dead") return;

        await this.#abortableSleep(AUTOPILOT_CHECK_DELAY_MS, signal);
        if (signal.aborted || this.#state === "dead") return;

        log.info(`${this.#scopeKey} autopilot follow-up check`);
        this.#asyncToolsDetected = false;
        this.#state = "prompting";
        this.#promptCount++;

        try {
            await this.#streamer.start(this.#ref);
            const checkStart = Date.now();
            await this.#poolInstance.acp.prompt(AUTOPILOT_CHECK_PROMPT);
            const checkElapsed = Date.now() - checkStart;
            this.#lastActivity = Date.now();
            this.#poolInstance.recordPrompt(checkElapsed);
            await this.#streamer.finalize();
        } catch (err) {
            if (!signal.aborted && this.#streamer.active) {
                await this.#streamer.abort("Autopilot check failed.").catch(() => {});
            }
            if (!signal.aborted && this.#state !== "dead") {
                this.#state = "autopilot";
            }
            throw err;
        }

        this.#state = "autopilot";
        log.info(`${this.#scopeKey} autopilot follow-up complete`);
    }

    /** Cancel an active autopilot loop (e.g., user sent a new message). */
    async #cancelAutopilot() {
        if (this.#autopilotAc) {
            log.info(`${this.#scopeKey} autopilot cancelled by user`);
            this.#autopilotAc.abort();
            this.#autopilotAc = null;
        }
        try { await this.#poolInstance?.acp?.cancel(); } catch {}
        if (this.#streamer.active) {
            await this.#streamer.abort("↩️ Autopilot interrupted — processing your message...");
        }
        this.#state = "idle";
    }

    /** Sleep with abort support — resolves (not rejects) on abort. */
    #abortableSleep(ms, signal) {
        return new Promise(resolve => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(resolve, ms);
            const onAbort = () => { clearTimeout(timer); resolve(); };
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }
}
