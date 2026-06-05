import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PERSIST_PATH = "/data/standing_instructions.json";
const DEFAULT_COOLDOWN_SECONDS = 300;
const VALID_TRIGGER_TYPES = new Set(["state_change", "cron", "timer"]);
const VALID_ACTION_TYPES = new Set(["wake_agent", "notify", "ha_service"]);

export class StandingInstructionManager {
    #persistPath;
    #log;
    #instructions = [];
    #lastKnownMtimeMs = 0;

    constructor({ persistPath = DEFAULT_PERSIST_PATH, log } = {}) {
        this.#persistPath = persistPath;
        this.#log = typeof log === "function" ? log : () => {};
        this.#load();
    }

    create(spec) {
        const instruction = this.#normalizeInstruction(spec, { existing: false });
        this.#instructions.push(instruction);
        this.#save();
        return this.#clone(instruction);
    }

    list() {
        return this.#clone(this.#instructions);
    }

    get persistPath() {
        return this.#persistPath;
    }

    /** Re-read from disk if the file was modified externally (e.g. by the agent). */
    reloadIfChanged() {
        try {
            if (!existsSync(this.#persistPath)) return false;
            const mtime = statSync(this.#persistPath).mtimeMs;
            if (mtime <= this.#lastKnownMtimeMs) return false;
            this.#load();
            this.#log(`[STANDING] Hot-reloaded instructions from disk (${this.#instructions.length} total)`);
            return true;
        } catch (err) {
            this.#log(`[STANDING] Reload check failed: ${err.message}`);
            return false;
        }
    }

    get(id) {
        const instruction = this.#findById(id);
        return instruction ? this.#clone(instruction) : null;
    }

    update(id, changes = {}) {
        const index = this.#findIndexById(id);
        if (index === -1) return null;
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
            throw new Error("Instruction changes must be an object.");
        }

        const current = this.#instructions[index];
        const merged = {
            ...current,
            ...changes,
            trigger: Object.hasOwn(changes, "trigger") ? this.#mergeSection(current.trigger, changes.trigger, "trigger") : current.trigger,
            action: Object.hasOwn(changes, "action") ? this.#mergeSection(current.action, changes.action, "action") : current.action,
            id: current.id,
            created_at: current.created_at,
        };

        const updated = this.#normalizeInstruction(merged, { existing: true });
        this.#instructions[index] = updated;
        this.#save();
        return this.#clone(updated);
    }

    delete(id) {
        const index = this.#findIndexById(id);
        if (index === -1) return false;
        this.#instructions.splice(index, 1);
        this.#save();
        return true;
    }

    enable(id) {
        return this.update(id, { enabled: true });
    }

    disable(id) {
        return this.update(id, { enabled: false });
    }

    matchStateChange(entity_id, newState, oldState, attributes = null) {
        return this.#instructions
            .filter(instruction => this.#matchesStateChange(instruction, entity_id, newState, oldState, attributes))
            .map(instruction => this.#clone(instruction));
    }

    getCronInstructions() {
        return this.#instructions
            .filter(instruction => instruction.enabled && !this.#isExpired(instruction) && !this.#isExhausted(instruction) && instruction.trigger.type === "cron")
            .map(instruction => this.#clone(instruction));
    }

    getTimerInstructions() {
        return this.#instructions
            .filter(instruction => instruction.enabled && !this.#isExpired(instruction) && !this.#isExhausted(instruction) && instruction.trigger.type === "timer" && !instruction.last_triggered_at)
            .map(instruction => this.#clone(instruction));
    }

    markTriggered(id) {
        const index = this.#findIndexById(id);
        if (index === -1) return null;

        const updated = {
            ...this.#instructions[index],
            last_triggered_at: new Date().toISOString(),
            trigger_count: (this.#instructions[index].trigger_count || 0) + 1,
        };
        if (updated.one_shot) updated.enabled = false;
        if (updated.max_triggers !== null && updated.trigger_count >= updated.max_triggers) {
            updated.enabled = false;
        }

        this.#instructions[index] = updated;
        this.#save();
        return this.#clone(updated);
    }

    cronMatches(expression, date = new Date()) {
        const when = this.#coerceDate(date, "Cron date must be a valid Date or date string.");
        const cron = this.#parseCronExpression(expression);
        return cron.minute.has(when.getMinutes())
            && cron.hour.has(when.getHours())
            && cron.dayOfMonth.has(when.getDate())
            && cron.month.has(when.getMonth() + 1)
            && cron.dayOfWeek.has(when.getDay());
    }

    getNextTimer() {
        const now = Date.now();
        let next = null;

        for (const instruction of this.#instructions) {
            if (!instruction.enabled || this.#isExpired(instruction) || this.#isExhausted(instruction) || instruction.trigger.type !== "timer" || instruction.last_triggered_at) continue;
            const fireAt = Date.parse(instruction.trigger.fire_at);
            if (!Number.isFinite(fireAt) || fireAt <= now) continue;
            if (!next || fireAt < Date.parse(next.trigger.fire_at)) next = instruction;
        }

        return next ? this.#clone(next) : null;
    }

    getExpiredTimers(now = new Date()) {
        const nowTime = this.#coerceDate(now, "Timer comparison time must be a valid Date or date string.").getTime();
        return this.#instructions
            .filter(instruction => {
                if (!instruction.enabled || this.#isExpired(instruction) || this.#isExhausted(instruction) || instruction.trigger.type !== "timer" || instruction.last_triggered_at) return false;
                return Date.parse(instruction.trigger.fire_at) <= nowTime;
            })
            .map(instruction => this.#clone(instruction));
    }

    #findById(id) {
        return this.#instructions.find(instruction => instruction.id === id) || null;
    }

    #findIndexById(id) {
        return this.#instructions.findIndex(instruction => instruction.id === id);
    }

    #mergeSection(current, patch, name) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            throw new Error(`Instruction ${name} changes must be an object.`);
        }
        return { ...current, ...patch };
    }

    #matchesStateChange(instruction, entity_id, newState, oldState, attributes) {
        if (!instruction.enabled) return false;
        if (this.#isExpired(instruction)) return false;
        if (this.#isExhausted(instruction)) return false;
        if (instruction.trigger.type !== "state_change") return false;
        if (!this.#triggerWatchesEntity(instruction.trigger.entity_id, entity_id)) return false;
        if (this.#isInCooldown(instruction)) return false;

        const observed = this.#getObservedValues(instruction.trigger.attribute, newState, oldState, attributes);
        if (!this.#matchesExpectedValue(instruction.trigger.from, observed.oldValue)) return false;
        if (!this.#matchesExpectedValue(instruction.trigger.to, observed.newValue)) return false;

        const numericValue = Number(observed.newValue);
        if (instruction.trigger.above !== null && (!Number.isFinite(numericValue) || numericValue <= instruction.trigger.above)) return false;
        if (instruction.trigger.below !== null && (!Number.isFinite(numericValue) || numericValue >= instruction.trigger.below)) return false;

        return true;
    }

    #triggerWatchesEntity(watched, entity_id) {
        return Array.isArray(watched) ? watched.includes(entity_id) : watched === entity_id;
    }

    #getObservedValues(attribute, newState, oldState, attributes) {
        if (!attribute) {
            return { newValue: newState, oldValue: oldState };
        }

        const source = attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes : {};
        const nextAttributes = source.new ?? source.current ?? source.attributes ?? source;
        const previousAttributes = source.old ?? source.previous ?? null;

        return {
            newValue: nextAttributes && typeof nextAttributes === "object" ? nextAttributes[attribute] : null,
            oldValue: previousAttributes && typeof previousAttributes === "object" ? previousAttributes[attribute] : null,
        };
    }

    #matchesExpectedValue(expected, actual) {
        if (expected === null) return true;
        return expected === this.#normalizeComparableValue(actual);
    }

    #normalizeComparableValue(value) {
        return value == null ? null : String(value);
    }

    #isExpired(instruction) {
        if (!instruction.expires_at) return false;
        return Date.now() >= Date.parse(instruction.expires_at);
    }

    #isExhausted(instruction) {
        if (instruction.max_triggers === null) return false;
        return (instruction.trigger_count || 0) >= instruction.max_triggers;
    }

    #isInCooldown(instruction) {
        if (!instruction.last_triggered_at) return false;
        const cooldownMs = instruction.cooldown_seconds * 1000;
        return Date.now() - Date.parse(instruction.last_triggered_at) < cooldownMs;
    }

    #normalizeInstruction(spec, { existing }) {
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
            throw new Error("Instruction spec must be an object.");
        }

        return {
            id: existing ? this.#requireString(spec.id, "Instruction id is required.") : randomUUID(),
            description: this.#requireString(spec.description, "Instruction description is required."),
            enabled: this.#normalizeBoolean(spec.enabled, true, "Instruction enabled must be a boolean."),
            trigger: this.#normalizeTrigger(spec.trigger),
            action: this.#normalizeAction(spec.action),
            cooldown_seconds: this.#normalizeCooldown(spec.cooldown_seconds),
            one_shot: this.#normalizeBoolean(spec.one_shot, false, "Instruction one_shot must be a boolean."),
            expires_at: this.#normalizeNullableIsoTimestamp(
                spec.expires_at,
                "Instruction expires_at must be null or a valid ISO timestamp.",
            ),
            created_at: existing
                ? this.#normalizeIsoTimestamp(spec.created_at, "Instruction created_at must be a valid ISO timestamp.")
                : new Date().toISOString(),
            last_triggered_at: this.#normalizeNullableIsoTimestamp(
                spec.last_triggered_at,
                "Instruction last_triggered_at must be null or a valid ISO timestamp.",
            ),
            trigger_count: this.#normalizeNonNegativeInt(spec.trigger_count, 0, "Instruction trigger_count must be a non-negative integer."),
            max_triggers: this.#normalizeOptionalPositiveInt(spec.max_triggers, "Instruction max_triggers must be a positive integer or null."),
            notes: this.#normalizeNullableString(spec.notes, "Instruction notes must be a string or null."),
            chain_enable: this.#normalizeOptionalStringArray(spec.chain_enable, "Instruction chain_enable must be an array of instruction ID strings or null."),
        };
    }

    #normalizeTrigger(trigger) {
        if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
            throw new Error("Instruction trigger must be an object.");
        }
        if (!VALID_TRIGGER_TYPES.has(trigger.type)) {
            throw new Error(`Instruction trigger.type must be one of: ${Array.from(VALID_TRIGGER_TYPES).join(", ")}.`);
        }

        switch (trigger.type) {
            case "state_change":
                return {
                    type: "state_change",
                    entity_id: this.#normalizeEntityIds(trigger.entity_id),
                    to: this.#normalizeOptionalComparable(trigger.to, "State-change trigger.to must be a string or null."),
                    from: this.#normalizeOptionalComparable(trigger.from, "State-change trigger.from must be a string or null."),
                    above: this.#normalizeOptionalNumber(trigger.above, "State-change trigger.above must be a number or null."),
                    below: this.#normalizeOptionalNumber(trigger.below, "State-change trigger.below must be a number or null."),
                    attribute: this.#normalizeNullableString(
                        trigger.attribute,
                        "State-change trigger.attribute must be a string or null.",
                    ),
                };
            case "cron":
                return {
                    type: "cron",
                    expression: this.#normalizeCronExpression(trigger.expression),
                };
            case "timer":
                return {
                    type: "timer",
                    fire_at: this.#normalizeIsoTimestamp(trigger.fire_at, "Timer trigger.fire_at must be a valid ISO timestamp."),
                };
            default:
                throw new Error(`Unsupported trigger type: ${trigger.type}.`);
        }
    }

