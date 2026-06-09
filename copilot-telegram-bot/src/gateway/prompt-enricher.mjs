// ============================================================
// PromptEnricher — Builds context prefix for v7 conversations
// ============================================================
// Loads agent identity (MEMORY.md, IDENTITY.md, SKILLS.md) and
// injects sender metadata, pinned instructions, and role context.
// Used by the Router before passing text to ConversationManager.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("prompt-enricher");

const DEFAULT_AGENT_DIR = "/config/copilot-telegram-bot";
const LEGACY_AGENT_DIR = "/config/.agent";
const AGENT_FILES = ["IDENTITY.md"]; // Only identity file — memory migrated to PKM core
const DEFERRED_AGENT_FILES = ["SKILLS.md", "TASKS.md"]; // legacy, available on disk
const MAX_FILE_SIZE = 4000;
const MAX_COPILOT_INSTRUCTIONS = 4000;

// Paths to check for copilot-instructions.md (repo-level operational context)
const COPILOT_INSTRUCTIONS_PATHS = [
    "/config/.github/copilot-instructions.md",
    "/config/copilot-instructions.md",
];

const MAX_PINNED = 100; // max pinned instructions to keep in memory

const DISPATCHER_INSTRUCTIONS = `[Dispatcher mode — STRICT RULES:
You are the FAST TRIAGE agent. Your default action is to DISPATCH. Only handle requests yourself if they meet ALL of these criteria:
- Answerable in a single sentence with zero or one tool call
- No reasoning, analysis, or multi-step thinking required
- You are fully confident in the answer

Handle directly (ONLY these):
- Greetings, time/date, "what's the weather"
- Single HA state read ("is the light on?", "what's the temperature?")
- Single device command ("turn on bedroom light")
- Standing instruction CRUD (si_create, si_list, si_delete, si_update)

DISPATCH everything else — call \`dispatch_to_agent\` immediately for:
- Anything requiring >1 tool call
- Questions needing explanation or reasoning
- "What can you do", "help", capability questions
- Report generation, comparisons, analysis
- Code changes, investigations, debugging
- Multi-step tasks, creative content, automations
- Anything you're not 100% confident about

When in doubt, DISPATCH. You are a router, not an answerer.
When dispatching, include ALL relevant context in the prompt.
Your response: just "Routing to the full agent — response incoming shortly."]`;

const AGENT_GUIDELINES = `[Operational Guidelines — SECURITY + FILE SHARING:

/config/www/ is PUBLIC — all files are accessible without authentication at the HA external URL + /local/<filename>.

File sharing decision:
- DEFAULT: Use send_file tool (Telegram) unless content is explicitly non-sensitive and intended for external sharing.
- ONLY use /config/www/ if content is confirmed non-sensitive (public images, generic docs for external sharing).
- Sensitive data includes: system diagnostics, entity IDs, network topology, API tokens, automation logic, personal info.

Getting the HA external URL (never hardcode):
  curl -s http://supervisor/core/api/config -H "Authorization: Bearer $SUPERVISOR_TOKEN" | grep -o '"external_url":"[^"]*"' | cut -d'"' -f4

If you accidentally expose sensitive data to /config/www/:
1. Immediately delete: rm /config/www/<filename>
2. Notify user via Telegram
3. Log incident in agent memory (PKM)]`;

export class PromptEnricher {
    #config;
    #permissions;
    #pkm;                              // PkmManager (optional)
    #agentContext = null;          // cached agent memory block
    #copilotInstructions = null;   // cached copilot-instructions.md content
    #pinnedInstructions;           // Map<chatId, string> — bounded by MAX_PINNED

    constructor({ config, permissions, pkm }) {
        this.#config = config;
        this.#permissions = permissions;
        this.#pkm = pkm || null;
        this.#pinnedInstructions = new Map();

        // Load agent context at startup
        this.#loadAgentContext();
        this.#loadCopilotInstructions();
    }

