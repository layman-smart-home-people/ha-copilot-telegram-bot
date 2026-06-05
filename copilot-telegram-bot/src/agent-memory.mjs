// ============================================================
// Agent Memory — Persistent identity & memory loader
// ============================================================
// Reads the agent's persistent memory directory and assembles
// context to inject into each new session's preamble.
// Inspired by OpenClaw's MEMORY.md + daily log pattern.

import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_AGENT_DIR = "/config/copilot-telegram-bot";
const LEGACY_AGENT_DIR = "/config/.agent";
const MAX_FILE_SIZE = 8000;
const MAX_DAILY_LOG_SIZE = 4000;
const DAILY_LOGS_TO_LOAD = 2; // today + yesterday

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
- Home Assistant API (states, services, history, automations)
- Telegram Bot (messaging, notifications, inline keyboards)
- **Standing Instructions** — you natively create, manage, and chain standing instructions in \`/data/standing_instructions.json\`. Refer to SKILLS.md for the full schema.
- File system access to /config (HA configuration directory)
- Web search and research capabilities
- Code editing and development tools

## Rules
- Always confirm before destructive or irreversible actions (locks, alarms, deleting data)
- Never expose tokens, secrets, or credentials
- Prefer HA automations for time-critical recurring tasks; use standing instructions for complex decision-making that needs agent reasoning
- Keep responses concise for Telegram (under 300 words unless asked for detail)
- When interrupted mid-task, record progress in TASKS.md before the session ends
- **Reactive requests → standing instructions**: When the user asks for reactive behavior ("when X happens, do Y"), always create a standing instruction — never modify HA automations/scripts directly. Default to \`one_shot: true\` unless the user indicates it should be recurring.
`;

const MEMORY_DEFAULT = `# Agent Memory

Long-term curated knowledge. Updated by the agent as important facts are learned.
The agent should periodically distill key information from daily logs into this file.

## Home & People
<!-- Agent: add household member names, preferences, routines here -->

## Preferences
<!-- Agent: add user preferences as they are learned -->

## Key Entities
<!-- Agent: add frequently used entity IDs and notes here -->

## Standing Decisions
<!-- Agent: add recurring decisions or policies here -->
`;