    #normalizeAction(action) {
        if (!action || typeof action !== "object" || Array.isArray(action)) {
            throw new Error("Instruction action must be an object.");
        }
        if (!VALID_ACTION_TYPES.has(action.type)) {
            throw new Error(`Instruction action.type must be one of: ${Array.from(VALID_ACTION_TYPES).join(", ")}.`);
        }

        switch (action.type) {
            case "wake_agent":
                return {
                    type: "wake_agent",
                    prompt: this.#requireString(action.prompt, "Wake-agent action.prompt is required."),
                };
            case "notify":
                return {
                    type: "notify",
                    message: this.#requireString(action.message, "Notify action.message is required."),
                };
            case "ha_service":
                return {
                    type: "ha_service",
                    domain: this.#requireHaIdentifier(action.domain, "ha_service action.domain"),
                    service: this.#requireHaIdentifier(action.service, "ha_service action.service"),
                    data: action.data != null && typeof action.data === "object" && !Array.isArray(action.data) ? action.data : {},
                    message: action.message != null ? this.#requireString(action.message, "ha_service action.message must be a string.") : null,
                };
            default:
                throw new Error(`Unsupported action type: ${action.type}.`);
        }
    }

    #normalizeEntityIds(entityId) {
        if (typeof entityId === "string") {
            return this.#requireString(entityId, "State-change trigger.entity_id is required.");
        }
        if (Array.isArray(entityId)) {
            if (entityId.length === 0) {
                throw new Error("State-change trigger.entity_id must not be an empty array.");
            }
            return entityId.map(value => this.#requireString(value, "State-change trigger.entity_id entries must be strings."));
        }
        throw new Error("State-change trigger.entity_id must be a string or array of strings.");
    }

    #normalizeCronExpression(expression) {
        const value = this.#requireString(expression, "Cron trigger.expression is required.");
        this.#parseCronExpression(value);
        return value;
    }

    #normalizeCooldown(value) {
        if (value == null) return DEFAULT_COOLDOWN_SECONDS;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error("Instruction cooldown_seconds must be a non-negative number.");
        }
        return Math.trunc(parsed);
    }

    #normalizeBoolean(value, defaultValue, errorMessage) {
        if (value == null) return defaultValue;
        if (typeof value !== "boolean") throw new Error(errorMessage);
        return value;
    }

    #normalizeOptionalComparable(value, errorMessage) {
        if (value == null) return null;
        if (typeof value !== "string") throw new Error(errorMessage);
        return value;
    }

    #normalizeOptionalNumber(value, errorMessage) {
        if (value == null) return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(errorMessage);
        return parsed;
    }

    #normalizeNonNegativeInt(value, defaultValue, errorMessage) {
        if (value == null) return defaultValue;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(errorMessage);
        return parsed;
    }

    #normalizeOptionalPositiveInt(value, errorMessage) {
        if (value == null) return null;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error(errorMessage);
        return parsed;
    }

    #normalizeNullableString(value, errorMessage) {
        if (value == null) return null;
        return this.#requireString(value, errorMessage);
    }

    #normalizeOptionalStringArray(value, errorMessage) {
        if (value == null) return null;
        if (!Array.isArray(value)) throw new Error(errorMessage);
        return value.map(v => this.#requireString(v, errorMessage));
    }

    #normalizeNullableIsoTimestamp(value, errorMessage) {
        if (value == null) return null;
        return this.#normalizeIsoTimestamp(value, errorMessage);
    }

    #normalizeIsoTimestamp(value, errorMessage) {
        const stringValue = this.#requireString(value, errorMessage);
        const parsed = Date.parse(stringValue);
        if (!Number.isFinite(parsed)) throw new Error(errorMessage);
        return new Date(parsed).toISOString();
    }

    #requireString(value, errorMessage) {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(errorMessage);
        }
        return value.trim();
    }

    #requireHaIdentifier(value, label) {
        const str = this.#requireString(value, `${label} is required.`);
        if (!/^[a-z_][a-z0-9_]*$/.test(str)) {
            throw new Error(`${label} must be a valid HA identifier (lowercase letters, digits, underscores).`);
        }
        return str;
    }

    #coerceDate(value, errorMessage) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error(errorMessage);
        return date;
    }

    #parseCronExpression(expression) {
        const parts = this.#requireString(expression, "Cron trigger.expression is required.").split(/\s+/);
        if (parts.length !== 5) {
            throw new Error("Cron expression must have 5 fields: minute hour day-of-month month day-of-week.");
        }

        return {
            minute: this.#expandCronField(parts[0], 0, 59, "minute"),
            hour: this.#expandCronField(parts[1], 0, 23, "hour"),
            dayOfMonth: this.#expandCronField(parts[2], 1, 31, "day-of-month"),
            month: this.#expandCronField(parts[3], 1, 12, "month"),
            dayOfWeek: this.#expandCronField(parts[4], 0, 6, "day-of-week"),
        };
    }

    #expandCronField(field, min, max, name) {
        const values = new Set();
        for (const rawPart of field.split(",")) {
            const part = rawPart.trim();
            if (!part) throw new Error(`Cron ${name} field contains an empty segment.`);

            if (part === "*") {
                for (let value = min; value <= max; value += 1) values.add(value);
                continue;
            }

            if (part.startsWith("*/")) {
                const step = this.#parseCronNumber(part.slice(2), 1, max - min + 1, `${name} step`);
                for (let value = min; value <= max; value += step) values.add(value);
                continue;
            }

            if (part.includes("-")) {
                const [startText, endText] = part.split("-");
                if (!startText || !endText || part.split("-").length !== 2) {
                    throw new Error(`Cron ${name} field has an invalid range: ${part}.`);
                }
                const start = this.#parseCronNumber(startText, min, max, `${name} range start`);
                const end = this.#parseCronNumber(endText, min, max, `${name} range end`);
                if (start > end) throw new Error(`Cron ${name} field range must be ascending: ${part}.`);
                for (let value = start; value <= end; value += 1) values.add(value);
                continue;
            }

            values.add(this.#parseCronNumber(part, min, max, name));
        }
        return values;
    }

    #parseCronNumber(value, min, max, name) {
        if (!/^\d+$/.test(value)) {
            throw new Error(`Cron ${name} field must use numbers, *, */N, N-M, or N,M.`);
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`Cron ${name} field must be between ${min} and ${max}.`);
        }
        return parsed;
    }

    #load() {
        if (!existsSync(this.#persistPath)) return;

        try {
            const raw = JSON.parse(readFileSync(this.#persistPath, "utf-8"));
            const persisted = Array.isArray(raw) ? raw : raw.instructions;
            if (!Array.isArray(persisted)) {
                throw new Error("Persistence file must contain an instructions array.");
            }

            const loaded = [];
            for (const entry of persisted) {
                try {
                    loaded.push(this.#normalizeInstruction(entry, { existing: true }));
                } catch (error) {
                    this.#log(`[STANDING] Skipping invalid instruction: ${error.message}`);
                }
            }
            this.#instructions = loaded;
            this.#lastKnownMtimeMs = statSync(this.#persistPath).mtimeMs;
        } catch (error) {
            this.#log(`[STANDING] Failed to load ${this.#persistPath}: ${error.message}`);
            this.#instructions = [];
        }
    }

    #save() {
        const payload = {
            version: 1,
            instructions: this.#instructions,
        };
        const tmpPath = `${this.#persistPath}.tmp`;

        try {
            mkdirSync(dirname(this.#persistPath), { recursive: true });
            writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
            renameSync(tmpPath, this.#persistPath);
            this.#lastKnownMtimeMs = statSync(this.#persistPath).mtimeMs;
        } catch (error) {
            this.#log(`[STANDING] Failed to save ${this.#persistPath}: ${error.message}`);
        }
    }

    #clone(value) {
        return structuredClone(value);
    }
}
