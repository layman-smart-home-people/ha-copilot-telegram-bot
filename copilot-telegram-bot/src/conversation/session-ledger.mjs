// ============================================================
// SessionLedger — append-only session ID persistence
// ============================================================
// Stores scopeKey → sessionId mappings so conversations can
// resume after idle reap or bot restart via loadSession().
//
// Format: NDJSON (one JSON object per line)
// Compaction: when file exceeds MAX_BYTES, rewrite keeping only
// the latest entry per scope.

import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("session-ledger");
const DEFAULT_PATH = "/data/session-ledger.jsonl";
const MAX_BYTES = 32 * 1024; // 32 KB

export class SessionLedger {
    #path;
    #cache = new Map(); // scopeKey → sessionId (in-memory for fast lookups)

    constructor(path = DEFAULT_PATH) {
        this.#path = path;
        this.#loadFromDisk();
    }

    /** Record a sessionId for a scope. Appends to file. */
    record(scopeKey, sessionId) {
        if (!scopeKey || !sessionId) return;
        this.#cache.set(scopeKey, sessionId);
        try {
            const line = JSON.stringify({ s: scopeKey, id: sessionId, t: Date.now() }) + "\n";
            appendFileSync(this.#path, line, "utf8");
            this.#maybeCompact();
        } catch (err) {
            log.warn(`Failed to write ledger: ${err.message}`);
        }
    }

    /** Get the last known sessionId for a scope. */
    get(scopeKey) {
        return this.#cache.get(scopeKey) || null;
    }

    /** Clear a scope's session (e.g., user says /new). */
    clear(scopeKey) {
        this.#cache.delete(scopeKey);
        try {
            const line = JSON.stringify({ s: scopeKey, id: null, t: Date.now() }) + "\n";
            appendFileSync(this.#path, line, "utf8");
        } catch {}
    }

    /** Number of scopes tracked. */
    get size() {
        return this.#cache.size;
    }

    // ── Private ──────────────────────────────────────────────

    #loadFromDisk() {
        try {
            const data = readFileSync(this.#path, "utf8");
            for (const line of data.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.s && entry.id) {
                        this.#cache.set(entry.s, entry.id);
                    } else if (entry.s && entry.id === null) {
                        this.#cache.delete(entry.s);
                    }
                } catch {
                    // Skip malformed lines
                }
            }
            log.info(`Loaded ${this.#cache.size} session mappings from ledger`);
        } catch (err) {
            if (err.code !== "ENOENT") {
                log.warn(`Failed to read ledger: ${err.message}`);
            }
            // File doesn't exist yet — that's fine
        }
    }

    #maybeCompact() {
        try {
            const stat = statSync(this.#path);
            if (stat.size <= MAX_BYTES) return;

            // Rewrite with only the latest entry per scope
            const lines = [];
            for (const [scopeKey, sessionId] of this.#cache) {
                lines.push(JSON.stringify({ s: scopeKey, id: sessionId, t: Date.now() }));
            }
            writeFileSync(this.#path, lines.join("\n") + "\n", "utf8");
            log.info(`Compacted ledger: ${lines.length} scopes, ${stat.size} → ${lines.join("\n").length + 1} bytes`);
        } catch (err) {
            log.warn(`Ledger compaction failed: ${err.message}`);
        }
    }
}
