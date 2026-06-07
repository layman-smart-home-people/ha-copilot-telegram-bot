// ============================================================
// PkmStore — SQLite database for Personal Knowledge Management
// ============================================================
// Zero external dependencies — uses Node.js 22+ built-in SQLite.
// Handles schema creation, migrations, CRUD, FTS5 search,
// secure deletion, rate limiting, and MEMORY.md bootstrap.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("pkm-store");

// ── Constants ──────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const DEFAULT_LIMITS = {
    maxNotesPerUser: 10_000,
    warnNotesPerUser: 8_000,
    maxNotesPerWindow: 5,
    maxSearchesPerMinute: 20,
    maxDbSizeMb: 500,
    maxOpenWindows: 100,
};

// ── Schema SQL ─────────────────────────────────────────────

const SCHEMA_SQL = `
-- Version tracking
CREATE TABLE IF NOT EXISTS pkm_schema (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Notes (core memory storage)
CREATE TABLE IF NOT EXISTS notes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    chat_id         TEXT,
    type            TEXT NOT NULL DEFAULT 'fact',
    title           TEXT,
    content         TEXT NOT NULL,
    search_keywords TEXT,
    tags            TEXT,
    metadata        TEXT,
    valid_from      TEXT NOT NULL,
    valid_to        TEXT,
    superseded_by   TEXT,
    source_type     TEXT DEFAULT 'extracted',
    confidence      REAL DEFAULT 0.8,
    durability      TEXT DEFAULT 'normal',
    importance      REAL DEFAULT 0.5,
    scope           TEXT DEFAULT 'user',
    scope_id        TEXT,
    evidence_msg_ids TEXT,
    conversation_id  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope, user_id, valid_to);
CREATE INDEX IF NOT EXISTS idx_notes_user_type ON notes(user_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(user_id, created_at DESC);

-- FTS5 full-text search index (content-sync with notes table)
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, search_keywords, tags,
    content=notes, content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 2'
);

-- Triggers for FTS5 content-sync
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content, search_keywords, tags)
    VALUES (new.rowid, new.title, new.content, new.search_keywords, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_delete BEFORE DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, search_keywords, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.search_keywords, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, search_keywords, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.search_keywords, old.tags);
    INSERT INTO notes_fts(rowid, title, content, search_keywords, tags)
    VALUES (new.rowid, new.title, new.content, new.search_keywords, new.tags);
END;

-- Note links (bidirectional relationships)
CREATE TABLE IF NOT EXISTS note_links (
    source_id  TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    relation   TEXT DEFAULT 'related',
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
);

-- Named entities (people, places, companies)
CREATE TABLE IF NOT EXISTS entities (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    type       TEXT,
    aliases    TEXT,
    summary    TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_notes (
    entity_id TEXT NOT NULL,
    note_id   TEXT NOT NULL,
    PRIMARY KEY (entity_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id, name);

-- Structured data (health metrics, quantified self)
CREATE TABLE IF NOT EXISTS structured_data (
    id          TEXT PRIMARY KEY,
    note_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    data_type   TEXT NOT NULL,
    value       REAL,
    value_text  TEXT,
    unit        TEXT,
    measured_at TEXT NOT NULL,
    metadata    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sd_query ON structured_data(user_id, data_type, measured_at);

-- Conversation windows (extraction tracking)
CREATE TABLE IF NOT EXISTS conversation_windows (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    chat_id         TEXT,
    messages        TEXT,
    message_count   INTEGER DEFAULT 0,
    started_at      TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    closed_at       TEXT,
    extracted       INTEGER DEFAULT 0,
    retry_count     INTEGER DEFAULT 0,
    note_ids        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cw_pending ON conversation_windows(user_id, extracted, last_message_at);

-- Households (shared memory groups)
CREATE TABLE IF NOT EXISTS households (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS household_members (
    household_id TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    role         TEXT DEFAULT 'member',
    joined_at    TEXT NOT NULL,
    PRIMARY KEY (household_id, user_id)
);

-- Per-user settings
CREATE TABLE IF NOT EXISTS pkm_settings (
    user_id               TEXT PRIMARY KEY,
    enabled               INTEGER DEFAULT 0,
    household_id          TEXT,
    window_minutes        INTEGER DEFAULT 30,
    max_window_messages   INTEGER DEFAULT 30,
    max_window_hours      INTEGER DEFAULT 4,
    enrichment_enabled    INTEGER DEFAULT 1,
    notifications_enabled INTEGER DEFAULT 0,
    category_counts       TEXT,
    extraction_stats      TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

-- Audit log
CREATE TABLE IF NOT EXISTS memory_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id    TEXT,
    user_id    TEXT NOT NULL,
    event      TEXT NOT NULL,
    details    TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON memory_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_cleanup ON memory_events(created_at);
`;

