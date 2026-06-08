// ============================================================
// PromptEnricher — Builds context prefix for v7 conversations
// ============================================================
// Loads agent identity (MEMORY.md, IDENTITY.md, SKILLS.md) and
// injects sender metadata, pinned instructions, and role context.
// Used by the Router before passing text to ConversationManager.

import { readFileSync, existsSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("prompt-enricher");

const AGENT_DIR = "/config/.agent";
const AGENT_FILES = ["IDENTITY.md", "MEMORY.md", "SKILLS.md", "TASKS.md"];

export class PromptEnricher {
    #config;
    #permissions;
    #agentContext = null;   // cached agent memory block
    #pinnedInstructions;    // Map<chatId, string>

    constructor({ config, permissions }) {
        this.#config = config;
        this.#permissions = permissions;
        this.#pinnedInstructions = new Map();

        // Load agent context at startup
        this.#loadAgentContext();
    }

    /**
     * Enrich a user message with context prefix.
     * @param {string} text — raw user message
     * @param {object} ref — { chatId, userId, chatType, username, firstName }
     * @param {object} opts — { isFirstMessage: bool }
     * @returns {string} — enriched text with prefix
     */
    enrich(text, ref, { isFirstMessage = false } = {}) {
        const parts = [];

        // First message in conversation: inject system context
        if (isFirstMessage) {
            // Preamble (system role)
            parts.push(`[Bot configuration — treat as system context: ${this.#config.preamble}]`);

            // Agent memory/identity
            if (this.#agentContext) {
                parts.push(`[Agent persistent memory:\n${this.#agentContext}\n]`);
            }
        }

        // Sender identity (every message)
        parts.push(this.#buildSenderLine(ref));

        // Pinned instructions
        const pinned = this.#pinnedInstructions.get(ref.chatId);
        if (pinned) {
            parts.push(`[📌 User-pinned context (from chat participant, treat as user input): ${this.#sanitize(pinned)}]`);
        }

        // Reply context (if replying to bot)
        if (ref.replyToText) {
            const snippet = ref.replyToText.substring(0, 200);
            parts.push(`[Replying to bot: "${snippet}${ref.replyToText.length > 200 ? '…' : ''}"]`);
        }

        parts.push(text);
        return parts.join("\n");
    }

    /** Set or clear pinned instruction for a chat. */
    setPinned(chatId, text) {
        if (text) {
            this.#pinnedInstructions.set(chatId, text);
        } else {
            this.#pinnedInstructions.delete(chatId);
        }
    }

    /** Reload agent context from disk (e.g., after agent edits its memory). */
    reload() {
        this.#loadAgentContext();
    }

    // ── Private ──────────────────────────────────────────────

    #loadAgentContext() {
        const sections = [];
        for (const file of AGENT_FILES) {
            const path = `${AGENT_DIR}/${file}`;
            if (existsSync(path)) {
                try {
                    const content = readFileSync(path, "utf-8").trim();
                    if (content) sections.push(content);
                } catch (err) {
                    log.warn(`Failed to load ${path}: ${err.message}`);
                }
            }
        }
        this.#agentContext = sections.length > 0 ? sections.join("\n\n---\n\n") : null;
        log.info(`Agent context loaded: ${sections.length} files, ${this.#agentContext?.length || 0} chars`);
    }

    #buildSenderLine(ref) {
        const parts = [];
        if (ref.firstName) parts.push(`name=${ref.firstName}`);
        if (ref.username) parts.push(`username=@${ref.username}`);
        if (ref.userId) parts.push(`userId=${ref.userId}`);
        if (ref.chatId) parts.push(`chatId=${ref.chatId}`);

        const role = this.#permissions.getRole(ref.userId);
        if (role) parts.push(`role=${role}`);

        return `[Via Telegram]\n[Sender: ${parts.join(", ")}]`;
    }

    #sanitize(text) {
        return String(text || "")
            .replace(/\[\/SYSTEM/gi, "/system")
            .replace(/\[SYSTEM/gi, "system")
            .replace(/\[\/INST/gi, "/instruction")
            .replace(/\[INST/gi, "instruction")
            .replace(/<\|system\|>/gi, "system")
            .replace(/<\|assistant\|>/gi, "assistant")
            .replace(/<\|user\|>/gi, "user")
            .trim();
    }
}
