// ============================================================
// Metrics — Cumulative counters, gauges, and histograms
// ============================================================
// In-memory metrics persisted to /data/acp-metrics.json every 60s.
// Survives bot restarts. Manual reset via metrics.reset().

import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../logger.mjs";

const log = createLogger("metrics");
const PERSIST_PATH = "/data/acp-metrics.json";
const PERSIST_INTERVAL_MS = 60_000;

const COUNTER_NAMES = [
    "acp_starts",
    "acp_crashes",
    "acp_restarts",
    "prompts_total",
    "prompt_errors",
    "prompt_timeouts",
    "prompt_cancels",
    "tool_calls_total",
    "tool_errors_total",
    "sessions_created",
    "sessions_exhausted",
    "stall_warnings",
];

const MAX_DURATIONS = 100;

class Metrics {
    #counters = {};
    #gauges = {};
    #promptDurations = []; // last N prompt durations (ms)
    #persistTimer = null;
    #dirty = false;

    constructor() {
        for (const name of COUNTER_NAMES) {
            this.#counters[name] = 0;
        }
        this.#gauges = {
            prompt_active: 0,
            queue_depth: 0,
            queue_depth_max: 0,
        };
    }

    /** Increment a named counter. */
    increment(name, delta = 1) {
        if (name in this.#counters) {
            this.#counters[name] += delta;
            this.#dirty = true;
        } else {
            log.warn(`Unknown counter: ${name}`);
        }
    }

    /** Set a gauge value. */
    gauge(name, value) {
        this.#gauges[name] = value;
        if (name === "queue_depth" && value > (this.#gauges.queue_depth_max || 0)) {
            this.#gauges.queue_depth_max = value;
        }
        this.#dirty = true;
    }

    /** Record a prompt duration for histogram stats. */
    recordDuration(ms) {
        this.#promptDurations.push(ms);
        if (this.#promptDurations.length > MAX_DURATIONS) {
            this.#promptDurations.shift();
        }
        this.#dirty = true;
    }

    /** Serialize metrics for API response. */
    toJSON() {
        const sorted = [...this.#promptDurations].sort((a, b) => a - b);
        const durationStats =
            sorted.length > 0
                ? {
                      count: sorted.length,
                      min_ms: sorted[0],
                      max_ms: sorted[sorted.length - 1],
                      avg_ms: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
                      p95_ms: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
                  }
                : null;

        return {
            counters: { ...this.#counters },
            gauges: { ...this.#gauges },
            prompt_durations: durationStats,
        };
    }

    /** Reset all metrics and persist immediately. */
    reset() {
        for (const key of Object.keys(this.#counters)) {
            this.#counters[key] = 0;
        }
        for (const key of Object.keys(this.#gauges)) {
            this.#gauges[key] = 0;
        }
        this.#promptDurations = [];
        this.#dirty = true;
        this.#persist().catch(() => {});
        log.info("Metrics reset");
    }

    /** Load persisted metrics from disk (call once at startup). */
    async load() {
        try {
            const raw = await readFile(PERSIST_PATH, "utf8");
            const data = JSON.parse(raw);
            if (data.counters) {
                for (const [k, v] of Object.entries(data.counters)) {
                    if (k in this.#counters) this.#counters[k] = v;
                }
            }
            if (data.gauges?.queue_depth_max) {
                this.#gauges.queue_depth_max = data.gauges.queue_depth_max;
            }
            if (Array.isArray(data.prompt_durations_raw)) {
                this.#promptDurations = data.prompt_durations_raw.slice(-MAX_DURATIONS);
            }
            log.info("Metrics loaded from disk");
        } catch {
            log.info("No persisted metrics — starting fresh");
        }
    }

    /** Start periodic persistence timer. */
    startPersistence() {
        this.#persistTimer = setInterval(() => {
            if (this.#dirty) {
                this.#persist().catch((err) => log.warn(`Metrics persist failed: ${err.message}`));
            }
        }, PERSIST_INTERVAL_MS);
        this.#persistTimer.unref?.();
    }

    /** Stop persistence timer and flush. */
    async stopPersistence() {
        if (this.#persistTimer) {
            clearInterval(this.#persistTimer);
            this.#persistTimer = null;
        }
        if (this.#dirty) {
            await this.#persist().catch(() => {});
        }
    }

    async #persist() {
        const data = {
            ...this.toJSON(),
            prompt_durations_raw: this.#promptDurations,
            persisted_at: new Date().toISOString(),
        };
        await writeFile(PERSIST_PATH, JSON.stringify(data, null, 2));
        this.#dirty = false;
    }
}

/** Module-level singleton — import and use directly. */
export const metrics = new Metrics();