// ── PkmStore class ─────────────────────────────────────────

export class PkmStore {
    #db;
    #dbPath;
    #limits;

    constructor(dbPath, limits = {}) {
        this.#dbPath = dbPath;
        this.#limits = { ...DEFAULT_LIMITS, ...limits };
    }

    // ── Lifecycle ──────────────────────────────────────────

    open() {
        log.info(`Opening PKM database: ${this.#dbPath}`);
        this.#db = new DatabaseSync(this.#dbPath);

        // Security pragmas
        this.#db.exec("PRAGMA journal_mode = WAL");
        this.#db.exec("PRAGMA secure_delete = 1");
        this.#db.exec("PRAGMA foreign_keys = ON");
        this.#db.exec("PRAGMA busy_timeout = 5000");

        // Create schema
        this.#db.exec(SCHEMA_SQL);

        // Enable FTS5 secure-delete
        try {
            this.#db.exec("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1)");
        } catch {
            // Already set or unsupported — non-fatal
        }

        // Track schema version
        const existing = this.#db.prepare("SELECT value FROM pkm_schema WHERE key = 'version'").get();
        if (!existing) {
            this.#db.prepare("INSERT INTO pkm_schema (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
            log.info(`PKM schema v${SCHEMA_VERSION} initialized`);
        } else {
            log.info(`PKM schema v${existing.value} loaded`);
        }

        return this;
    }

