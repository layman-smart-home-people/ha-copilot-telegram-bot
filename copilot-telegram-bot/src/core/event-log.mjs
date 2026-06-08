// ============================================================
// EventLog — Structured append-only JSONL event log
// ============================================================
// Records lifecycle events (acp start/stop/crash, prompt
// start/complete/error/timeout, session events) to a rotating
// JSONL file for post-mortem analysis and trend observation.
//
// All writes are fire-and-forget — never blocks the prompt pipeline.

import { appendFile, rename, stat } from "node:fs/promises";
import { createLogger } from "../logger.mjs";
import { instrumentation } from "../testing/instrumentation.mjs";

const log = createLogger("event-log");

const DEFAULT_PATH = "/data/acp-events.jsonl";
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ROTATION_CHECK_INTERVAL = 100;    // check size every N writes

class EventLog {
    #path;
    #writeCount = 0;
    #writeChain = Promise.resolve(); // serialize writes to prevent rotation race

    constructor(path = DEFAULT_PATH) {
        this.#path = path;
    }

    /**
     * Record a structured event. Fire-and-forget — never throws.
     * @param {string} event - event name (e.g. "acp.started", "prompt.completed")
     * @param {object} data - event-specific payload
     */
    emit(event, data = {}) {
        instrumentation.recordEvent(event);
        const entry = {
            ts: new Date().toISOString(),
            event,
            ...data,
        };
        this.#writeChain = this.#writeChain
            .then(() => this.#write(entry))
            .catch((err) => log.warn(`Event log write failed: ${err.message}`));
    }

    async #write(entry) {
        const line = JSON.stringify(entry) + "\n";
        await appendFile(this.#path, line);
        this.#writeCount++;
        if (this.#writeCount % ROTATION_CHECK_INTERVAL === 0) {
            await this.#maybeRotate();
        }
    }

    async #maybeRotate() {
        try {
            const st = await stat(this.#path);
            if (st.size > MAX_SIZE_BYTES) {
                await rename(this.#path, this.#path + ".1");
                log.info(`Event log rotated (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
            }
        } catch {
            // File doesn't exist yet or other stat error — ignore
        }
    }
}

/** Module-level singleton — import and use directly. */
export const eventLog = new EventLog();
