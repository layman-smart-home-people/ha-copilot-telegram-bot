// ============================================================
// SI Bridge — Adapter between Standing Instructions and v7 Pool
// ============================================================
// Implements the bridge interface that StandingInstructionOrchestrator
// expects, routing wake_agent prompts through ConversationManager.

import { createLogger } from "../logger.mjs";

const log = createLogger("si-bridge");
const SI_PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max per SI prompt

export class SIBridge {
    #conversationManager;
    #telegram;
    #config;
    #topicManager = null;
    #activePrompts = new Set(); // track in-flight SI prompts

    constructor({ conversationManager, telegram, config }) {
        this.#conversationManager = conversationManager;
        this.#telegram = telegram;
        this.#config = config;
    }

    /** Set TopicManager for thread-targeted delivery. */
    setTopicManager(mgr) { this.#topicManager = mgr; }

    /** Whether any SI prompt is currently active. */
    get promptActive() {
        return this.#activePrompts.size > 0;
    }

    /**
     * Inject a background prompt from a standing instruction.
     * Routes through ConversationManager with an SI-scoped conversation.
     * @param {string} prompt
     * @param {number|string} chatId
     * @param {object} opts — { description, silent, instructionId }
     */
    injectBackgroundPrompt(prompt, chatId, opts = {}) {
        const description = opts.description || "SI";
        const silent = opts.silent || false;
        // Use instruction ID for scope key to avoid hash collisions
        const scopeKey = opts.instructionId ? `si:${opts.instructionId}` : `si:${this.#hashScope(description)}`;

        // Debounce: if this SI is already in-flight, skip
        if (this.#activePrompts.has(scopeKey)) {
            log.debug(`SI debounced (already active): "${description}"`);
            return;
        }

        this.#activePrompts.add(scopeKey);

        // Fire and forget with timeout — prevents hung agents from blocking SI scope forever
        const executeWithTimeout = Promise.race([
            this.#executePrompt(scopeKey, prompt, chatId, { description, silent }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`SI prompt timed out after ${SI_PROMPT_TIMEOUT_MS / 1000}s`)), SI_PROMPT_TIMEOUT_MS)
            ),
        ]);

        executeWithTimeout
            .catch(err => {
                log.error(`SI prompt failed [${description}]: ${err.message}`);
                if (!silent && chatId) {
                    this.#telegram.sendMessage(chatId, `❌ SI failed: ${description}\n${err.message}`).catch(() => {});
                }
            })
            .finally(() => {
                this.#activePrompts.delete(scopeKey);
                this.#conversationManager.destroy(scopeKey).catch(err =>
                    log.warn(`Failed to destroy SI conversation ${scopeKey}: ${err.message}`)
                );
            });
    }

    #hashScope(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Fallback: inject as system prompt (same behavior in v7).
     */
    async injectSystemPrompt(prompt, chatId) {
        return this.injectBackgroundPrompt(prompt, chatId, { silent: false });
    }

    async #executePrompt(scopeKey, prompt, chatId, { description, silent }) {
        const model = this.#config.siDefaultModel || "standard";
        const mcpProfile = "owner"; // SI always gets full access

        // Resolve target thread for DM topic routing
        let threadId = null;
        if (this.#config.dmTopicsEnabled && this.#topicManager && chatId) {
            // Route to matching topic if description hints at one, else default to Briefings
            threadId = this.#topicManager.resolveThreadId(chatId, description)
                    || this.#topicManager.resolveThreadId(chatId, "Briefings")
                    || null;
        }

        // Build a minimal ref for the conversation
        const ref = {
            chatId: chatId || this.#config.allowedChatIds?.[0],
            userId: 0, // system-initiated
            chatType: "private",
            threadId,
            isForum: false,
            messageId: null,
            username: "system",
            firstName: "Standing Instruction",
        };

        log.info(`Routing SI: "${description}" → scope ${scopeKey} [${model}]${threadId ? ` thread=${threadId}` : ""}`);

        await this.#conversationManager.route(scopeKey, prompt, ref, {
            messageId: null,
            model,
            mcpProfile,
        });

        log.info(`SI complete: "${description}"`);
    }
}
