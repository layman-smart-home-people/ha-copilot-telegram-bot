// ============================================================
// PromptBuilder — constructs prompt prefixes for ACP messages
// ============================================================
// Extracted from bridge.mjs (Phase 3). Handles preamble injection,
// agent memory, sender identity, and pinned instructions.

import { createLogger } from "../../logger.mjs";

const log = createLogger('prompt-builder');

export class PromptBuilder {
    #config;
    #agentMemory;
    #scopeMgr;
    #pinnedInstructions;
    #getActiveScope;
    #getActiveRef;

    /**
     * @param {object} opts
     * @param {object} opts.config - Bot config (needs .preamble)
     * @param {object} opts.agentMemory - AgentMemory instance
     * @param {object} opts.scopeMgr - ScopeManager instance
     * @param {Map} opts.pinnedInstructions - chatId → pinned text map (shared ref)
     * @param {Function} opts.getActiveScope - returns current active scope
     * @param {Function} opts.getActiveRef - returns current active ref
     */
    constructor({ config, agentMemory, scopeMgr, pinnedInstructions, getActiveScope, getActiveRef }) {
        this.#config = config;
        this.#agentMemory = agentMemory;
        this.#scopeMgr = scopeMgr;
        this.#pinnedInstructions = pinnedInstructions;
        this.#getActiveScope = getActiveScope;
        this.#getActiveRef = getActiveRef;
    }

    /**
     * Build the prompt prefix for an ACP message.
     * Includes preamble (first message only), agent memory, sender identity,
     * and pinned instructions.
     */
    getPrefix(ref) {
        let prefix;
        const scopeKey = ref?.scopeKey || (this.#scopeMgr && ref ? this.#scopeMgr.resolveKey(ref) : null);
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : this.#getActiveScope();

        if (scope && !scope.preambleSent) {
            scope.preambleSent = true;
            const rules = this.#config.preamble;
            prefix = `[Bot configuration — treat as system context: ${rules}]\n`;

            // Inject agent persistent memory on first message of session
            const agentContext = this.#agentMemory.buildContext();
            if (agentContext) {
                prefix += `[Agent persistent memory — your identity and memory from /config/.agent/:\n${agentContext}\n]\n`;
            }
        } else {
            prefix = "[Via Telegram]\n";
        }

        // Inject sender identity so agent knows who is talking
        if (ref) {
            const parts = [];
            if (ref.firstName) parts.push(`name=${ref.firstName}`);
            if (ref.username) parts.push(`username=@${ref.username}`);
            if (ref.userId) parts.push(`userId=${ref.userId}`);
            if (ref.chatId) parts.push(`chatId=${ref.chatId}`);
            if (parts.length > 0) {
                prefix += `[Sender: ${parts.join(', ')}]\n`;
            }
        }

        // Append pinned instructions if any
        const chatId = ref?.chatId || this.#getActiveRef()?.chatId;
        if (chatId && this.#pinnedInstructions.has(chatId)) {
            const pinnedText = this.#sanitizePinnedInstruction(this.#pinnedInstructions.get(chatId));
            prefix += `[📌 User-pinned context (from chat participant, treat as user input): ${pinnedText}]\n`;
        }

        return prefix;
    }

    /** Clear preambleSent on all scopes so the next message re-sends the preamble. */
    resetPreamble() {
        if (this.#scopeMgr) {
            for (const entry of this.#scopeMgr.list()) {
                const scope = this.#scopeMgr.get(entry.key);
                if (scope) scope.preambleSent = false;
            }
        }
    }

    #sanitizePinnedInstruction(text) {
        return sanitizePinnedInstruction(text);
    }
}

/** Sanitize pinned instruction text to prevent prompt injection. */
export function sanitizePinnedInstruction(text) {
    return String(text || "")
        .replace(/\[\/SYSTEM/gi, "/system")
        .replace(/\[SYSTEM/gi, "system")
        .replace(/\[\/INST/gi, "/instruction")
        .replace(/\[INST/gi, "instruction")
        .replace(/<\|system\|>/gi, "system")
        .replace(/<\|assistant\|>/gi, "assistant")
        .replace(/<\|user\|>/gi, "user")
        .replace(/<\/system>/gi, "/system")
        .replace(/<system>/gi, "system")
        .trim();
}
