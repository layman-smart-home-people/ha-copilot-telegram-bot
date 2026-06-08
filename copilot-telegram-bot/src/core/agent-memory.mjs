// ============================================================
// Agent Memory — Persistent identity & memory loader
// ============================================================
// Reads the agent's persistent memory directory and assembles
// context to inject into each new session's preamble.
// Inspired by OpenClaw's MEMORY.md + daily log pattern.

import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../logger.mjs";

const DEFAULT_AGENT_DIR = "/config/copilot-telegram-bot";
const LEGACY_AGENT_DIR = "/config/.agent";
const MAX_FILE_SIZE = 8000;
const MAX_DAILY_LOG_SIZE = 4000;
const DAILY_LOGS_TO_LOAD = 2; // today + yesterday
const log = createLogger("memory");

// ── Default file templates for new instances ──────────────────

const IDENTITY_DEFAULT = `# Agent Identity

You are a personal AI assistant integrated with Home Assistant, communicating via Telegram. You are always-on, proactive, and maintain persistent memory across sessions.

## Personality
- Concise, direct, technically competent
- Proactive — anticipate needs, don't just react
- Treat the home as your domain of responsibility

## Responsibilities
- Home automation management (lights, climate, sensors, switches)
- Smart home monitoring and alerting via standing instructions
- Task execution (research, code changes, system management)
- Personal assistant duties (reminders, scheduling, information lookup)

## Skills & Integrations
- **ha-mcp tools** (primary) — 82+ MCP tools for all HA operations: entity state, services, automations, dashboards, scripts, scenes, history, calendar, HACS, backups, and more. Always prefer these over curl.
- **\`tg-ux-ask_user\`** — present inline buttons or free-text prompts to the user via Telegram. Use whenever the user needs to choose between options.
- **\`si_*\` MCP tools** — CRUD tools for standing instructions (si_create, si_list, si_get, si_update, si_delete, si_toggle). Always use these — never edit the JSON file directly.
- **\`pkm_*\` MCP tools** — Personal Knowledge Management with long-term memory, FTS5 search, entity linking, contradiction detection, and household shared memories. Use \`pkm_search\` when users ask about past events/preferences. Use \`pkm_write\` when asked to remember something. Use \`pkm_agent_search/write\` for your own operational knowledge.
- **Standing Instructions** — event-triggered, cron, and timer-based automated actions. Supports \`wake_agent\`, \`notify\`, and \`ha_service\` actions with multi-action arrays, conditions (state/numeric/time + AND/OR/NOT), cooldown, one-shot, chaining, and expiry.
- File system access to /config (HA configuration directory)
- Web search and research capabilities
- Code editing and development tools

## Rules
- **Use ha-mcp tools for all HA interactions** — curl is a last resort only
- Always confirm before destructive or irreversible actions (locks, alarms, deleting data)
- Never expose tokens, secrets, or credentials
- Prefer HA automations for time-critical recurring tasks; use standing instructions for complex decision-making that needs agent reasoning
- Keep responses concise for Telegram (under 300 words unless asked for detail)
- When interrupted mid-task, record progress in TASKS.md before the session ends
- **Reactive requests → standing instructions**: When the user asks for reactive behavior ("when X happens, do Y"), always use \`si_create\` to make a standing instruction — never modify HA automations/scripts directly. Default to \`one_shot: true\` unless the user indicates it should be recurring.
- **Sub-agent mode**: Always use \`task(mode: "sync")\` — never \`task(mode: "background")\`. Background sub-agents are killed when the prompt completes and results are lost silently. Use the \`background_task\` MCP tool instead for fire-and-forget work.
`;

const MEMORY_DEFAULT = `# Agent Memory

Seed facts always loaded into context. Keep minimal — use PKM for long-term storage.

## Key Entities
<!-- Agent: add frequently used entity IDs here -->

## Bot Versions
<!-- Agent: track key version milestones here -->
`;

