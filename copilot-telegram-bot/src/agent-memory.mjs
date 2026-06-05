// ============================================================
// Agent Memory — Persistent identity & memory loader
// ============================================================
// Reads the agent's persistent memory directory and assembles
// context to inject into each new session's preamble.
// Inspired by OpenClaw's MEMORY.md + daily log pattern.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_AGENT_DIR = "/config/.agent";
const MAX_FILE_SIZE = 8000;
const MAX_DAILY_LOG_SIZE = 4000;
const DAILY_LOGS_TO_LOAD = 2; // today + yesterday

export class AgentMemory {
    #agentDir;
    #log;

    constructor({ agentDir = DEFAULT_AGENT_DIR, log } = {}) {
        this.#agentDir = agentDir;
        this.#log = typeof log === "function" ? log : () => {};
    }

    get agentDir() { return this.#agentDir; }

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

        // Active tasks
        const tasks = this.#readFile("TASKS.md");
        if (tasks) sections.push(tasks);

        // Recent daily logs (today + yesterday)
        const dailyLogs = this.#readDailyLogs();
        if (dailyLogs) sections.push(dailyLogs);

        if (sections.length === 0) return null;

        const selfMaintainInstructions = [
            "\n## Agent Memory Instructions",
            "You have a persistent memory directory at /config/.agent/. You MUST maintain it:",
            "- Read /config/.agent/MEMORY.md at session start (already injected above)",
            "- Update MEMORY.md when you learn important durable facts (preferences, entity IDs, decisions)",
            "- Update TASKS.md when starting, completing, or being interrupted on a task",
            "- Append observations to today's daily log: /config/.agent/memory/YYYY-MM-DD.md",
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
