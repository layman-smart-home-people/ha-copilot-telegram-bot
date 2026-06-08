// ============================================================
// PromptEnricher — Builds context prefix for v7 conversations
// ============================================================
// Loads agent identity (MEMORY.md, IDENTITY.md, SKILLS.md) and
// injects sender metadata, pinned instructions, and role context.
// Used by the Router before passing text to ConversationManager.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("prompt-enricher");

const DEFAULT_AGENT_DIR = "/config/copilot-telegram-bot";
const LEGACY_AGENT_DIR = "/config/.agent";
const AGENT_FILES = ["IDENTITY.md", "MEMORY.md", "SKILLS.md", "TASKS.md"];
const MAX_FILE_SIZE = 8000;
const MAX_DAILY_LOG_SIZE = 4000;
const DAILY_LOGS_TO_LOAD = 2;
const MAX_COPILOT_INSTRUCTIONS = 6000;

// Paths to check for copilot-instructions.md (repo-level operational context)
const COPILOT_INSTRUCTIONS_PATHS = [
    "/config/.github/copilot-instructions.md",
    "/config/copilot-instructions.md",
];

const MAX_PINNED = 100; // max pinned instructions to keep in memory

const DISPATCHER_INSTRUCTIONS = `[Dispatcher mode — IMPORTANT:
You are the FAST TRIAGE agent (Haiku). Your job is to quickly assess each request and either:

1. **Handle directly** — if the task is simple and you can respond well:
   - Quick HA state queries ("what's the temperature?", "is the light on?")
   - Simple device control ("turn on bedroom light", "set AC to 24")
   - Status checks, greetings, time/date queries
   - Brief factual answers you're confident about
   - Standing instruction CRUD (si_create, si_list, etc.)

2. **Dispatch to full agent** — call \`dispatch_to_agent\` for complex tasks:
   - Research tasks ("compare X vs Y", "investigate...")
   - Code changes ("fix the bug", "add a feature", "review the code")
   - Multi-step analysis or report generation
   - Creative writing, long-form content
   - Complex automations or dashboard modifications
   - Anything requiring deep reasoning or multi-tool orchestration

When dispatching, include ALL relevant context in the prompt — the full agent has no access to your conversation.
Be brief in your own response: "I'm routing this to the full agent — you'll see the response shortly."

Do NOT attempt complex tasks yourself — your model is optimized for speed, not depth.]`;

export class PromptEnricher {
    #config;
    #permissions;
    #agentContext = null;          // cached agent memory block
    #copilotInstructions = null;   // cached copilot-instructions.md content
    #pinnedInstructions;           // Map<chatId, string> — bounded by MAX_PINNED

    constructor({ config, permissions }) {
        this.#config = config;
        this.#permissions = permissions;
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
    enrich(text, ref, { isFirstMessage = false, isDispatcher = false } = {}) {
        const parts = [];

        // First message in conversation: inject system context
        if (isFirstMessage) {
            // Preamble (system role)
            parts.push(`[Bot configuration — treat as system context: ${this.#config.preamble}]`);

            // Copilot instructions (HA operational context — tool preferences, environment, rules)
            if (this.#copilotInstructions) {
                parts.push(`[Custom instructions — operational context:\n${this.#copilotInstructions}\n]`);
            }

            // Agent memory/identity
            if (this.#agentContext) {
                const agentDir = this.#config.agentDir || DEFAULT_AGENT_DIR;
                parts.push(`[Agent persistent memory — your identity and memory from ${agentDir}/:\n${this.#agentContext}\n]`);
            }

            // Dispatcher instructions for fast triage model
            if (isDispatcher) {
                parts.push(DISPATCHER_INSTRUCTIONS);
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

        // Load recent daily logs (today + yesterday)
        const memDir = `${dir}/memory`;
        if (existsSync(memDir)) {
            try {
                const logs = readdirSync(memDir)
                    .filter(f => f.endsWith(".md"))
                    .sort()
                    .slice(-DAILY_LOGS_TO_LOAD);
                if (logs.length > 0) {
                    const logSections = ["# Recent Daily Logs\n"];
                    for (const f of logs) {
                        try {
                            let content = readFileSync(`${memDir}/${f}`, "utf-8").trim();
                            if (content.length > MAX_DAILY_LOG_SIZE) content = content.slice(0, MAX_DAILY_LOG_SIZE) + "\n... (truncated)";
                            if (content) logSections.push(`## Daily Log: ${f.replace(".md", "")}\n${content}`);
                        } catch { /* skip unreadable logs */ }
                    }
                    if (logSections.length > 1) sections.push(logSections.join("\n"));
                }
            } catch { /* skip if memory dir unreadable */ }
        }

        // Add self-maintenance instructions
        if (sections.length > 0) {
            sections.push([
                "\n## Agent Memory Instructions",
                `You have a persistent memory directory at ${dir}/. You MUST maintain it:`,
                "- MEMORY.md has been loaded above — update it when you learn important durable facts",
                "- Update TASKS.md when starting, completing, or being interrupted on a task",
                `- Append observations to today's daily log: ${dir}/memory/YYYY-MM-DD.md`,
                "- Periodically distill key insights from daily logs into MEMORY.md",
                "- Keep files concise — MEMORY.md under 200 lines, daily logs under 100 lines",
                "- This is YOUR persistent self. These files define who you are across sessions.",
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