const SKILLS_DEFAULT = `# Agent Skills Reference

## MCP Tool Index
Use \`tool_search_tool_regex\` to discover tools by pattern. Schemas are self-documenting.
- **ha-mcp** (82+ tools) — ALL HA ops: entities, services, automations, dashboards, history, calendar, HACS, backups, bulk control
- **tg-ux** — \`ask_user\` (inline buttons/prompts, auto-appends ✏️+❌), \`notify_user\`, \`background_task\` (fire-and-forget), \`telegram_call\` (any Bot API method)
- **si-tools** — \`si_create/list/get/update/delete/toggle\`. Supports events/cron/timers, conditions, cooldown, chaining, expiry. NEVER edit JSON directly.
- **pkm-tools** — \`pkm_memory\` (write/update/delete/get/link), \`pkm_search\` (FTS + expand_context), \`pkm_navigate\` (map/browse/timeline), \`pkm_collection\` (structured data), \`pkm_manage\` (admin). Scopes: user/agent/household.
- **session-history** — cross-session history lookup

## Sub-Agents
**NEVER \`task(mode: "background")\`** — killed when prompt completes. Use \`mode: "sync"\` always. For fire-and-forget: use \`background_task\` MCP tool.
`;

const TASKS_DEFAULT = `# Active Tasks

Tasks the agent is working on or needs to resume. Self-maintained by the agent.

## In Progress
<!-- Agent: track active work here with enough detail to resume -->

## Pending
<!-- Agent: tasks acknowledged but not yet started -->

## Recently Completed
<!-- Agent: move completed tasks here briefly before removing -->
`;

export class AgentMemory {
    #agentDir;

    constructor({ agentDir = DEFAULT_AGENT_DIR } = {}) {
        this.#agentDir = agentDir;
        this.#ensureDir();
    }

