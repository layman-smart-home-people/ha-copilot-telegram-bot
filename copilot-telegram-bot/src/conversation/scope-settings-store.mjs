import { readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("scope-settings");
const DEFAULT_PATH = "/data/scope-settings.json";

export class ScopeSettingsStore {
    #path;
    #cache = new Map(); // scopeKey -> { model }

    constructor(path = DEFAULT_PATH) {
        this.#path = path;
        this.#load();
    }

    get(scopeKey) {
        return this.#cache.get(scopeKey) || null;
    }

    getModel(scopeKey) {
        return this.get(scopeKey)?.model || null;
    }

    setModel(scopeKey, model) {
        if (!scopeKey || !model) return;
        const next = { ...(this.#cache.get(scopeKey) || {}), model };
        this.#cache.set(scopeKey, next);
        this.#save();
    }

    clearModel(scopeKey) {
        if (!scopeKey) return;
        const current = this.#cache.get(scopeKey);
        if (!current) return;
        const next = { ...current };
        delete next.model;
        if (Object.keys(next).length === 0) {
            this.#cache.delete(scopeKey);
        } else {
            this.#cache.set(scopeKey, next);
        }
        this.#save();
    }

    #load() {
        try {
            const raw = readFileSync(this.#path, "utf8");
            const data = JSON.parse(raw);
            if (!data || typeof data !== "object" || Array.isArray(data)) return;
            for (const [scopeKey, value] of Object.entries(data)) {
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    this.#cache.set(scopeKey, value);
                }
            }
            log.info(`Loaded ${this.#cache.size} scope setting entries`);
        } catch (err) {
            if (err.code !== "ENOENT") {
                log.warn(`Failed to read scope settings: ${err.message}`);
            }
        }
    }

    #save() {
        try {
            writeFileSync(this.#path, JSON.stringify(Object.fromEntries(this.#cache), null, 2) + "\n", "utf8");
        } catch (err) {
            log.warn(`Failed to write scope settings: ${err.message}`);
        }
    }
}
