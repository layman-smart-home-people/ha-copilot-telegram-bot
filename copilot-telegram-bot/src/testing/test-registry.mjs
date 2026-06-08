// ============================================================
// TestRegistry — Self-test framework for requirement verification
// ============================================================
// Registers test functions keyed by requirement ID. Each test
// returns { status: 'pass'|'fail'|'skip', detail: string }.
// Results persisted to /config/www/ezra-test-results.json.
//
// Relationship to metrics.mjs: metrics tracks cumulative production
// counters. Instrumentation (instrumentation.mjs) tracks resettable
// per-test-run counters for self-test assertions only.

import { writeFile } from "node:fs/promises";
import { createLogger } from "../logger.mjs";
import { instrumentation } from "./instrumentation.mjs";

const log = createLogger("test-registry");
const RESULTS_PATH = "/config/www/ezra-test-results.json";
const TEST_TIMEOUT_MS = 30_000;

class TestRegistry {
    /** @type {Map<string, { phase: string, title: string, fn: Function }>} */
    #tests = new Map();

    /** @type {object|null} — bot context injected at startup */
    #ctx = null;

    /** Mutex: reject concurrent test runs */
    #running = false;

    /**
     * Register a test for a requirement.
     * @param {string} id — requirement ID (e.g. "SI-1")
     * @param {string} phase — phase letter (e.g. "A")
     * @param {string} title — short title
     * @param {Function} fn — async (ctx) => { status, detail }
     */
    register(id, phase, title, fn) {
        this.#tests.set(id, { phase: phase.toUpperCase(), title, fn });
    }

    /**
     * Inject bot context so tests can inspect internals.
     * Call once at startup after all components are wired.
     * @param {object} ctx — { orchestrator, telegram, haOrchestrator, ... }
     */
    setContext(ctx) {
        this.#ctx = ctx;
        log.info(`Test context set (${this.#tests.size} tests registered)`);
    }

    /** List all registered test IDs with phase and title. */
    list() {
        const result = [];
        for (const [id, { phase, title }] of this.#tests) {
            result.push({ id, phase, title });
        }
        return result;
    }

    /**
     * Run a single test by requirement ID.
     * @returns {{ id, phase, title, status, detail, durationMs }}
     */
    async run(id) {
        const test = this.#tests.get(id);
        if (!test) {
            return { id, phase: "?", title: "Unknown", status: "skip", detail: `Unknown requirement: ${id}`, durationMs: 0 };
        }
        if (!this.#ctx) {
            return { id, phase: test.phase, title: test.title, status: "skip", detail: "Test context not initialized yet", durationMs: 0 };
        }
        const start = Date.now();
        try {
            const result = await Promise.race([
                test.fn(this.#ctx, instrumentation),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Test timed out (30s)")), TEST_TIMEOUT_MS)
                ),
            ]);
            return {
                id,
                phase: test.phase,
                title: test.title,
                status: result.status || "fail",
                detail: result.detail || "",
                durationMs: Date.now() - start,
            };
        } catch (err) {
            return {
                id,
                phase: test.phase,
                title: test.title,
                status: "fail",
                detail: `Error: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    }

    /**
     * Run all tests for a given phase.
     * @returns {{ passed, failed, skipped, total, summary, results[] }}
     */
    async runPhase(phase) {
        const upper = phase.toUpperCase();
        const ids = [...this.#tests.entries()]
            .filter(([, t]) => t.phase === upper)
            .map(([id]) => id);
        return this.#runMultiple(ids);
    }

    /**
     * Run all registered tests.
     * @returns {{ passed, failed, skipped, total, summary, results[] }}
     */
    async runAll() {
        return this.#runMultiple([...this.#tests.keys()]);
    }

    async #runMultiple(ids) {
        if (this.#running) {
            return { error: "Test run already in progress" };
        }
        this.#running = true;
        try {
            const results = [];
            for (const id of ids) {
                results.push(await this.run(id));
            }
            const passed = results.filter(r => r.status === "pass").length;
            const failed = results.filter(r => r.status === "fail").length;
            const skipped = results.filter(r => r.status === "skip").length;
            const total = results.length;
            const output = {
                timestamp: new Date().toISOString(),
                passed,
                failed,
                skipped,
                total,
                summary: `${passed}/${total} passed, ${failed} failed, ${skipped} skipped`,
                results,
            };
            await this.#persistResults(output);
            return output;
        } finally {
            this.#running = false;
        }
    }

    async #persistResults(output) {
        try {
            await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2));
            log.info(`Test results written to ${RESULTS_PATH} (${output.passed}/${output.total} passed)`);
        } catch (err) {
            log.warn(`Failed to persist test results: ${err.message}`);
        }
    }
}

/** Module-level singleton. */
export const testRegistry = new TestRegistry();
