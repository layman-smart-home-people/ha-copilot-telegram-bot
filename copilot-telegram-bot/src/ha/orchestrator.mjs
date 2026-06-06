// ============================================================
// Standing Instruction Orchestrator
// ============================================================
// Wires HAEventListener + StandingInstructionManager + Bridge
// to evaluate triggers and wake the agent or send notifications.

import { watch } from "node:fs";
import { createLogger } from "../logger.mjs";

const CRON_CHECK_INTERVAL_MS = 60_000;
const TIMER_CHECK_INTERVAL_MS = 15_000;
const HA_SERVICE_TIMEOUT_MS = 15_000;
const HA_STATE_FETCH_TIMEOUT_MS = 5_000;

// Domains allowed for ha_service action without agent involvement.
// Restricts automated service calls to safe, non-destructive domains.
const log = createLogger("standing");

const HA_SERVICE_ALLOWED_DOMAINS = new Set([
    "light", "switch", "scene", "script", "input_boolean",
    "input_number", "input_select", "input_text", "input_datetime",
    "fan", "cover", "media_player", "climate", "vacuum",
    "button", "number", "select", "lock", "siren",
]);

export class StandingInstructionOrchestrator {
    #eventListener;
    #manager;
    #bridge;
    #telegram;
    #ownerChatId;
    #cronTimer = null;
    #timerTimer = null;
    #started = false;
    #startedAt = null;
    #triggerCount = 0;
    #boundStateHandler = null;
    #boundErrorHandler = null;
    #paused = false;
    #muteUntil = null;  // timestamp (ms) or null
    #haBaseUrl;
    #haToken;
    #fileWatcher = null;
    #gatingInProgress = new Set();  // instruction IDs currently being gate-checked

    constructor({ eventListener, manager, bridge, telegram, ownerChatId, haBaseUrl, haToken }) {
        this.#eventListener = eventListener;
        this.#manager = manager;
        this.#bridge = bridge;
        this.#telegram = telegram;
        this.#ownerChatId = ownerChatId;
        this.#haBaseUrl = haBaseUrl || "http://supervisor/core/api";
        this.#haToken = haToken || process.env.SUPERVISOR_TOKEN;
    }

