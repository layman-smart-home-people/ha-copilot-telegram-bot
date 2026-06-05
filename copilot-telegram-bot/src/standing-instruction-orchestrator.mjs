// ============================================================
// Standing Instruction Orchestrator
// ============================================================
// Wires HAEventListener + StandingInstructionManager + Bridge
// to evaluate triggers and wake the agent or send notifications.

const CRON_CHECK_INTERVAL_MS = 60_000;
const TIMER_CHECK_INTERVAL_MS = 15_000;

export class StandingInstructionOrchestrator {
    #eventListener;
    #manager;
    #bridge;
    #telegram;
    #ownerChatId;
    #log;
    #cronTimer = null;
    #timerTimer = null;
    #started = false;

    constructor({ eventListener, manager, bridge, telegram, ownerChatId, log }) {
        this.#eventListener = eventListener;
        this.#manager = manager;
        this.#bridge = bridge;
        this.#telegram = telegram;
        this.#ownerChatId = ownerChatId;
        this.#log = typeof log === "function" ? log : console.log;
    }

    get manager() { return this.#manager; }
    get eventListener() { return this.#eventListener; }
    get started() { return this.#started; }

    async start() {
        if (this.#started) return;
        this.#started = true;
        this.#log("[STANDING] Orchestrator starting...");

        // Wire HA event listener
        this.#eventListener.on("state_changed", (event) => this.#onStateChanged(event));
        this.#eventListener.on("error", (err) => {
            this.#log(`[STANDING] HA event error: ${err.message}`);
        });

        try {
            await this.#eventListener.start();
            this.#log("[STANDING] HA event listener connected");
        } catch (err) {
            this.#log(`[STANDING] HA event listener failed to start: ${err.message}`);
            // Non-fatal — will reconnect automatically
        }

        // Start cron evaluation loop
        this.#cronTimer = setInterval(() => this.#evaluateCron(), CRON_CHECK_INTERVAL_MS);

        // Start timer evaluation loop
        this.#timerTimer = setInterval(() => this.#evaluateTimers(), TIMER_CHECK_INTERVAL_MS);

        const instructions = this.#manager.list();
        const enabled = instructions.filter(i => i.enabled).length;
        this.#log(`[STANDING] Orchestrator started — ${enabled}/${instructions.length} instructions enabled`);
    }

    async stop() {
        if (!this.#started) return;
        this.#started = false;

        if (this.#cronTimer) {
            clearInterval(this.#cronTimer);
            this.#cronTimer = null;
        }
        if (this.#timerTimer) {
            clearInterval(this.#timerTimer);
            this.#timerTimer = null;
        }

        try {
            await this.#eventListener.stop();
        } catch {}

        this.#log("[STANDING] Orchestrator stopped");
    }

    #onStateChanged(event) {
        try {
            const matches = this.#manager.matchStateChange(
                event.entity_id,
                event.new_state,
                event.old_state,
                event.attributes,
            );

            for (const instruction of matches) {
                this.#log(`[STANDING] Matched: "${instruction.description}" (${instruction.id}) for ${event.entity_id}: ${event.old_state} → ${event.new_state}`);
                this.#manager.markTriggered(instruction.id);
                this.#executeAction(instruction, {
                    trigger_type: "state_change",
                    entity_id: event.entity_id,
                    old_state: event.old_state,
                    new_state: event.new_state,
                });
            }
        } catch (err) {
            this.#log(`[STANDING] Error evaluating state_changed: ${err.message}`);
        }
    }

    #evaluateCron() {
        try {
            const now = new Date();
            const cronInstructions = this.#manager.getCronInstructions();

            for (const instruction of cronInstructions) {
                if (this.#manager.cronMatches(instruction.trigger.expression, now)) {
                    this.#log(`[STANDING] Cron matched: "${instruction.description}" (${instruction.id})`);
                    this.#manager.markTriggered(instruction.id);
                    this.#executeAction(instruction, {
                        trigger_type: "cron",
                        expression: instruction.trigger.expression,
                        time: now.toISOString(),
                    });
                }
            }
        } catch (err) {
            this.#log(`[STANDING] Error evaluating cron: ${err.message}`);
        }
    }

    #evaluateTimers() {
        try {
            const expired = this.#manager.getExpiredTimers();

            for (const instruction of expired) {
                this.#log(`[STANDING] Timer expired: "${instruction.description}" (${instruction.id})`);
                this.#manager.markTriggered(instruction.id);
                this.#executeAction(instruction, {
                    trigger_type: "timer",
                    fire_at: instruction.trigger.fire_at,
                });
            }
        } catch (err) {
            this.#log(`[STANDING] Error evaluating timers: ${err.message}`);
        }
    }

    #executeAction(instruction, context) {
        const contextSummary = this.#formatContext(context);

        switch (instruction.action.type) {
        case "wake_agent": {
            const prompt = `[Standing Instruction Triggered]\n` +
                `Instruction: "${instruction.description}"\n` +
                `Trigger: ${contextSummary}\n` +
                `Agent prompt: ${instruction.action.prompt}`;
            this.#bridge.injectSystemPrompt(prompt, this.#ownerChatId).catch(err => {
                this.#log(`[STANDING] Failed to wake agent: ${err.message}`);
            });
            break;
        }
        case "notify": {
            const message = `🔔 *Standing Instruction*\n` +
                `_${instruction.description}_\n\n` +
                `${instruction.action.message}\n\n` +
                `Trigger: ${contextSummary}`;
            if (this.#ownerChatId) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(this.#ownerChatId, message, { parse_mode: "Markdown" })
                );
            }
            break;
        }
        default:
            this.#log(`[STANDING] Unknown action type: ${instruction.action.type}`);
        }
    }

    #formatContext(context) {
        switch (context.trigger_type) {
        case "state_change":
            return `${context.entity_id} changed from "${context.old_state}" to "${context.new_state}"`;
        case "cron":
            return `cron schedule "${context.expression}" at ${context.time}`;
        case "timer":
            return `timer fired at ${context.fire_at}`;
        default:
            return JSON.stringify(context);
        }
    }
}