const SKILLS_DEFAULT = `# Standing Instructions — Agent Reference

Standing instructions let the agent create automated alerts, reminders, and scheduled tasks that persist across restarts.

## File Location

\`/data/standing_instructions.json\`

## JSON Format

\`\`\`json
{
  "version": 1,
  "instructions": [ ... ]
}
\`\`\`

## Instruction Schema

Each instruction has these fields:

- **id** (string, UUID) — auto-generated on creation
- **description** (string, required) — human-readable description
- **enabled** (boolean) — whether the instruction is active. Default: true
- **trigger** (object, required) — when to fire (see trigger types below)
- **action** (object, required) — what to do when fired (see action types below)
- **cooldown_seconds** (number) — minimum seconds between firings. Default: 300
- **one_shot** (boolean) — auto-disables after firing once. Default: false
- **max_triggers** (number or null) — auto-disables after this many firings
- **trigger_count** (number) — how many times fired (auto-incremented)
- **expires_at** (ISO 8601 or null) — auto-disables after this time
- **notes** (string or null) — free-form context for agent decisions between chained instructions
- **chain_enable** (array of IDs or null) — instruction IDs to auto-enable when this fires

## Trigger Types

### state_change
Fires when a HA entity state changes and matches conditions.
- **entity_id** (required): single string or array of entity IDs
- **to**: exact match on new value (null = any)
- **from**: exact match on old value (null = any)
- **above** / **below**: numeric thresholds
- **attribute**: monitor a specific attribute instead of main state

### cron
Fires on a schedule: \`"expression": "0 8 * * *"\` (5-field cron)

### timer
Fires once at a specific time: \`"fire_at": "2025-01-15T14:30:00.000Z"\`

## Action Types

### wake_agent
Wakes the AI agent with a prompt for complex tasks.
\`\`\`json
{ "type": "wake_agent", "prompt": "Check the temperature and suggest actions." }
\`\`\`

### notify
Sends a Telegram notification directly (no agent involvement).
\`\`\`json
{ "type": "notify", "message": "💊 Time to take your medicine!" }
\`\`\`

### ha_service
Calls a HA service directly without waking the agent (fast, lightweight).
\`\`\`json
{
  "type": "ha_service",
  "domain": "light",
  "service": "turn_on",
  "data": { "entity_id": "light.kitchen" },
  "message": "💡 Kitchen light turned on"
}
\`\`\`
- **domain** (required): HA service domain (must be in the allowed list)
- **service** (required): service name (e.g., turn_on, turn_off, toggle)
- **data** (optional): service call payload
- **message** (optional): Telegram notification after the call

Allowed domains: light, switch, scene, script, input_boolean, input_number, input_select, input_text, input_datetime, fan, cover, media_player, climate, vacuum, button, number, select, lock, siren.

## Chaining Instructions

Use \`chain_enable\` to create sequences:
1. Instruction A fires and auto-enables instruction B (which starts disabled)
2. Instruction B fires when its trigger matches

Example: "Turn on light when entering" → chain_enable → "Turn off light when leaving"

## Notes

- **cooldown_seconds**: prevents alert fatigue. Set to 0 for no cooldown.
- **one_shot + chain_enable**: combine for one-time event chains.
- **notes field**: use to pass context between chained instructions.
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
    #log;

    constructor({ agentDir = DEFAULT_AGENT_DIR, log } = {}) {
        this.#agentDir = agentDir;
        this.#log = typeof log === "function" ? log : () => {};
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
                    this.#log(`[AGENT-MEM] Migrated from ${LEGACY_AGENT_DIR} to ${this.#agentDir}`);
                } catch (err) {
                    this.#log(`[AGENT-MEM] Migration failed: ${err.message}`);
                }
            }
        }

        // Ensure directory exists
        if (!existsSync(this.#agentDir)) {
            try {
                mkdirSync(this.#agentDir, { recursive: true });
                mkdirSync(join(this.#agentDir, "memory"), { recursive: true });
                this.#seedDefaults();
                this.#log(`[AGENT-MEM] Created agent directory at ${this.#agentDir}`);
            } catch (err) {
                this.#log(`[AGENT-MEM] Failed to create directory: ${err.message}`);
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
            `You have a persistent memory directory at ${agentDir}/. You MUST maintain it:`,
            `- MEMORY.md has been loaded above — update it when you learn important durable facts`,
            "- Update TASKS.md when starting, completing, or being interrupted on a task",
            `- Append observations to today's daily log: ${agentDir}/memory/YYYY-MM-DD.md`,
            "- Periodically distill key insights from daily logs into MEMORY.md",
            "- Keep files concise — MEMORY.md under 200 lines, daily logs under 100 lines",
            "- This is YOUR persistent self. These files define who you are across sessions.",
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
                this.#log(`[AGENT-MEM] ${filename} truncated (${content.length} > ${MAX_FILE_SIZE})`);
                return content.slice(0, MAX_FILE_SIZE) + "\n... (truncated)";
            }
            return content;
        } catch (err) {
            this.#log(`[AGENT-MEM] Failed to read ${filename}: ${err.message}`);
            return null;
        }
    }

    #readDailyLogs() {
        const memoryDir = join(this.#agentDir, "memory");
        if (!existsSync(memoryDir)) return null;

        const today = new Date();
        const dates = [];
        for (let i = 0; i < DAILY_LOGS_TO_LOAD; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            dates.push(this.#formatDate(d));
        }

        const logs = [];
        for (const date of dates) {
            const filePath = join(memoryDir, `${date}.md`);
            try {
                if (!existsSync(filePath)) continue;
                let content = readFileSync(filePath, "utf-8").trim();
                if (!content) continue;
                if (content.length > MAX_DAILY_LOG_SIZE) {
                    content = content.slice(0, MAX_DAILY_LOG_SIZE) + "\n... (truncated)";
                }
                logs.push(`## Daily Log: ${date}\n${content}`);
            } catch (err) {
                this.#log(`[AGENT-MEM] Failed to read daily log ${date}: ${err.message}`);
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