    get manager() { return this.#manager; }
    get eventListener() { return this.#eventListener; }
    get started() { return this.#started; }
    get startedAt() { return this.#startedAt; }
    get triggerCount() { return this.#triggerCount; }

    pause() {
        this.#paused = true;
        log.info("Orchestrator paused");
    }

    resume() {
        this.#paused = false;
        this.#muteUntil = null;
        log.info("Orchestrator resumed");
    }

    mute(durationMs) {
        this.#muteUntil = Date.now() + durationMs;
        log.info(`Muted for ${Math.round(durationMs / 60000)}min`);
    }

    get isPaused() {
        if (this.#paused) return true;
        if (this.#muteUntil && Date.now() < this.#muteUntil) return true;
        if (this.#muteUntil && Date.now() >= this.#muteUntil) {
            this.#muteUntil = null;  // auto-expire
        }
        return false;
    }

    status() {
        const instructions = this.#manager.list();
        const enabled = instructions.filter(i => i.enabled).length;
        const uptime = this.#startedAt ? Math.floor((Date.now() - this.#startedAt) / 1000) : 0;
        return {
            started: this.#started,
            haConnected: this.#eventListener.connected,
            uptime,
            triggerCount: this.#triggerCount,
            total: instructions.length,
            enabled,
            paused: this.#paused,
            mutedUntil: this.#muteUntil,
        };
    }

    async reconnectHA() {
        log.info("Reconnecting HA event listener...");
        await this.#eventListener.reconnect();
        log.info(`HA reconnect complete — connected: ${this.#eventListener.connected}`);
        return this.#eventListener.connected;
    }

    async start() {
        if (this.#started) return;
        this.#started = true;
        this.#startedAt = Date.now();
        log.info("Orchestrator starting...");

        // Wire HA event listener
        this.#boundStateHandler = (event) => this.#onStateChanged(event);
        this.#boundErrorHandler = (err) => {
            log.warn(`HA event error: ${err.message}`);
        };
        this.#eventListener.on("state_changed", this.#boundStateHandler);
        this.#eventListener.on("error", this.#boundErrorHandler);

        try {
            await this.#eventListener.start();
            log.info("HA event listener connected");
        } catch (err) {
            log.warn(`HA event listener failed to start: ${err.message}`);
            // Non-fatal — will reconnect automatically
        }

        // Start cron evaluation loop
        this.#cronTimer = setInterval(() => this.#evaluateCron(), CRON_CHECK_INTERVAL_MS);

        // Start timer evaluation loop
        this.#timerTimer = setInterval(() => this.#evaluateTimers(), TIMER_CHECK_INTERVAL_MS);

        // Watch the instructions file for instant hot-reload
        this.#startFileWatcher();

        const instructions = this.#manager.list();
        const enabled = instructions.filter(i => i.enabled).length;
        log.info(`Orchestrator started — ${enabled}/${instructions.length} instructions enabled`);
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

        this.#stopFileWatcher();

        try {
            await this.#eventListener.stop();
        } catch {}

        if (this.#boundStateHandler) {
            this.#eventListener.removeListener("state_changed", this.#boundStateHandler);
            this.#boundStateHandler = null;
        }
        if (this.#boundErrorHandler) {
            this.#eventListener.removeListener("error", this.#boundErrorHandler);
            this.#boundErrorHandler = null;
        }

        log.info("Orchestrator stopped");
    }

    #onStateChanged(event) {
        if (this.isPaused) return;
        try {
            this.#manager.reloadIfChanged();
            const matches = this.#manager.matchStateChange(
                event.entity_id,
                event.new_state,
                event.old_state,
                event.attributes,
            );

            for (const instruction of matches) {
                log.info(`Matched: "${instruction.description}" (${instruction.id}) for ${event.entity_id}: ${event.old_state} → ${event.new_state}`);
                const context = {
                    trigger_type: "state_change",
                    entity_id: event.entity_id,
                    old_state: event.old_state,
                    new_state: event.new_state,
                };
                this.#gateAndExecute(instruction, context).catch(err => {
                    log.error(`Error executing "${instruction.description}": ${err.message}`);
                });
            }
        } catch (err) {
            log.error(`Error evaluating state_changed: ${err.message}`);
        }
    }

    #isInCooldown(instruction) {
        if (!instruction.last_triggered_at) return false;
        const cooldownMs = (instruction.cooldown_seconds || 0) * 1000;
        return cooldownMs > 0 && Date.now() - Date.parse(instruction.last_triggered_at) < cooldownMs;
    }

    #evaluateCron() {
        if (this.isPaused) return;
        try {
            // Hot-reload instructions if the file was modified externally
            this.#manager.reloadIfChanged();

            const allInstructions = this.#manager.list();
            for (const inst of allInstructions) {
                if (!inst.enabled) continue;
                if (inst.expires_at && Date.now() >= Date.parse(inst.expires_at)) {
                    log.info(`Expired: "${inst.description}" (${inst.id})`);
                    this.#manager.disable(inst.id);
                } else if (inst.max_triggers !== null && (inst.trigger_count || 0) >= inst.max_triggers) {
                    log.info(`Exhausted (${inst.trigger_count}/${inst.max_triggers} triggers): "${inst.description}" (${inst.id})`);
                    this.#manager.disable(inst.id);
                }
            }

            const now = new Date();
            const cronInstructions = this.#manager.getCronInstructions();

            for (const instruction of cronInstructions) {
                if (this.#isInCooldown(instruction)) continue;
                if (this.#manager.cronMatches(instruction.trigger.expression, now)) {
                    log.info(`Cron matched: "${instruction.description}" (${instruction.id})`);
                    this.#gateAndExecute(instruction, {
                        trigger_type: "cron",
                        expression: instruction.trigger.expression,
                        time: now.toISOString(),
                    }).catch(err => {
                        log.error(`Error executing cron "${instruction.description}": ${err.message}`);
                    });
                }
            }
        } catch (err) {
            log.error(`Error evaluating cron: ${err.message}`);
        }
    }