    close() {
        if (this.#db) {
            try { this.#db.close(); } catch { /* ignore */ }
            this.#db = null;
        }
    }

    get db() { return this.#db; }

    // ── Settings ───────────────────────────────────────────

    getSettings(userId) {
        return this.#db.prepare("SELECT * FROM pkm_settings WHERE user_id = ?").get(userId) || null;
    }

    isEnabled(userId) {
        const s = this.getSettings(userId);
        return s?.enabled === 1;
    }

    enableUser(userId) {
        const now = new Date().toISOString();
        const existing = this.getSettings(userId);
        if (existing) {
            this.#db.prepare("UPDATE pkm_settings SET enabled = 1, updated_at = ? WHERE user_id = ?").run(now, userId);
        } else {
            this.#db.prepare(
                `INSERT INTO pkm_settings (user_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)`
            ).run(userId, now, now);
        }
        this.logEvent(null, userId, "pkm_enabled");
    }

    disableUser(userId) {
        const now = new Date().toISOString();
        this.#db.prepare("UPDATE pkm_settings SET enabled = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
        this.logEvent(null, userId, "pkm_disabled");
    }

    updateSettings(userId, updates) {
        const allowed = ["window_minutes", "max_window_messages", "max_window_hours",
            "enrichment_enabled", "notifications_enabled", "household_id"];
        const now = new Date().toISOString();
        for (const [key, value] of Object.entries(updates)) {
            if (allowed.includes(key)) {
                this.#db.prepare(`UPDATE pkm_settings SET ${key} = ?, updated_at = ? WHERE user_id = ?`).run(value, now, userId);
            }
        }
    }

    // ── Notes CRUD ─────────────────────────────────────────

    createNote({
        userId, chatId, type = "fact", title, content, searchKeywords, tags,
        metadata, validFrom, sourceType = "extracted", confidence = 0.8,
        durability = "normal", importance = 0.5, scope = "user", scopeId,
        evidenceMsgIds, conversationId,
    }) {
        // Rate limit check
        const count = this.getNoteCount(userId);
        if (count >= this.#limits.maxNotesPerUser) {
            throw new Error(`Memory limit reached (${this.#limits.maxNotesPerUser} notes). Delete old memories first.`);
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        const vf = validFrom || now;
        const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags || null;
        const metaJson = typeof metadata === "object" ? JSON.stringify(metadata) : metadata || null;
        const evidJson = Array.isArray(evidenceMsgIds) ? JSON.stringify(evidenceMsgIds) : evidenceMsgIds || null;
        const kw = Array.isArray(searchKeywords) ? searchKeywords.join(" ") : searchKeywords || null;

        this.#db.prepare(`
            INSERT INTO notes (id, user_id, chat_id, type, title, content, search_keywords, tags,
                metadata, valid_from, source_type, confidence, durability, importance, scope, scope_id,
                evidence_msg_ids, conversation_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, userId, chatId || null, type, title || null, content, kw, tagsJson,
            metaJson, vf, sourceType, confidence, durability, importance, scope, scopeId || null,
            evidJson, conversationId || null, now, now);

        this.logEvent(id, userId, "create", { type, scope, title: title?.substring(0, 100) });

        return { id, createdAt: now };
    }

    getNote(noteId) {
        return this.#db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) || null;
    }

    updateNote(noteId, userId, updates) {
        const note = this.getNote(noteId);
        if (!note) throw new Error("Note not found");
        if (note.user_id !== userId && note.scope !== "household") {
            throw new Error("Access denied");
        }

        const allowed = ["title", "content", "search_keywords", "tags", "metadata",
            "valid_to", "superseded_by", "importance", "durability"];
        const now = new Date().toISOString();
        const sets = ["updated_at = ?"];
        const vals = [now];

        for (const [key, value] of Object.entries(updates)) {
            const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase(); // camelCase → snake_case
            if (allowed.includes(dbKey)) {
                let v = value;
                if (dbKey === "tags" && Array.isArray(v)) v = JSON.stringify(v);
                if (dbKey === "metadata" && typeof v === "object") v = JSON.stringify(v);
                if (dbKey === "search_keywords" && Array.isArray(v)) v = v.join(" ");
                sets.push(`${dbKey} = ?`);
                vals.push(v);
            }
        }

        vals.push(noteId);
        this.#db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        this.logEvent(noteId, userId, "update");
        return true;
    }

    /** Secure deletion — removes from notes + FTS5 + linked tables, then optimizes */
    secureDelete(noteId, userId) {
        const note = this.getNote(noteId);
        if (!note) return false;
        if (note.user_id !== userId && note.scope !== "household") {
            throw new Error("Access denied");
        }

        // Delete linked data
        this.#db.prepare("DELETE FROM entity_notes WHERE note_id = ?").run(noteId);
        this.#db.prepare("DELETE FROM note_links WHERE source_id = ? OR target_id = ?").run(noteId, noteId);
        this.#db.prepare("DELETE FROM structured_data WHERE note_id = ?").run(noteId);

        // Delete note (triggers FTS5 content-sync delete)
        this.#db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

        // Force FTS5 merge to purge deleted entries from b-trees
        try {
            this.#db.exec("INSERT INTO notes_fts(notes_fts) VALUES('optimize')");
        } catch (e) {
            log.warn(`FTS5 optimize after delete: ${e.message}`);
        }

        // Flush WAL to main DB file
        try {
            this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (e) {
            log.warn(`WAL checkpoint after delete: ${e.message}`);
        }

        this.logEvent(noteId, userId, "secure_delete");
        return true;
    }

    /** Delete all notes for a user — secure deletion with FTS5 cleanup. */
    deleteAllNotes(userId) {
        const notes = this.#db.prepare("SELECT id FROM notes WHERE user_id = ?").all(userId);
        if (notes.length === 0) return 0;

        // Delete linked data
        const noteIds = notes.map(n => n.id);
        const placeholders = noteIds.map(() => "?").join(",");
        this.#db.prepare(`DELETE FROM entity_notes WHERE note_id IN (${placeholders})`).run(...noteIds);
        this.#db.prepare(`DELETE FROM note_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...noteIds, ...noteIds);
        this.#db.prepare(`DELETE FROM structured_data WHERE note_id IN (${placeholders})`).run(...noteIds);

        // Delete all notes (triggers FTS5 content-sync delete)
        this.#db.prepare("DELETE FROM notes WHERE user_id = ?").run(userId);

        // Also clear conversation windows
        this.#db.prepare("DELETE FROM conversation_windows WHERE user_id = ?").run(userId);

        // Force FTS5 optimize + WAL checkpoint for secure deletion
        try {
            this.#db.exec("INSERT INTO notes_fts(notes_fts) VALUES('optimize')");
        } catch (e) {
            log.warn(`FTS5 optimize after bulk delete: ${e.message}`);
        }
        try {
            this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (e) {
            log.warn(`WAL checkpoint after bulk delete: ${e.message}`);
        }

        this.logEvent("__bulk__", userId, "delete_all");
        log.info(`Deleted all ${notes.length} notes for user ${userId}`);
        return notes.length;
    }

    // ── Search (FTS5) ──────────────────────────────────────

    /**
     * Search notes using FTS5 full-text search with BM25 ranking.
     * @param {string} query - Search query text
     * @param {object} opts - {userId, scope, scopeId, type, dateFrom, dateTo, tags, limit}
     * @returns {Array} Ranked results with BM25 score
     */
    searchNotes(query, { userId, scope = "user", scopeId, type, dateFrom, dateTo, tags, limit = 10 } = {}) {
        if (!query?.trim()) return [];

        // Sanitize FTS5 query: escape special chars, build OR-separated terms
        const sanitized = this.#sanitizeFtsQuery(query);
        if (!sanitized) return [];

        let sql = `
            SELECT n.*, rank AS bm25_score
            FROM notes n
            JOIN notes_fts ON notes_fts.rowid = n.rowid
            WHERE notes_fts MATCH ?
              AND n.user_id = ?
              AND n.scope = ?
              AND n.valid_to IS NULL
        `;
        const params = [sanitized, userId, scope];

        if (scopeId) {
            sql += " AND n.scope_id = ?";
            params.push(scopeId);
        }
        if (type) {
            sql += " AND n.type = ?";
            params.push(type);
        }
        if (dateFrom) {
            sql += " AND n.created_at >= ?";
            params.push(dateFrom);
        }
        if (dateTo) {
            sql += " AND n.created_at <= ?";
            params.push(dateTo);
        }
        if (tags && Array.isArray(tags) && tags.length > 0) {
            // Tag filter: any tag matches
            const tagClauses = tags.map(() => "n.tags LIKE ?");
            sql += ` AND (${tagClauses.join(" OR ")})`;
            for (const t of tags) params.push(`%"${t}"%`);
        }

        sql += " ORDER BY rank LIMIT ?";
        params.push(limit);

        try {
            return this.#db.prepare(sql).all(...params);
        } catch (e) {
            log.warn(`FTS5 search error: ${e.message} (query=${query})`);
            return [];
        }
    }

    /** Sanitize FTS5 query — escape operators and build safe query */
    #sanitizeFtsQuery(raw) {
        // Remove FTS5 operators that could cause syntax errors
        let q = raw.replace(/[{}()"^*:]/g, " ").trim();
        if (!q) return null;

        // Split into terms, filter empty, rejoin with OR for broader matching
        const terms = q.split(/\s+/).filter(t => t.length > 1);
        if (terms.length === 0) return null;

        // Use implicit AND for multi-word queries (FTS5 default)
        // Quote each term to avoid operator interpretation
        return terms.map(t => `"${t}"`).join(" ");
    }

    // ── Recent notes ───────────────────────────────────────

    getRecentNotes(userId, { scope = "user", days = 7, limit = 10 } = {}) {
        const since = new Date(Date.now() - days * 86400000).toISOString();
        return this.#db.prepare(`
            SELECT id, title, type, tags, created_at, scope, confidence
            FROM notes
            WHERE user_id = ? AND scope = ? AND created_at >= ? AND valid_to IS NULL
            ORDER BY created_at DESC
            LIMIT ?
        `).all(userId, scope, since, limit);
    }

    // ── Note count + stats ─────────────────────────────────

    getNoteCount(userId) {
        const r = this.#db.prepare("SELECT COUNT(*) as cnt FROM notes WHERE user_id = ? AND valid_to IS NULL").get(userId);
        return r?.cnt || 0;
    }

    getStats(userId) {
        const total = this.getNoteCount(userId);
        const byType = this.#db.prepare(
            "SELECT type, COUNT(*) as cnt FROM notes WHERE user_id = ? AND valid_to IS NULL GROUP BY type"
        ).all(userId);
        const byMonth = this.#db.prepare(
            `SELECT substr(created_at, 1, 7) as month, COUNT(*) as cnt
             FROM notes WHERE user_id = ? AND valid_to IS NULL
             GROUP BY month ORDER BY month DESC LIMIT 12`
        ).all(userId);
        const settings = this.getSettings(userId);
        const extractionStats = settings?.extraction_stats ? JSON.parse(settings.extraction_stats) : null;

        return {
            total,
            byType: Object.fromEntries(byType.map(r => [r.type, r.cnt])),
            byMonth: Object.fromEntries(byMonth.map(r => [r.month, r.cnt])),
            extractionHealth: extractionStats,
        };
    }

    // ── Conversation windows ───────────────────────────────

    getOpenWindow(userId, chatId) {
        return this.#db.prepare(
            `SELECT * FROM conversation_windows
             WHERE user_id = ? AND chat_id = ? AND extracted = 0 AND closed_at IS NULL
             ORDER BY last_message_at DESC LIMIT 1`
        ).get(userId, chatId || null) || null;
    }

    createWindow(userId, chatId) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.#db.prepare(
            `INSERT INTO conversation_windows (id, user_id, chat_id, messages, message_count, started_at, last_message_at)
             VALUES (?, ?, ?, '[]', 0, ?, ?)`
        ).run(id, userId, chatId || null, now, now);
        return id;
    }

    appendToWindow(windowId, message) {
        const win = this.#db.prepare("SELECT * FROM conversation_windows WHERE id = ?").get(windowId);
        if (!win) return;
        const msgs = JSON.parse(win.messages || "[]");
        msgs.push(message);
        const now = new Date().toISOString();
        this.#db.prepare(
            `UPDATE conversation_windows SET messages = ?, message_count = ?, last_message_at = ? WHERE id = ?`
        ).run(JSON.stringify(msgs), msgs.length, now, windowId);
    }

    closeWindow(windowId) {
        const now = new Date().toISOString();
        this.#db.prepare("UPDATE conversation_windows SET closed_at = ? WHERE id = ?").run(now, windowId);
    }

    markWindowExtracted(windowId, noteIds = []) {
        this.#db.prepare(
            `UPDATE conversation_windows SET extracted = 1, messages = NULL, note_ids = ? WHERE id = ?`
        ).run(JSON.stringify(noteIds), windowId);
    }

    markWindowFailed(windowId) {
        this.#db.prepare(
            `UPDATE conversation_windows SET retry_count = retry_count + 1,
             extracted = CASE WHEN retry_count >= 2 THEN 3 ELSE 2 END
             WHERE id = ?`
        ).run(windowId);
    }

    getStaleWindows(userId, gapMinutes = 30) {
        const cutoff = new Date(Date.now() - gapMinutes * 60000).toISOString();
        return this.#db.prepare(
            `SELECT * FROM conversation_windows
             WHERE user_id = ? AND extracted = 0 AND closed_at IS NULL AND last_message_at < ?`
        ).all(userId, cutoff);
    }

    getAllStaleWindows(gapMinutes = 30) {
        const cutoff = new Date(Date.now() - gapMinutes * 60000).toISOString();
        return this.#db.prepare(
            `SELECT * FROM conversation_windows
             WHERE extracted = 0 AND closed_at IS NULL AND last_message_at < ?`
        ).all(cutoff);
    }

    getPendingExtractionWindows() {
        return this.#db.prepare(
            `SELECT * FROM conversation_windows WHERE extracted = 2 AND retry_count < 3 ORDER BY last_message_at ASC`
        ).all();
    }

    purgeOldRawMessages(maxAgeDays = 7) {
        const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
        const result = this.#db.prepare(
            `UPDATE conversation_windows SET messages = NULL
             WHERE messages IS NOT NULL AND last_message_at < ?`
        ).run(cutoff);
        if (result.changes > 0) {
            log.info(`Purged raw messages from ${result.changes} old windows`);
        }
        return result.changes;
    }

    getOversizedWindows(maxMessages = 30, maxHours = 4) {
        const hoursCutoff = new Date(Date.now() - maxHours * 3600000).toISOString();
        return this.#db.prepare(
            `SELECT * FROM conversation_windows
             WHERE extracted = 0 AND closed_at IS NULL
             AND (message_count >= ? OR started_at < ?)`
        ).all(maxMessages, hoursCutoff);
    }

    // ── Audit log ──────────────────────────────────────────

    logEvent(noteId, userId, event, details = null) {
        const now = new Date().toISOString();
        const detailsJson = details ? JSON.stringify(details) : null;
        try {
            this.#db.prepare(
                "INSERT INTO memory_events (note_id, user_id, event, details, created_at) VALUES (?, ?, ?, ?, ?)"
            ).run(noteId || null, userId, event, detailsJson, now);
        } catch (e) {
            log.warn(`Audit log write failed: ${e.message}`);
        }
    }

    getAuditLog(userId, { days = 7, limit = 50 } = {}) {
        const since = new Date(Date.now() - days * 86400000).toISOString();
        return this.#db.prepare(
            `SELECT * FROM memory_events WHERE user_id = ? AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
        ).all(userId, since, limit);
    }

    purgeOldAuditLogs(maxAgeDays = 90) {
        const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
        const result = this.#db.prepare("DELETE FROM memory_events WHERE created_at < ?").run(cutoff);
        if (result.changes > 0) {
            log.info(`Purged ${result.changes} old audit log entries`);
        }
        return result.changes;
    }

    // ── Extraction stats tracking ──────────────────────────

    updateExtractionStats(userId, { notesProduced, wasEmpty, failed }) {
        const settings = this.getSettings(userId);
        if (!settings) return;
        const stats = settings.extraction_stats ? JSON.parse(settings.extraction_stats) : {
            processed: 0, empty: 0, failed: 0, totalNotes: 0,
        };
        stats.processed++;
        if (wasEmpty) stats.empty++;
        if (failed) stats.failed++;
        stats.totalNotes += (notesProduced || 0);
        const now = new Date().toISOString();
        this.#db.prepare(
            "UPDATE pkm_settings SET extraction_stats = ?, updated_at = ? WHERE user_id = ?"
        ).run(JSON.stringify(stats), now, userId);
    }

    // ── MEMORY.md bootstrap migration ──────────────────────

    /**
     * One-time migration: parse MEMORY.md and daily logs into agent PKM notes.
     * Only runs if agent settings don't exist yet.
     * @param {string} memoryDir - Path to agent memory dir (e.g. /config/copilot-telegram-bot)
     */
    bootstrapAgentMemory(memoryDir) {
        const agentId = "__agent__";
        const existing = this.getSettings(agentId);
        if (existing) {
            log.info("Agent memory already bootstrapped — skipping");
            return { migrated: 0 };
        }

        let migrated = 0;
        const now = new Date().toISOString();

        // Enable agent settings
        this.#db.prepare(
            `INSERT INTO pkm_settings (user_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)`
        ).run(agentId, now, now);

        // Parse MEMORY.md
        const memoryPath = `${memoryDir}/MEMORY.md`;
        if (existsSync(memoryPath)) {
            try {
                const content = readFileSync(memoryPath, "utf-8");
                const notes = this.#parseMemoryMd(content);
                for (const note of notes) {
                    this.createNote({
                        userId: agentId,
                        type: note.type || "fact",
                        title: note.title,
                        content: note.content,
                        searchKeywords: note.keywords,
                        tags: note.tags,
                        sourceType: "stated",
                        confidence: 1.0,
                        durability: "permanent",
                        importance: 0.7,
                        scope: "agent",
                    });
                    migrated++;
                }
                log.info(`Migrated ${notes.length} notes from MEMORY.md`);
            } catch (e) {
                log.error(`Failed to parse MEMORY.md: ${e.message}`);
            }
        }

        // Parse daily logs
        const logDir = `${memoryDir}/memory`;
        if (existsSync(logDir)) {
            try {
                const files = readdirSync(logDir);
                for (const file of files) {
                    if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
                    try {
                        const logContent = readFileSync(`${logDir}/${file}`, "utf-8");
                        if (logContent.trim().length < 50) continue;
                        this.createNote({
                            userId: agentId,
                            type: "journal",
                            title: `Daily log: ${file.replace(".md", "")}`,
                            content: logContent.substring(0, 2000),
                            searchKeywords: file.replace(".md", ""),
                            tags: ["daily-log"],
                            sourceType: "stated",
                            confidence: 1.0,
                            durability: "normal",
                            importance: 0.4,
                            scope: "agent",
                            validFrom: `${file.replace(".md", "")}T00:00:00.000Z`,
                        });
                        migrated++;
                    } catch (e) {
                        log.warn(`Failed to migrate ${file}: ${e.message}`);
                    }
                }
            } catch (e) {
                log.warn(`Failed to read log dir: ${e.message}`);
            }
        }

        this.logEvent(null, agentId, "bootstrap_migration", { migrated });
        log.info(`Agent memory bootstrap complete: ${migrated} notes migrated`);
        return { migrated };
    }

    /** Parse MEMORY.md into structured notes */
    #parseMemoryMd(content) {
        const notes = [];
        const sections = content.split(/^## /gm).filter(s => s.trim());

        for (const section of sections) {
            const lines = section.split("\n");
            const heading = lines[0]?.trim();
            if (!heading) continue;

            // Skip sections that stay in system prompt
            if (/^(Agent Identity|Personality|Rules|Responsibilities|Skills)/i.test(heading)) continue;
            if (/^(Active Tasks|Recent Daily Logs|Daily Log)/i.test(heading)) continue;

            const body = lines.slice(1).join("\n").trim();
            if (!body || body.length < 20) continue;

            // Extract bullet points as individual facts
            const bullets = body.match(/^[-*]\s+\*\*(.+?)\*\*\s*[:—–-]\s*(.+)/gm);
            if (bullets && bullets.length > 0) {
                for (const bullet of bullets) {
                    const match = bullet.match(/^[-*]\s+\*\*(.+?)\*\*\s*[:—–-]\s*(.+)/);
                    if (match) {
                        const title = match[1].trim();
                        const detail = match[2].trim();
                        notes.push({
                            title,
                            content: `${title}: ${detail}`,
                            type: "fact",
                            keywords: title.toLowerCase().split(/\s+/).concat(detail.toLowerCase().split(/\s+/).slice(0, 10)),
                            tags: [heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
                        });
                    }
                }
            } else {
                // Store whole section as one note
                notes.push({
                    title: heading,
                    content: body.substring(0, 1000),
                    type: "fact",
                    keywords: heading.toLowerCase().split(/\s+/),
                    tags: [heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
                });
            }
        }
        return notes;
    }
}

export default PkmStore;