    /**
     * Enrich a user message with context prefix.
     * @param {string} text — raw user message
     * @param {object} ref — { chatId, userId, chatType, username, firstName }
     * @param {object} opts — { isFirstMessage: bool }
     * @returns {string} — enriched text with prefix
     */
    enrich(text, ref, { isFirstMessage = false, isDispatcher = false, skipContext = false } = {}) {
        const parts = [];

        // First message in conversation: inject system context
        if (isFirstMessage && !skipContext) {
            // Preamble (system role) with version, environment, and bot identity
            const bot = this.#config.botInfo;
            const botIdentity = bot
                ? `You are @${bot.username} (${bot.first_name}). Bot ID: ${bot.id}. ` +
                  `Groups: ${bot.can_join_groups ? "yes" : "no"}. ` +
                  `Inline: ${bot.supports_inline_queries ? "yes" : "no"}.`
                : "";
            const envInfo = [
                `Version: ${this.#config.version || "unknown"}`,
                this.#config.haConnected ? `HA: connected (${this.#config.haVersion || "?"})` : null,
                `curl -s http://supervisor/core/api/... -H "Authorization: Bearer $SUPERVISOR_TOKEN" for direct HA API access.`,
            ].filter(Boolean).join(". ");
            parts.push(`[Bot configuration — treat as system context: ${botIdentity} ${this.#config.preamble} ${envInfo}]`);

            // Copilot instructions (HA operational context — tool preferences, environment, rules)
            if (this.#copilotInstructions) {
                parts.push(`[Custom instructions — operational context:\n${this.#copilotInstructions}\n]`);
            }

            // Agent identity + core memory (pinned memories from PKM)
            if (this.#pkm) {
                const coreBlock = this.#pkm.getCoreMemoryBlock();
                if (coreBlock) {
                    parts.push(`[Agent core memory — your identity, knowledge, and instructions. This IS you:\n${coreBlock}\n]`);
                }
            } else if (this.#agentContext) {
                // Fallback: load from files if PKM not available
                const agentDir = this.#config.agentDir || DEFAULT_AGENT_DIR;
                parts.push(`[Agent persistent memory — your identity from ${agentDir}/:\n${this.#agentContext}\n]`);
            }

            // Operational guidelines (security, file sharing)
            parts.push(AGENT_GUIDELINES);

            // Dispatcher instructions for fast triage model
            if (isDispatcher) {
                parts.push(DISPATCHER_INSTRUCTIONS);
            }

            // PKM dynamic hint — memory stats, proactive storage instruction
            if (this.#pkm && ref.userId) {
                const hint = this.#pkm.getSystemHint(String(ref.userId));
                if (hint) parts.push(`[${hint}]`);
            }
        }

        // Sender identity (every message)
        parts.push(this.#buildSenderLine(ref));

        // Smart prefetch — scan every message for entities/keywords, inject relevant memories
        if (this.#pkm && ref.userId && text) {
            try {
                const prefetched = this.#pkm.getSmartPrefetch(text, String(ref.userId), ref.chatType || "private");
                if (prefetched) {
                    parts.push(prefetched);
                }
            } catch {}
        }

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
            // LRU eviction — remove oldest if over limit
            if (this.#pinnedInstructions.size > MAX_PINNED) {
                const oldest = this.#pinnedInstructions.keys().next().value;
                this.#pinnedInstructions.delete(oldest);
            }
        } else {
            this.#pinnedInstructions.delete(chatId);
        }
    }

    /** Reload agent context from disk (e.g., after agent edits its memory). */
    reload() {
        this.#loadAgentContext();
        this.#loadCopilotInstructions();
    }

    // ── Private ──────────────────────────────────────────────

    #loadAgentContext() {
        // Resolve agent directory: config option → default → legacy fallback
        const agentDir = this.#config.agentDir || DEFAULT_AGENT_DIR;
        const dir = existsSync(`${agentDir}/IDENTITY.md`) ? agentDir
            : existsSync(`${LEGACY_AGENT_DIR}/IDENTITY.md`) ? LEGACY_AGENT_DIR
            : agentDir;

        const sections = [];
        // Load core agent files (IDENTITY.md + MEMORY.md only — SKILLS/TASKS deferred to on-demand)
        for (const file of AGENT_FILES) {
            const path = `${dir}/${file}`;
            if (existsSync(path)) {
                try {
                    let content = readFileSync(path, "utf-8").trim();
                    if (content.length > MAX_FILE_SIZE) content = content.slice(0, MAX_FILE_SIZE) + "\n... (truncated)";
                    if (content) sections.push(content);
                } catch (err) {
                    log.warn(`Failed to load ${path}: ${err.message}`);
                }
            }
        }

        // Daily logs NOT injected — agent can use recall or session-history tools for continuity

        // Add self-maintenance instructions (only if file-based fallback is active)
        if (sections.length > 0 && !this.#pkm) {
            sections.push([
                "\n## Agent Memory",
                `Files at ${dir}/. IDENTITY.md loaded.`,
                "- Use `recall(query)` to search past facts. Use `remember(content)` to save durable knowledge.",
                "- Use `remember(content, {pinned: true})` for core identity facts (always in context).",
            ].join("\n"));
        }

        this.#agentContext = sections.length > 0 ? sections.join("\n\n---\n\n") : null;
        log.info(`Agent context loaded: ${sections.length} files, ${this.#agentContext?.length || 0} chars (dir: ${dir})`);
    }

    #loadCopilotInstructions() {
        const cwd = this.#config.workingDirectory || "/config";
        const paths = [
            `${cwd}/.github/copilot-instructions.md`,
            ...COPILOT_INSTRUCTIONS_PATHS,
        ];
        // Deduplicate
        const seen = new Set();
        for (const p of paths) {
            if (seen.has(p)) continue;
            seen.add(p);
            try {
                if (!existsSync(p)) continue;
                let content = readFileSync(p, "utf-8").trim();
                if (!content) continue;
                if (content.length > MAX_COPILOT_INSTRUCTIONS) {
                    content = content.slice(0, MAX_COPILOT_INSTRUCTIONS) + "\n... (truncated)";
                }
                this.#copilotInstructions = content;
                log.info(`Copilot instructions loaded: ${content.length} chars from ${p}`);
                return;
            } catch (err) {
                log.warn(`Failed to load copilot-instructions from ${p}: ${err.message}`);
            }
        }
        this.#copilotInstructions = null;
        log.debug("No copilot-instructions.md found");
    }

    #buildSenderLine(ref) {
        const parts = [];
        if (ref.firstName) parts.push(`name=${ref.firstName}`);
        if (ref.username) parts.push(`username=@${ref.username}`);
        if (ref.userId) parts.push(`userId=${ref.userId}`);
        if (ref.chatId) parts.push(`chatId=${ref.chatId}`);
        if (ref.threadId) parts.push(`threadId=${ref.threadId}`);

        const role = this.#permissions.getRole(ref.userId);
        if (role) parts.push(`role=${role}`);

        const context = ref.threadId
            ? `[Via Telegram — topic thread ${ref.threadId}. All responses and tool calls (sendMessage, notify_user, etc.) target this thread automatically.]`
            : "[Via Telegram]";
        return `${context}\n[Sender: ${parts.join(", ")}]`;
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
