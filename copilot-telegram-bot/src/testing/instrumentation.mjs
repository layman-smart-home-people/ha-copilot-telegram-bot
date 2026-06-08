// ============================================================
// Instrumentation — Resettable counters for self-test assertions
// ============================================================
// Tracks LLM calls, Telegram API calls, HA service calls, and
// HA template evaluations. Counters are resettable per test run.
// Singleton — import { instrumentation } from this module.

import { createLogger } from "../logger.mjs";

const log = createLogger("instrumentation");

class Instrumentation {
    #counters = {
        llm_calls: 0,
        llm_tokens_input: 0,
        llm_tokens_output: 0,
        telegram_api_calls: 0,
        ha_service_calls: 0,
        ha_template_evals: 0,
        event_bus_events: 0,
    };

    // Detailed logs per category (capped per reset cycle)
    #details = {
        telegram: [],  // { method, ts }
        ha: [],        // { domain, service, ts }
        events: [],    // { event, ts }
    };

    static #MAX_DETAILS = 500;

    /** Record a Telegram API call. */
    recordTelegramCall(method) {
        this.#counters.telegram_api_calls++;
        if (this.#details.telegram.length < Instrumentation.#MAX_DETAILS) {
            this.#details.telegram.push({ method, ts: Date.now() });
        }
    }

    /** Record an HA service call. */
    recordHaServiceCall(domain, service) {
        this.#counters.ha_service_calls++;
        if (this.#details.ha.length < Instrumentation.#MAX_DETAILS) {
            this.#details.ha.push({ domain, service, ts: Date.now() });
        }
    }

    /** Record an HA template evaluation. */
    recordHaTemplateEval() {
        this.#counters.ha_template_evals++;
    }

    /** Record an LLM/ACP call with optional token counts. */
    recordLlmCall(inputTokens = 0, outputTokens = 0) {
        this.#counters.llm_calls++;
        this.#counters.llm_tokens_input += inputTokens;
        this.#counters.llm_tokens_output += outputTokens;
    }

    /** Record an event bus event (SI triggers, HA state changes, etc). */
    recordEvent(eventName) {
        this.#counters.event_bus_events++;
        if (this.#details.events.length < Instrumentation.#MAX_DETAILS) {
            this.#details.events.push({ event: eventName, ts: Date.now() });
        }
    }

    /** Get current counter snapshot (copy). */
    snapshot() {
        return { ...this.#counters };
    }

    /** Get detailed call logs (copy). */
    details() {
        return {
            telegram: [...this.#details.telegram],
            ha: [...this.#details.ha],
            events: [...this.#details.events],
        };
    }

    /** Reset all counters and detail logs. */
    reset() {
        for (const key of Object.keys(this.#counters)) {
            this.#counters[key] = 0;
        }
        this.#details.telegram.length = 0;
        this.#details.ha.length = 0;
        this.#details.events.length = 0;
        log.debug("Instrumentation counters reset");
    }
}

/** Module-level singleton. */
export const instrumentation = new Instrumentation();
