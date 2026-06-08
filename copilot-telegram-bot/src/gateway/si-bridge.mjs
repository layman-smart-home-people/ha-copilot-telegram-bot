// ============================================================
// SI Bridge — Adapter between Standing Instructions and v7 Pool
// ============================================================
// Implements the bridge interface that StandingInstructionOrchestrator
// expects, routing wake_agent prompts through ConversationManager.

import { createLogger } from "../logger.mjs";

const log = createLogger("si-bridge");

export class SIBridge {
    #conversationManager;
    #telegram;
    #config;
    #activePrompts = new Set(); // track in-flight SI prompts

    constructor({ conversationManager, telegram, config }) {
        this.#conversationManager = conversationManager;
        this.#telegram = telegram;
        this.#config = config;
    }

    /** Whether any SI prompt is currently active. */
    get promptActive() {
        return this.#activePrompts.size > 0;
    }

    /**
     * Inject a background prompt from a standing instruction.
     * Routes through ConversationManager with an SI-scoped conversation.
     */
    injectBackgroundPrompt(prompt, chatId, opts = {}) {
        const description = opts.description || "SI";
        const silent = opts.silent || false;
        const scopeKey = `si:${Date.now()}`;

        this.#activePrompts.add(scopeKey);

        // Fire and forget — route through conversation manager
        this.#executePrompt(scopeKey, prompt, chatId, { description, silent })
            .catch(err => {
                log.error(`SI prompt failed [${description}]: ${err.message}`);
                if (!silent && chatId) {
                    this.#telegram.sendMessage(chatId, `❌ SI failed: ${description}\n${err.message}`).catch(() => {});
                }
            })
            .finally(() => {
                this.#activePrompts.delete(scopeKey);
            });
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

        // Build a minimal ref for the conversation
        const ref = {
            chatId: chatId || this.#config.allowedChatIds?.[0],
            userId: 0, // system-initiated
            chatType: "private",
            threadId: null,
            isForum: false,
            messageId: null,
            username: "system",
            firstName: "Standing Instruction",
        };

        log.info(`Routing SI: "${description}" → scope ${scopeKey} [${model}]`);

        await this.#conversationManager.route(scopeKey, prompt, ref, {
            messageId: null,
            model,
            mcpProfile,
        });

        log.info(`SI complete: "${description}"`);
    }
}