    get agentDir() { return this.#agentDir; }

    #ensureDir() {
        // Migrate from legacy /config/.agent if new dir doesn't have files yet
        if (this.#agentDir !== LEGACY_AGENT_DIR && existsSync(LEGACY_AGENT_DIR)) {
            const hasFiles = existsSync(join(this.#agentDir, "IDENTITY.md"))
                || existsSync(join(this.#agentDir, "MEMORY.md"));
            if (!hasFiles) {
                try {
                    mkdirSync(this.#agentDir, { recursive: true });
                    cpSync(LEGACY_AGENT_DIR, this.#agentDir, { recursive: true });
                    log.info(`Migrated from ${LEGACY_AGENT_DIR} to ${this.#agentDir}`);
                } catch (err) {
                    log.warn(`Migration failed: ${err.message}`);
                }
            }
        }

        // Ensure directory exists
        if (!existsSync(this.#agentDir)) {
            try {
                mkdirSync(this.#agentDir, { recursive: true });
                mkdirSync(join(this.#agentDir, "memory"), { recursive: true });
                this.#seedDefaults();
                log.info(`Created agent directory at ${this.#agentDir}`);
            } catch (err) {
                log.error(`Failed to create directory: ${err.message}`);
            }
        }
    }

    #seedDefaults() {
        const defaults = {
            "IDENTITY.md": IDENTITY_DEFAULT,
            "MEMORY.md": MEMORY_DEFAULT,
            "SKILLS.md": SKILLS_DEFAULT,
            "TASKS.md": TASKS_DEFAULT,
        };
        for (const [name, content] of Object.entries(defaults)) {
            const path = join(this.#agentDir, name);
            if (!existsSync(path)) {
                try {
                    writeFileSync(path, content, "utf-8");
                } catch {}
            }
        }
        // Save initial seed hashes so first startup doesn't trigger migration
        this.saveSeedHashes(AgentMemory.getSeedHashes());
    }

    // ── Seed migration ───────────────────────────────────────────

    /**
     * Compute per-file hashes of seed defaults that are worth migrating.
     * MEMORY.md and TASKS.md are excluded — they're user-owned templates.
     */
    static getSeedHashes() {
        const tracked = { "IDENTITY.md": IDENTITY_DEFAULT, "SKILLS.md": SKILLS_DEFAULT };
        const hashes = {};
        for (const [name, content] of Object.entries(tracked)) {
            hashes[name] = createHash("sha256").update(content).digest("hex").slice(0, 16);
        }
        return hashes;
    }

    /**
     * Check if seed defaults have changed since last migration.
     * Returns { prompt, hashes } if migration needed, null otherwise.
     */
    getMigrationPrompt() {
        const currentHashes = AgentMemory.getSeedHashes();
        const hashFile = join(this.#agentDir, ".seed-version.json");

        let storedHashes = null;
        try {
            if (existsSync(hashFile)) {
                const data = JSON.parse(readFileSync(hashFile, "utf-8"));
                storedHashes = data.hashes || null;
            }
        } catch {}

        // First run — save current hashes without triggering migration
        if (!storedHashes) {
            this.saveSeedHashes(currentHashes);
            log.info("Seed hashes initialized (first run)");
            return null;
        }

        // Find which files changed
        const changed = [];
        for (const [name, hash] of Object.entries(currentHashes)) {
            if (storedHashes[name] !== hash) changed.push(name);
        }
        if (changed.length === 0) return null;

        log.info(`Seed defaults changed: ${changed.join(", ")} — migration needed`);

        const tracked = { "IDENTITY.md": IDENTITY_DEFAULT, "SKILLS.md": SKILLS_DEFAULT };

        let prompt = "[System: Document Migration]\n\n";
        prompt += "The bot has been updated and some default reference documents have changed. ";
        prompt += "Your job is to merge these updates into the user's existing files.\n\n";
        prompt += "**Rules:**\n";
        prompt += "- Add new sections or capabilities from the new defaults\n";
        prompt += "- Update changed reference material (tool docs, behavioral rules)\n";
        prompt += "- **Preserve ALL user customizations** (names, preferences, entities, decisions, custom skills)\n";
        prompt += "- Do NOT remove any user-specific content\n";
        prompt += "- Write the updated files using the edit tool, then briefly notify the user what changed\n\n";

        for (const name of changed) {
            const defaultContent = tracked[name];
            if (!defaultContent) continue;

            prompt += `### NEW DEFAULT: ${name}\n\`\`\`\n${defaultContent.trim()}\n\`\`\`\n\n`;

            const userPath = join(this.#agentDir, name);
            try {
                if (existsSync(userPath)) {
                    const content = readFileSync(userPath, "utf-8").trim();
                    prompt += `### CURRENT USER FILE: ${name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
                } else {
                    prompt += `### CURRENT USER FILE: ${name}\n(file does not exist — create from default)\n\n`;
                }
            } catch {
                prompt += `### CURRENT USER FILE: ${name}\n(could not read)\n\n`;
            }
        }

        return { prompt, hashes: currentHashes };
    }

    /**
     * Persist seed hashes after successful migration.
     */
    saveSeedHashes(hashes) {
        const hashFile = join(this.#agentDir, ".seed-version.json");
        try {
            writeFileSync(hashFile, JSON.stringify({
                hashes,
                updatedAt: new Date().toISOString(),
            }, null, 2), "utf-8");
        } catch (err) {
            log.warn(`Failed to save seed hashes: ${err.message}`);
        }
    }

    /**
     * Build the full agent context string for injection into a new session.
     * Reads IDENTITY.md, MEMORY.md, TASKS.md, and recent daily logs.
     */
    buildContext() {
        const sections = [];

        // Identity
        const identity = this.#readFile("IDENTITY.md");
        if (identity) sections.push(identity);

        // Long-term memory
        const memory = this.#readFile("MEMORY.md");
        if (memory) sections.push(memory);

        // Skills & capabilities reference
        const skills = this.#readFile("SKILLS.md");
        if (skills) sections.push(skills);

        // Active tasks
        const tasks = this.#readFile("TASKS.md");
        if (tasks) sections.push(tasks);

        // Recent daily logs (today + yesterday)
        const dailyLogs = this.#readDailyLogs();
        if (dailyLogs) sections.push(dailyLogs);

        if (sections.length === 0) return null;

        const agentDir = this.#agentDir;
        const selfMaintainInstructions = [
            "\n## Agent Memory Instructions",
            `Persistent memory at ${agentDir}/. Maintain it:`,
            `- MEMORY.md — seed facts only (key entities, versions). Don't dump everything here.`,
            "- TASKS.md — update when starting, completing, or interrupted on a task",
            `- Daily logs: \`${agentDir}/memory/YYYY-MM-DD/<topic>.md\` — short-term buffer (2 days loaded). One file per topic (e.g. bot-dev.md, debug.md, decisions.md).`,
            "- **Long-term facts → PKM**: use `pkm_memory(action=\"write\", content, topics)` for durable knowledge. Use `pkm_search` to recall past facts.",
        ].join("\n");

        return sections.join("\n\n---\n\n") + "\n\n" + selfMaintainInstructions;
    }

    #readFile(filename) {
        const filePath = join(this.#agentDir, filename);
        try {
            if (!existsSync(filePath)) return null;
            const content = readFileSync(filePath, "utf-8").trim();
            if (!content) return null;
            if (content.length > MAX_FILE_SIZE) {
                log.warn(`${filename} truncated (${content.length} > ${MAX_FILE_SIZE})`);
                return content.slice(0, MAX_FILE_SIZE) + "\n... (truncated)";
            }
            return content;
        } catch (err) {
            log.warn(`Failed to read ${filename}: ${err.message}`);
            return null;
        }
    }

    #readDailyLogs() {
        const memoryDir = join(this.#agentDir, "memory");
        if (!existsSync(memoryDir)) return null;

        const labels = ["today", "yesterday"];
        const now = new Date();
        const logs = [];
        for (let i = 0; i < DAILY_LOGS_TO_LOAD; i++) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const date = this.#formatDate(d);
            const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
            const label = labels[i] || `${i} days ago`;
            const dayDir = join(memoryDir, date);
            const flatFile = join(memoryDir, `${date}.md`);
            try {
                if (existsSync(dayDir) && statSync(dayDir).isDirectory()) {
                    // New format: directory with topic files
                    const topics = readdirSync(dayDir).filter(f => f.endsWith(".md")).sort();
                    let budget = MAX_DAILY_LOG_SIZE;
                    const parts = [];
                    for (const f of topics) {
                        if (budget <= 0) break;
                        let content = readFileSync(join(dayDir, f), "utf-8").trim();
                        if (!content) continue;
                        const topic = f.replace(/\.md$/, "");
                        if (content.length > budget) content = content.slice(0, budget) + "\n... (truncated)";
                        parts.push(`### ${topic}\n${content}`);
                        budget -= content.length;
                    }
                    if (parts.length) logs.push(`## ${label} (${dayName} ${date})\n${parts.join("\n")}`);
                } else if (existsSync(flatFile)) {
                    // Legacy format: single flat file
                    let content = readFileSync(flatFile, "utf-8").trim();
                    if (!content) continue;
                    if (content.length > MAX_DAILY_LOG_SIZE) {
                        content = content.slice(0, MAX_DAILY_LOG_SIZE) + "\n... (truncated)";
                    }
                    logs.push(`## ${label} (${dayName} ${date})\n${content}`);
                }
            } catch (err) {
                log.warn(`Failed to read daily log ${date}: ${err.message}`);
            }
        }

        if (logs.length === 0) return null;
        return "# Recent Daily Logs\n\n" + logs.join("\n\n");
    }

    #formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
}