    #evaluateTimers() {
        if (this.isPaused) return;
        try {
            this.#manager.reloadIfChanged();
            const expired = this.#manager.getExpiredTimers();

            for (const instruction of expired) {
                if (this.#isInCooldown(instruction)) continue;
                log.info(`Timer expired: "${instruction.description}" (${instruction.id})`);
                this.#gateAndExecute(instruction, {
                    trigger_type: "timer",
                    fire_at: instruction.trigger.fire_at,
                }).catch(err => {
                    log.error(`Error executing timer "${instruction.description}": ${err.message}`);
                });
            }
        } catch (err) {
            log.error(`Error evaluating timers: ${err.message}`);
        }
    }

    async #gateAndExecute(instruction, context) {
        // Prevent concurrent gate evaluations for the same instruction
        // (guards against one-shot firing twice on rapid triggers)
        if (this.#gatingInProgress.has(instruction.id)) {
            log.debug(`Skipping "${instruction.description}" (${instruction.id}) — gate already in progress`);
            return;
        }
        this.#gatingInProgress.add(instruction.id);

        try {
            // Evaluate conditions (if any) before executing actions
            if (instruction.conditions && instruction.conditions.length > 0) {
                try {
                    const pass = await this.#evaluateConditions(instruction.conditions);
                    if (!pass) {
                        log.info(`Conditions not met: "${instruction.description}" (${instruction.id})`);
                        return;
                    }
                } catch (err) {
                    log.warn(`Condition evaluation failed for "${instruction.description}": ${err.message} — skipping action (fail-closed)`);
                    return;
                }
            }

            // Mark triggered AFTER conditions pass — ensures one-shot/max_triggers/cooldown
            // only consume when the action actually runs.
            this.#manager.markTriggered(instruction.id);
            this.#triggerCount++;

            this.#processChain(instruction);
            await this.#executeActions(instruction, context);
        } finally {
            this.#gatingInProgress.delete(instruction.id);
        }
    }

    async #executeActions(instruction, context) {
        const actions = instruction.action; // always an array
        const contextSummary = this.#formatContext(context);
        const mode = instruction.action_mode || "sequential";

        if (mode === "parallel") {
            const results = await Promise.allSettled(
                actions.map(action => this.#executeSingleAction(action, instruction, contextSummary))
            );
            const failures = results.filter(r => r.status === "rejected");
            for (const f of failures) {
                log.error(`Action failed (parallel): ${f.reason?.message || f.reason}`);
            }
            if (failures.length > 0 && !instruction.continue_on_error) {
                log.info(`${failures.length}/${actions.length} actions failed for "${instruction.description}" (continue_on_error=false)`);
            }
        } else {
            for (const action of actions) {
                try {
                    await this.#executeSingleAction(action, instruction, contextSummary);
                } catch (err) {
                    log.error(`Action ${action.type} failed: ${err.message}`);
                    if (!instruction.continue_on_error) {
                        log.info(`Stopping action sequence for "${instruction.description}" (continue_on_error=false)`);
                        break;
                    }
                }
            }
        }
    }

    async #executeSingleAction(action, instruction, contextSummary) {
        switch (action.type) {
        case "wake_agent": {
            const prompt = `[Standing Instruction Triggered]\n` +
                `Instruction: "${instruction.description}"\n` +
                `Trigger: ${contextSummary}\n` +
                `Agent prompt: ${action.prompt}`;
            if (this.#ownerChatId) {
                const isBusy = this.#bridge.promptActive;
                const statusMsg = isBusy
                    ? `🔔 ${instruction.description}\n⏳ Queued — will process after current task`
                    : `🔔 ${instruction.description}\n⏳ Processing...`;
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(this.#ownerChatId, statusMsg)
                ).catch(err => {
                    log.warn(`Failed to send wake notification: ${err.message}`);
                });
            }
            // Fire-and-forget — don't await agent completion
            this.#bridge.injectSystemPrompt(prompt, this.#ownerChatId).catch(err => {
                log.error(`Failed to wake agent: ${err.message}`);
            });
            return;
        }
        case "notify": {
            const message = `🔔 Standing Instruction\n` +
                `${instruction.description}\n\n` +
                `${action.message}\n\n` +
                `Trigger: ${contextSummary}`;
            if (this.#ownerChatId) {
                await this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(this.#ownerChatId, message)
                );
            }
            return;
        }
        case "ha_service": {
            const { domain, service, data, message } = action;

            if (!HA_SERVICE_ALLOWED_DOMAINS.has(domain)) {
                const errMsg = `domain "${domain}" not in allowlist`;
                log.warn(`Blocked ha_service: ${errMsg}`);
                if (this.#ownerChatId) {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(this.#ownerChatId, `⛔ ${instruction.description}\nBlocked: ${errMsg}. Use wake_agent instead.`)
                    ).catch(() => {});
                }
                throw new Error(`Blocked ha_service: ${errMsg}`);
            }

            const url = `${this.#haBaseUrl}/services/${domain}/${service}`;
            log.info(`Calling HA service: ${domain}.${service}`);

            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.#haToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(data || {}),
                signal: AbortSignal.timeout(HA_SERVICE_TIMEOUT_MS),
            });

            if (!res.ok) {
                const errMsg = `HTTP ${res.status} ${res.statusText}`;
                log.error(`HA service ${domain}.${service} failed: ${errMsg}`);
                if (this.#ownerChatId) {
                    this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(this.#ownerChatId, `❌ ${instruction.description}\nService call failed: ${errMsg}`)
                    ).catch(() => {});
                }
                throw new Error(errMsg);
            }

            log.info(`HA service ${domain}.${service} called successfully`);
            if (this.#ownerChatId && message) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(this.#ownerChatId, `🔔 ${instruction.description}\n${message}`)
                ).catch(err => {
                    log.warn(`Failed to send ha_service notification: ${err.message}`);
                });
            }
            return;
        }
        default:
            log.error(`Unknown action type: ${action.type}`);
        }
    }

    // ── Condition evaluation ──────────────────────────────────

    async #evaluateConditions(conditions) {
        // Top level is implicit AND
        for (const condition of conditions) {
            if (!await this.#evaluateCondition(condition)) return false;
        }
        return true;
    }

    async #evaluateCondition(condition) {
        switch (condition.type) {
        case "state": {
            const entity = await this.#fetchEntityState(condition.entity_id);
            if (!entity) return false;
            return entity.state === condition.state;
        }
        case "numeric_state": {
            const entity = await this.#fetchEntityState(condition.entity_id);
            if (!entity) return false;
            const val = parseFloat(entity.state);
            if (!Number.isFinite(val)) return false;
            if (condition.above !== null && val <= condition.above) return false;
            if (condition.below !== null && val >= condition.below) return false;
            return true;
        }
        case "time": {
            const now = new Date();
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const afterMinutes = condition.after !== null ? this.#parseTimeToMinutes(condition.after) : null;
            const beforeMinutes = condition.before !== null ? this.#parseTimeToMinutes(condition.before) : null;

            if (afterMinutes !== null && beforeMinutes !== null && afterMinutes > beforeMinutes) {
                // Midnight-crossing range (e.g. after:23:00, before:02:00)
                // True if now >= after OR now < before
                return nowMinutes >= afterMinutes || nowMinutes < beforeMinutes;
            }
            // Normal range (e.g. after:08:00, before:18:00)
            if (afterMinutes !== null && nowMinutes < afterMinutes) return false;
            if (beforeMinutes !== null && nowMinutes >= beforeMinutes) return false;
            return true;
        }
        case "and":
            for (const c of condition.conditions) {
                if (!await this.#evaluateCondition(c)) return false;
            }
            return true;
        case "or":
            for (const c of condition.conditions) {
                if (await this.#evaluateCondition(c)) return true;
            }
            return false;
        case "not":
            return !await this.#evaluateCondition(condition.conditions[0]);
        default:
            log.warn(`Unknown condition type: ${condition.type}`);
            return false;
        }
    }

    #parseTimeToMinutes(timeStr) {
        const [h, m] = timeStr.split(":").map(Number);
        return h * 60 + m;
    }

    async #fetchEntityState(entityId) {
        try {
            const url = `${this.#haBaseUrl}/states/${entityId}`;
            const res = await fetch(url, {
                headers: { "Authorization": `Bearer ${this.#haToken}` },
                signal: AbortSignal.timeout(HA_STATE_FETCH_TIMEOUT_MS),
            });
            if (!res.ok) {
                log.warn(`Failed to fetch state for ${entityId}: HTTP ${res.status}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            log.warn(`Failed to fetch state for ${entityId}: ${err.message}`);
            return null;
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

    #processChain(instruction) {
        if (!instruction.chain_enable || !Array.isArray(instruction.chain_enable)) return;
        for (const targetId of instruction.chain_enable) {
            const result = this.#manager.enable(targetId);
            if (result) {
                log.info(`Chain: enabled "${result.description}" (${targetId})`);
            } else {
                log.warn(`Chain: failed to enable ${targetId} (not found)`);
            }
        }
    }

    #startFileWatcher() {
        try {
            const path = this.#manager.persistPath;
            if (!path) return;
            this.#fileWatcher = watch(path, { persistent: false }, (eventType) => {
                if (eventType === "change" || eventType === "rename") {
                    // Re-establish watcher after atomic rename (inotify watches inodes, not paths)
                    this.#stopFileWatcher();
                    const reloaded = this.#manager.reloadIfChanged();
                    if (reloaded) {
                        log.info("Instant reload triggered by file change");
                    }
                    // Re-create watcher on the new inode
                    setTimeout(() => {
                        if (this.#started) this.#startFileWatcher();
                    }, 100);
                }
            });
            this.#fileWatcher.on("error", (err) => {
                log.warn(`File watcher error: ${err.message}`);
            });
            log.info("File watcher started for instant reload");
        } catch (err) {
            log.warn(`Failed to start file watcher: ${err.message}`);
        }
    }

    #stopFileWatcher() {
        if (this.#fileWatcher) {
            this.#fileWatcher.close();
            this.#fileWatcher = null;
        }
    }
}
