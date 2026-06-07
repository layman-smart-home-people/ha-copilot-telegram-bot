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

const SCHEMA_VERSION = 2;

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

const MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    parent_id   TEXT,
    name        TEXT NOT NULL,
    icon        TEXT,
    description TEXT,
    sort_order  INTEGER DEFAULT 0,
    note_count  INTEGER DEFAULT 0,
    activation  REAL DEFAULT 1.0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES topics(id)
);
CREATE INDEX IF NOT EXISTS idx_topics_tree ON topics(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_topics_name ON topics(user_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS note_topics (
    note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    is_primary INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (note_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_nt_topic ON note_topics(topic_id, is_primary);

CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    topic_id    TEXT REFERENCES topics(id),
    name        TEXT NOT NULL,
    description TEXT,
    schema_json TEXT NOT NULL,
    item_count  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);

CREATE TABLE IF NOT EXISTS pkm_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
`;

const MIGRATION_V2_ALTERS = [
    "ALTER TABLE notes ADD COLUMN primary_topic_id TEXT REFERENCES topics(id)",
    "ALTER TABLE notes ADD COLUMN activation REAL DEFAULT 1.0",
    "ALTER TABLE notes ADD COLUMN last_accessed_at TEXT",
    "ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0",
    "ALTER TABLE notes ADD COLUMN confirmations INTEGER DEFAULT 0",
    "ALTER TABLE notes ADD COLUMN collection_id TEXT REFERENCES collections(id)",
    "ALTER TABLE note_links ADD COLUMN weight REAL DEFAULT 1.0",
];

const MIGRATION_V2_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(primary_topic_id, activation DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notes_activation ON notes(user_id, activation DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notes_collection ON notes(collection_id) WHERE collection_id IS NOT NULL",
];

// ── PkmStore class ─────────────────────────────────────────

export class PkmStore {
    #db;
    #dbPath;
    #limits;

    constructor(dbPath, limits = {}) {
        this.#dbPath = dbPath;
        this.#limits = { ...DEFAULT_LIMITS, ...limits };
    }

    static #levenshtein(a, b) {
        const an = a.length;
        const bn = b.length;
        if (an === 0) return bn;
        if (bn === 0) return an;
        const matrix = Array.from({ length: an + 1 }, (_, i) => {
            const row = new Array(bn + 1);
            row[0] = i;
            return row;
        });
        for (let j = 1; j <= bn; j++) matrix[0][j] = j;
        for (let i = 1; i <= an; i++) {
            for (let j = 1; j <= bn; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }
        return matrix[an][bn];
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
        let schemaVersion = existing?.value || "1";
        if (!existing) {
            this.#db.prepare("INSERT INTO pkm_schema (key, value) VALUES ('version', ?)").run(schemaVersion);
            log.info(`PKM schema v${schemaVersion} initialized`);
        } else {
            log.info(`PKM schema v${schemaVersion} loaded`);
        }

        if (schemaVersion === "1") {
            log.info("Running PKM schema v2 migration");
            this.#db.exec("BEGIN");
            try {
                this.#db.exec(MIGRATION_V2_SQL);
                log.info("Ensured PKM v2 tables");

                for (const sql of MIGRATION_V2_ALTERS) {
                    try {
                        this.#db.exec(sql);
                        log.info(`Applied PKM v2 alter: ${sql}`);
                    } catch (e) {
                        if (e.message?.includes("duplicate column name")) {
                            log.info(`Skipping existing PKM v2 column: ${sql}`);
                            continue;
                        }
                        throw e;
                    }
                }

                for (const sql of MIGRATION_V2_INDEXES) {
                    this.#db.exec(sql);
                }
                log.info("Ensured PKM v2 indexes");

                const enabledUsers = this.#db.prepare(
                    "SELECT user_id FROM pkm_settings WHERE enabled = 1"
                ).all();
                for (const { user_id: userId } of enabledUsers) {
                    this.#seedDefaultTopics(userId);
                }
                log.info(`Seeded default topics for ${enabledUsers.length} enabled users`);

                // Backfill existing notes to topics
                for (const { user_id: userId } of enabledUsers) {
                    try {
                        const backfilled = this.backfillTopics(userId);
                        if (backfilled > 0) {
                            log.info(`Backfilled ${backfilled} notes to topics for user ${userId}`);
                        }
                    } catch (e) {
                        log.warn(`Topic backfill failed for user ${userId}: ${e.message}`);
                    }
                }

                this.#db.prepare("UPDATE pkm_schema SET value = ? WHERE key = 'version'").run(String(SCHEMA_VERSION));
                this.#db.exec("COMMIT");
                schemaVersion = String(SCHEMA_VERSION);
                log.info(`PKM schema migrated to v${schemaVersion}`);
            } catch (e) {
                try {
                    this.#db.exec("ROLLBACK");
                } catch {
                    // ignore rollback failures
                }
                log.error(`PKM schema v2 migration failed: ${e.message}`);
                throw e;
            }
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
        evidenceMsgIds, conversationId, topics,
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

        // Assign to topics if provided
        if (Array.isArray(topics) && topics.length > 0) {
            const resolved = [];
            for (const topicName of topics.slice(0, 2)) {
                const topic = this.resolveTopicName(userId, topicName);
                if (topic) resolved.push(topic);
            }
            if (resolved.length > 0) {
                this.assignNoteToTopic(id, resolved[0].id, true);
                if (resolved.length > 1) {
                    this.assignNoteToTopic(id, resolved[1].id, false);
                }
            }
        }

        this.invalidateMapCache(userId);
        return { id, createdAt: now };
    }

    getNote(noteId) {
        return this.#db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) || null;
    }

    updateNote(noteId, userId, updates) {
        const note = this.getNote(noteId);
        if (!note) throw new Error("Note not found");
        if (note.user_id !== userId) {
            if (note.scope !== "household" || !this.isHouseholdMember(userId, note.scope_id)) {
                throw new Error("Access denied");
            }
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
        this.invalidateMapCache(note.user_id);
        return true;
    }

    /** Secure deletion — removes from notes + FTS5 + linked tables, then optimizes */
    secureDelete(noteId, userId) {
        const note = this.getNote(noteId);
        if (!note) return false;
        if (note.user_id !== userId) {
            if (note.scope !== "household" || !this.isHouseholdMember(userId, note.scope_id)) {
                throw new Error("Access denied");
            }
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
        this.invalidateMapCache(note.user_id);
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

    // ── Household management ───────────────────────────────

    /**
     * Create a new household and add the creator as owner.
     * @returns {{ id: string }}
     */
    createHousehold(userId, name) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.#db.prepare(
            `INSERT INTO households (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`
        ).run(id, name, userId, now);
        this.#db.prepare(
            `INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`
        ).run(id, userId, now);
        // Link household to user settings
        this.#db.prepare(
            `UPDATE pkm_settings SET household_id = ?, updated_at = ? WHERE user_id = ?`
        ).run(id, now, userId);
        this.logEvent(null, userId, "household_created", { household_id: id, name });
        return { id };
    }

    /**
     * Join an existing household.
     */
    joinHousehold(userId, householdId) {
        const hh = this.#db.prepare("SELECT * FROM households WHERE id = ?").get(householdId);
        if (!hh) throw new Error("Household not found");
        // Check not already a member
        const existing = this.#db.prepare(
            "SELECT * FROM household_members WHERE household_id = ? AND user_id = ?"
        ).get(householdId, userId);
        if (existing) throw new Error("Already a member");

        const now = new Date().toISOString();
        this.#db.prepare(
            `INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
        ).run(householdId, userId, now);
        this.#db.prepare(
            `UPDATE pkm_settings SET household_id = ?, updated_at = ? WHERE user_id = ?`
        ).run(householdId, now, userId);
        this.logEvent(null, userId, "household_joined", { household_id: householdId });
    }

    /**
     * Leave a household.
     */
    leaveHousehold(userId) {
        const settings = this.getSettings(userId);
        if (!settings?.household_id) throw new Error("Not in a household");

        // Prevent last owner from leaving — must transfer ownership or delete household
        const member = this.#db.prepare(
            "SELECT role FROM household_members WHERE household_id = ? AND user_id = ?"
        ).get(settings.household_id, userId);
        if (member?.role === "owner") {
            const otherOwners = this.#db.prepare(
                "SELECT 1 FROM household_members WHERE household_id = ? AND role = 'owner' AND user_id != ?"
            ).get(settings.household_id, userId);
            if (!otherOwners) {
                throw new Error("Cannot leave — you are the only owner. Transfer ownership first or delete the household.");
            }
        }

        const now = new Date().toISOString();
        this.#db.prepare(
            "DELETE FROM household_members WHERE household_id = ? AND user_id = ?"
        ).run(settings.household_id, userId);
        this.#db.prepare(
            `UPDATE pkm_settings SET household_id = NULL, updated_at = ? WHERE user_id = ?`
        ).run(now, userId);
        this.logEvent(null, userId, "household_left", { household_id: settings.household_id });
    }

    /**
     * Check if a user is a member of a given household.
     */
    isHouseholdMember(userId, householdId) {
        if (!householdId) return false;
        const row = this.#db.prepare(
            "SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?"
        ).get(householdId, userId);
        return !!row;
    }

    /**
     * Get all members of a household.
     */
    getHouseholdMembers(householdId) {
        return this.#db.prepare(
            "SELECT * FROM household_members WHERE household_id = ? ORDER BY joined_at"
        ).all(householdId);
    }

    /**
     * Get household info.
     */
    getHousehold(householdId) {
        return this.#db.prepare("SELECT * FROM households WHERE id = ?").get(householdId) || null;
    }

    // ── Data export ────────────────────────────────────────

    /**
     * Export all user data as a structured JSON object.
     * Includes notes, entities, structured data, settings.
     */
    exportUserData(userId) {
        const notes = this.#db.prepare(
            "SELECT * FROM notes WHERE user_id = ? ORDER BY created_at"
        ).all(userId);
        const entities = this.#db.prepare(
            "SELECT * FROM entities WHERE user_id = ? ORDER BY name"
        ).all(userId);
        const structuredData = this.#db.prepare(
            "SELECT * FROM structured_data WHERE user_id = ? ORDER BY measured_at"
        ).all(userId);
        const settings = this.getSettings(userId);
        const auditLog = this.#db.prepare(
            "SELECT * FROM memory_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 500"
        ).all(userId);

        const entityLinks = this.#db.prepare(
            `SELECT en.* FROM entity_notes en
             JOIN entities e ON e.id = en.entity_id
             WHERE e.user_id = ?`
        ).all(userId);

        return {
            exportedAt: new Date().toISOString(),
            userId,
            settings: settings || {},
            notes,
            entities,
            entityLinks,
            structuredData,
            auditLog,
            summary: {
                totalNotes: notes.length,
                activeNotes: notes.filter(n => !n.valid_to).length,
                supersededNotes: notes.filter(n => n.valid_to).length,
                entityCount: entities.length,
                structuredDataPoints: structuredData.length,
            },
        };
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
              AND n.scope = ?
              AND n.valid_to IS NULL
        `;
        const params = [sanitized, scope];

        // For household scope, match by scope_id (all members can read)
        // For user/agent scope, match by user_id (private)
        if (scope === "household" && scopeId) {
            sql += " AND n.scope_id = ?";
            params.push(scopeId);
        } else {
            sql += " AND n.user_id = ?";
            params.push(userId);
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

    // ── Memory map ────────────────────────────────────────────

    #getFromCache(key) {
        try {
            const row = this.#db.prepare(
                "SELECT value, expires_at FROM pkm_cache WHERE key = ?"
            ).get(key);
            if (!row) return null;
            if (new Date(row.expires_at) < new Date()) {
                this.#db.prepare("DELETE FROM pkm_cache WHERE key = ?").run(key);
                return null;
            }
            return JSON.parse(row.value);
        } catch {
            return null;
        }
    }

    #setCache(key, value, ttlMs) {
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        this.#db.prepare(
            `INSERT OR REPLACE INTO pkm_cache (key, value, expires_at) VALUES (?, ?, ?)`
        ).run(key, JSON.stringify(value), expiresAt);
    }

    invalidateMapCache(userId) {
        try {
            this.#db.prepare("DELETE FROM pkm_cache WHERE key = ?").run(`map:${userId}`);
        } catch { /* ignore */ }
    }

    getMemoryMap(userId) {
        const cached = this.#getFromCache(`map:${userId}`);
        if (cached) return cached;

        const total = this.getNoteCount(userId);

        const allTopics = this.#db.prepare(
            "SELECT * FROM topics WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE"
        ).all(userId);

        const topicTree = [];
        const topicMap = new Map(allTopics.map(topic => [topic.id, { ...topic, children: [] }]));

        for (const topic of topicMap.values()) {
            if (topic.parent_id && topicMap.has(topic.parent_id)) {
                topicMap.get(topic.parent_id).children.push(topic);
            } else if (!topic.parent_id) {
                topicTree.push(topic);
            }
        }

        const topicCount = allTopics.length;
        const detailLevel = topicCount <= 20 ? "full" : topicCount <= 50 ? "summary" : "collapsed";

        const uncategorized = this.#db.prepare(
            "SELECT COUNT(*) as cnt FROM notes WHERE user_id = ? AND valid_to IS NULL AND primary_topic_id IS NULL"
        ).get(userId)?.cnt || 0;

        const byType = this.#db.prepare(
            "SELECT type, COUNT(*) as cnt FROM notes WHERE user_id = ? AND valid_to IS NULL GROUP BY type ORDER BY cnt DESC"
        ).all(userId);

        const entities = this.#db.prepare(`
            SELECT e.name, e.type, COUNT(n.id) as note_count
            FROM entities e
            LEFT JOIN entity_notes en ON en.entity_id = e.id
            LEFT JOIN notes n ON n.id = en.note_id AND n.valid_to IS NULL
            WHERE e.user_id = ?
            GROUP BY e.id
            ORDER BY note_count DESC
            LIMIT 10
        `).all(userId);

        const collections = this.#db.prepare(
            "SELECT id, name, item_count FROM collections WHERE user_id = ? ORDER BY name"
        ).all(userId);

        let bridges = [];
        try {
            bridges = this.getCrossTopicBridges(userId);
        } catch {
            // ignore if no bridges
        }

        const byMonth = this.#db.prepare(
            `SELECT substr(created_at, 1, 7) as month, COUNT(*) as cnt
             FROM notes WHERE user_id = ? AND valid_to IS NULL
             GROUP BY month ORDER BY month DESC LIMIT 6`
        ).all(userId);

        const settings = this.getSettings(userId);
        let household = null;
        if (settings?.household_id) {
            const hh = this.#db.prepare("SELECT name FROM households WHERE id = ?").get(settings.household_id);
            const memberCount = this.#db.prepare(
                "SELECT COUNT(*) as cnt FROM household_members WHERE household_id = ?"
            ).get(settings.household_id);
            const sharedCount = this.#db.prepare(
                "SELECT COUNT(*) as cnt FROM notes WHERE scope = 'household' AND scope_id = ? AND valid_to IS NULL"
            ).get(settings.household_id);
            household = {
                name: hh?.name || "Unknown",
                members: memberCount?.cnt || 0,
                sharedMemories: sharedCount?.cnt || 0,
            };
        }

        const archived = this.#db.prepare(
            "SELECT COUNT(*) as cnt FROM notes WHERE user_id = ? AND valid_to IS NOT NULL"
        ).get(userId)?.cnt || 0;

        const result = {
            total,
            archived,
            uncategorized,
            topicTree,
            topicCount,
            detailLevel,
            byType,
            entities,
            collections,
            bridges,
            byMonth,
            household,
        };

        this.#setCache(`map:${userId}`, result, 5 * 60 * 1000);

        return result;
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

    // ── Entity processing ──────────────────────────────────

    /**
     * Find or create an entity and link it to a note.
     * @param {string} userId - Owner of the entity
     * @param {string} noteId - Note to link
     * @param {{ name: string, type?: string }} entityDef - Entity definition from LLM
     * @returns {string} Entity ID
     */
    findOrCreateEntity(userId, noteId, entityDef) {
        const name = entityDef.name?.trim();
        if (!name) return null;
        const type = entityDef.type || "unknown";
        const nameLower = name.toLowerCase();

        let entity = this.#db.prepare(
            `SELECT * FROM entities WHERE user_id = ? AND LOWER(name) = ?`
        ).get(userId, nameLower);
        let matchType = entity ? "exact" : null;

        if (!entity) {
            entity = this.#db.prepare(
                `SELECT * FROM entities WHERE user_id = ? AND LOWER(aliases) LIKE ?`
            ).get(userId, `%${nameLower}%`);
            if (entity) matchType = "alias";
        }

        if (!entity && nameLower.length >= 3) {
            const candidates = this.#db.prepare(
                `SELECT * FROM entities WHERE user_id = ?
                 AND (LOWER(name) LIKE ? OR ? LIKE '%' || LOWER(name) || '%')`
            ).all(userId, `%${nameLower}%`, nameLower);

            if (candidates.length === 1) {
                entity = candidates[0];
                matchType = "substring";
            } else if (candidates.length > 1) {
                entity = candidates.sort((a, b) => a.name.length - b.name.length)[0];
                matchType = "substring";
            }
        }

        if (entity && matchType === "substring") {
            const existingAliases = entity.aliases ? JSON.parse(entity.aliases) : [];
            if (!existingAliases.includes(nameLower)) {
                existingAliases.push(nameLower);
                const now = new Date().toISOString();
                this.#db.prepare(
                    "UPDATE entities SET aliases = ?, updated_at = ? WHERE id = ?"
                ).run(JSON.stringify(existingAliases), now, entity.id);
                entity = { ...entity, aliases: JSON.stringify(existingAliases), updated_at: now };
            }
        }

        if (!entity) {
            // Create new entity
            const id = randomUUID();
            const now = new Date().toISOString();
            this.#db.prepare(
                `INSERT INTO entities (id, user_id, name, type, aliases, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(id, userId, name, type, JSON.stringify([nameLower]), now, now);
            entity = { id };
        }

        // Link entity to note (ignore duplicate)
        try {
            this.#db.prepare(
                `INSERT OR IGNORE INTO entity_notes (entity_id, note_id) VALUES (?, ?)`
            ).run(entity.id, noteId);
        } catch { /* ignore duplicates */ }

        return entity.id;
    }

    /**
     * Process entities from an extracted note.
     * Called after note creation to populate entities + entity_notes tables.
     * @param {string} noteId - The note ID
     * @param {string} userId - The note's owner
     * @param {Array<{name: string, type?: string}>} entities - Entities from LLM
     */
    processEntities(noteId, userId, entities) {
        if (!Array.isArray(entities) || entities.length === 0) return;
        for (const ent of entities.slice(0, 10)) {
            try {
                this.findOrCreateEntity(userId, noteId, ent);
            } catch (e) {
                log.warn(`Entity processing failed for "${ent.name}": ${e.message}`);
            }
        }
    }

    /**
     * Search entities by name (partial match).
     * @returns {Array} Matching entities with linked note count
     */
    searchEntities(userId, query, { limit = 10 } = {}) {
        const pattern = `%${query}%`;
        return this.#db.prepare(`
            SELECT e.*, COUNT(en.note_id) as note_count
            FROM entities e
            LEFT JOIN entity_notes en ON en.entity_id = e.id
            WHERE e.user_id = ? AND (e.name LIKE ? OR e.aliases LIKE ?)
            GROUP BY e.id
            ORDER BY note_count DESC
            LIMIT ?
        `).all(userId, pattern, pattern, limit);
    }

    /**
     * Get all notes linked to a specific entity.
     */
    getNotesForEntity(entityId, { userId, limit = 20 } = {}) {
        let sql = `
            SELECT n.*
            FROM notes n
            JOIN entity_notes en ON en.note_id = n.id
            WHERE en.entity_id = ? AND n.valid_to IS NULL
        `;
        const params = [entityId];
        if (userId) {
            sql += " AND n.user_id = ?";
            params.push(userId);
        }
        sql += " ORDER BY n.created_at DESC LIMIT ?";
        params.push(limit);
        return this.#db.prepare(sql).all(...params);
    }

    // ── Topics ─────────────────────────────────────────────

    #seedDefaultTopics(userId) {
        try {
            const existing = this.#db.prepare(
                "SELECT 1 FROM topics WHERE user_id = ? LIMIT 1"
            ).get(userId);
            if (existing) return;

            for (const topic of [
                { name: "People", icon: "👥" },
                { name: "Home", icon: "🏠" },
                { name: "Life", icon: "🌱" },
            ]) {
                this.createTopic(userId, topic.name, { icon: topic.icon });
            }
            log.info(`Seeded default topics for user ${userId}`);
        } catch (e) {
            if (/already exists|Similar topic/i.test(e.message)) return;
            log.warn(`Default topic seed skipped for user ${userId}: ${e.message}`);
        }
    }

    createTopic(userId, name, { parentId = null, icon = null, description = null } = {}) {
        const trimmedName = String(name || "").trim();
        if (!trimmedName) throw new Error("Topic name is required");

        if (parentId) {
            const parent = this.#db.prepare(
                "SELECT id, user_id, name FROM topics WHERE id = ?"
            ).get(parentId);
            if (!parent || parent.user_id !== userId) {
                throw new Error("Parent topic not found");
            }
            if (this.#getTopicDepth(parentId) >= 2) {
                throw new Error("Topic tree depth limit reached");
            }
        }

        const siblings = parentId
            ? this.#db.prepare(
                "SELECT id, name FROM topics WHERE user_id = ? AND parent_id = ? ORDER BY name COLLATE NOCASE"
            ).all(userId, parentId)
            : this.#db.prepare(
                "SELECT id, name FROM topics WHERE user_id = ? AND parent_id IS NULL ORDER BY name COLLATE NOCASE"
            ).all(userId);

        const exact = siblings.find(topic => topic.name.toLowerCase() === trimmedName.toLowerCase());
        if (exact) {
            throw new Error(`Topic "${trimmedName}" already exists here`);
        }

        const similar = siblings
            .map(topic => ({
                topic,
                distance: PkmStore.#levenshtein(topic.name.toLowerCase(), trimmedName.toLowerCase()),
            }))
            .filter(candidate => candidate.distance <= 2)
            .sort((a, b) => a.distance - b.distance || a.topic.name.localeCompare(b.topic.name))[0];
        if (similar) {
            throw new Error(`Similar topic already exists: ${similar.topic.name}`);
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        this.#db.prepare(
            `INSERT INTO topics (id, user_id, parent_id, name, icon, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, userId, parentId, trimmedName, icon, description, now, now);
        this.invalidateMapCache(userId);
        log.info(`Created topic ${id} (${trimmedName}) for user ${userId}`);
        return { id, name: trimmedName };
    }

    getTopics(userId, { parentId } = {}) {
        if (parentId) {
            return this.#db.prepare(
                `SELECT * FROM topics
                 WHERE user_id = ? AND parent_id = ?
                 ORDER BY sort_order, name COLLATE NOCASE`
            ).all(userId, parentId);
        }

        return this.#db.prepare(
            `SELECT * FROM topics
             WHERE user_id = ? AND parent_id IS NULL
             ORDER BY sort_order, name COLLATE NOCASE`
        ).all(userId);
    }

    getTopic(topicId) {
        return this.#db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) || null;
    }

    updateTopic(topicId, userId, updates = {}) {
        const topic = this.getTopic(topicId);
        if (!topic) throw new Error("Topic not found");
        if (topic.user_id !== userId) throw new Error("Access denied");

        const nextName = updates.name === undefined ? topic.name : String(updates.name || "").trim();
        if (!nextName) throw new Error("Topic name is required");

        if (nextName.toLowerCase() !== topic.name.toLowerCase()) {
            const duplicate = topic.parent_id
                ? this.#db.prepare(
                    `SELECT id FROM topics
                     WHERE user_id = ? AND parent_id = ? AND LOWER(name) = LOWER(?) AND id != ?`
                ).get(userId, topic.parent_id, nextName, topicId)
                : this.#db.prepare(
                    `SELECT id FROM topics
                     WHERE user_id = ? AND parent_id IS NULL AND LOWER(name) = LOWER(?) AND id != ?`
                ).get(userId, nextName, topicId);
            if (duplicate) {
                throw new Error(`Topic "${nextName}" already exists here`);
            }
        }

        const allowed = new Map([
            ["name", nextName],
            ["icon", updates.icon],
            ["description", updates.description],
            ["sort_order", updates.sort_order ?? updates.sortOrder],
        ]);
        const now = new Date().toISOString();
        const sets = ["updated_at = ?"];
        const values = [now];

        for (const [key, value] of allowed.entries()) {
            if (value !== undefined) {
                sets.push(`${key} = ?`);
                values.push(value);
            }
        }

        values.push(topicId);
        this.#db.prepare(`UPDATE topics SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        this.invalidateMapCache(userId);
        return this.getTopic(topicId);
    }

    deleteTopic(topicId, userId) {
        const topic = this.getTopic(topicId);
        if (!topic) throw new Error("Topic not found");
        if (topic.user_id !== userId) throw new Error("Access denied");

        const now = new Date().toISOString();
        const reassigned = this.#db.prepare(
            "UPDATE notes SET primary_topic_id = ?, updated_at = ? WHERE primary_topic_id = ?"
        ).run(topic.parent_id, now, topicId).changes;

        if (topic.parent_id) {
            this.#db.prepare(
                `INSERT OR IGNORE INTO note_topics (note_id, topic_id, is_primary, created_at)
                 SELECT note_id, ?, is_primary, created_at
                 FROM note_topics WHERE topic_id = ?`
            ).run(topic.parent_id, topicId);
        }
        this.#db.prepare("DELETE FROM note_topics WHERE topic_id = ?").run(topicId);
        this.#db.prepare("UPDATE topics SET parent_id = ?, updated_at = ? WHERE parent_id = ?").run(topic.parent_id, now, topicId);
        this.#db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);

        if (topic.parent_id) {
            const noteCount = this.#db.prepare(
                `SELECT COUNT(DISTINCT note_id) AS cnt FROM (
                    SELECT id AS note_id FROM notes WHERE primary_topic_id = ?
                    UNION
                    SELECT note_id FROM note_topics WHERE topic_id = ?
                )`
            ).get(topic.parent_id, topic.parent_id)?.cnt || 0;
            this.#db.prepare(
                "UPDATE topics SET note_count = ?, updated_at = ? WHERE id = ?"
            ).run(noteCount, now, topic.parent_id);
        }

        log.info(`Deleted topic ${topicId} for user ${userId}`);
        this.invalidateMapCache(userId);
        return reassigned;
    }

    moveTopic(topicId, newParentId, userId) {
        const topic = this.getTopic(topicId);
        if (!topic) throw new Error("Topic not found");
        if (topic.user_id !== userId) throw new Error("Access denied");
        if (newParentId === topicId) throw new Error("A topic cannot be its own parent");

        if (newParentId) {
            const parent = this.getTopic(newParentId);
            if (!parent || parent.user_id !== userId) {
                throw new Error("New parent topic not found");
            }

            const descendant = this.#db.prepare(
                `WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM topics WHERE parent_id = ?
                    UNION ALL
                    SELECT t.id FROM topics t
                    JOIN subtree s ON t.parent_id = s.id
                )
                SELECT 1 FROM subtree WHERE id = ? LIMIT 1`
            ).get(topicId, newParentId);
            if (descendant) {
                throw new Error("Cannot move a topic into its own subtree");
            }

            const duplicate = this.#db.prepare(
                `SELECT id FROM topics
                 WHERE user_id = ? AND parent_id = ? AND LOWER(name) = LOWER(?) AND id != ?`
            ).get(userId, newParentId, topic.name, topicId);
            if (duplicate) {
                throw new Error(`Topic "${topic.name}" already exists here`);
            }
        } else {
            const duplicate = this.#db.prepare(
                `SELECT id FROM topics
                 WHERE user_id = ? AND parent_id IS NULL AND LOWER(name) = LOWER(?) AND id != ?`
            ).get(userId, topic.name, topicId);
            if (duplicate) {
                throw new Error(`Topic "${topic.name}" already exists here`);
            }
        }

        const subtreeDepth = this.#db.prepare(
            `WITH RECURSIVE subtree(id, depth) AS (
                SELECT id, 0 FROM topics WHERE id = ?
                UNION ALL
                SELECT t.id, subtree.depth + 1
                FROM topics t
                JOIN subtree ON t.parent_id = subtree.id
            )
            SELECT MAX(depth) AS max_depth FROM subtree`
        ).get(topicId)?.max_depth || 0;
        const parentDepth = newParentId ? this.#getTopicDepth(newParentId) + 1 : 0;
        if (parentDepth + subtreeDepth > 2) {
            throw new Error("Topic tree depth limit reached");
        }

        const now = new Date().toISOString();
        this.#db.prepare(
            "UPDATE topics SET parent_id = ?, updated_at = ? WHERE id = ?"
        ).run(newParentId, now, topicId);
        this.invalidateMapCache(userId);
        return this.getTopic(topicId);
    }

    mergeTopics(sourceId, targetId, userId) {
        if (sourceId === targetId) throw new Error("Source and target topics must differ");

        const source = this.getTopic(sourceId);
        const target = this.getTopic(targetId);
        if (!source || source.user_id !== userId) throw new Error("Source topic not found");
        if (!target || target.user_id !== userId) throw new Error("Target topic not found");

        const descendant = this.#db.prepare(
            `WITH RECURSIVE subtree(id) AS (
                SELECT id FROM topics WHERE parent_id = ?
                UNION ALL
                SELECT t.id FROM topics t
                JOIN subtree s ON t.parent_id = s.id
            )
            SELECT 1 FROM subtree WHERE id = ? LIMIT 1`
        ).get(sourceId, targetId);
        if (descendant) {
            throw new Error("Cannot merge a topic into its own subtree");
        }

        const movedNotes = this.#db.prepare(
            `SELECT COUNT(DISTINCT note_id) AS cnt FROM (
                SELECT id AS note_id FROM notes WHERE primary_topic_id = ?
                UNION
                SELECT note_id FROM note_topics WHERE topic_id = ?
            )`
        ).get(sourceId, sourceId)?.cnt || 0;
        const now = new Date().toISOString();

        this.#db.prepare(
            `INSERT OR IGNORE INTO note_topics (note_id, topic_id, is_primary, created_at)
             SELECT note_id, ?, is_primary, created_at
             FROM note_topics WHERE topic_id = ?`
        ).run(targetId, sourceId);
        this.#db.prepare(
            "UPDATE topics SET parent_id = ?, updated_at = ? WHERE parent_id = ?"
        ).run(targetId, now, sourceId);
        this.#db.prepare(
            "UPDATE notes SET primary_topic_id = ?, updated_at = ? WHERE primary_topic_id = ?"
        ).run(targetId, now, sourceId);
        this.#db.prepare("DELETE FROM topics WHERE id = ?").run(sourceId);

        const noteCount = this.#db.prepare(
            `SELECT COUNT(DISTINCT note_id) AS cnt FROM (
                SELECT id AS note_id FROM notes WHERE primary_topic_id = ?
                UNION
                SELECT note_id FROM note_topics WHERE topic_id = ?
            )`
        ).get(targetId, targetId)?.cnt || 0;
        this.#db.prepare(
            "UPDATE topics SET note_count = ?, updated_at = ? WHERE id = ?"
        ).run(noteCount, now, targetId);

        log.info(`Merged topic ${sourceId} into ${targetId} for user ${userId}`);
        this.invalidateMapCache(userId);
        return movedNotes;
    }

    resolveTopicName(userId, name) {
        const trimmedName = String(name || "").trim();
        if (!trimmedName) return null;

        const exact = this.#db.prepare(
            `SELECT * FROM topics
             WHERE user_id = ? AND LOWER(name) = LOWER(?)
             ORDER BY sort_order, name COLLATE NOCASE
             LIMIT 1`
        ).get(userId, trimmedName);
        if (exact) return exact;

        const candidates = this.#db.prepare(
            "SELECT * FROM topics WHERE user_id = ? ORDER BY sort_order, name COLLATE NOCASE"
        ).all(userId);
        const best = candidates
            .map(topic => ({
                topic,
                distance: PkmStore.#levenshtein(topic.name.toLowerCase(), trimmedName.toLowerCase()),
            }))
            .sort((a, b) => a.distance - b.distance || a.topic.name.localeCompare(b.topic.name))[0];

        return best && best.distance <= 2 ? best.topic : null;
    }

    #getTopicDepth(topicId) {
        let depth = 0;
        let currentId = topicId;
        const seen = new Set();

        while (currentId) {
            if (seen.has(currentId)) {
                throw new Error("Topic tree contains a cycle");
            }
            seen.add(currentId);

            const row = this.#db.prepare(
                "SELECT parent_id FROM topics WHERE id = ?"
            ).get(currentId);
            if (!row?.parent_id) break;
            depth += 1;
            currentId = row.parent_id;
        }

        return depth;
    }

    // ── Note-Topic Assignment + Activation ─────────────────

    assignNoteToTopic(noteId, topicId, isPrimary = false) {
        const note = this.getNote(noteId);
        if (!note) throw new Error("Note not found");
        const topic = this.getTopic(topicId);
        if (!topic) throw new Error("Topic not found");
        if (topic.user_id !== note.user_id) throw new Error("Topic and note owner mismatch");

        this.#db.prepare(
            `INSERT OR IGNORE INTO note_topics (note_id, topic_id, is_primary, created_at)
             VALUES (?, ?, ?, datetime('now'))`
        ).run(noteId, topicId, isPrimary ? 1 : 0);

        if (isPrimary) {
            this.#db.prepare(
                "UPDATE note_topics SET is_primary = CASE WHEN topic_id = ? THEN 1 ELSE 0 END WHERE note_id = ?"
            ).run(topicId, noteId);
            this.#db.prepare(
                "UPDATE notes SET primary_topic_id = ?, updated_at = ? WHERE id = ?"
            ).run(topicId, new Date().toISOString(), noteId);
        }

        this.#refreshTopicNoteCount(topicId);
        this.logEvent(noteId, note.user_id, "topic_assigned", { topic_id: topicId, is_primary: !!isPrimary });
        this.invalidateMapCache(note.user_id);
        return true;
    }

    removeNoteFromTopic(noteId, topicId) {
        const note = this.getNote(noteId);
        if (!note) throw new Error("Note not found");
        const topic = this.getTopic(topicId);
        if (!topic) throw new Error("Topic not found");
        if (topic.user_id !== note.user_id) throw new Error("Topic and note owner mismatch");

        this.#db.prepare(
            "DELETE FROM note_topics WHERE note_id = ? AND topic_id = ?"
        ).run(noteId, topicId);

        let nextPrimaryId = note.primary_topic_id;
        if (note.primary_topic_id === topicId) {
            const nextPrimary = this.#db.prepare(
                `SELECT topic_id FROM note_topics
                 WHERE note_id = ?
                 ORDER BY is_primary DESC, created_at ASC
                 LIMIT 1`
            ).get(noteId);
            nextPrimaryId = nextPrimary?.topic_id || null;
            const now = new Date().toISOString();
            this.#db.prepare(
                "UPDATE notes SET primary_topic_id = ?, updated_at = ? WHERE id = ?"
            ).run(nextPrimaryId, now, noteId);
            this.#db.prepare(
                "UPDATE note_topics SET is_primary = CASE WHEN topic_id = ? THEN 1 ELSE 0 END WHERE note_id = ?"
            ).run(nextPrimaryId, noteId);
        }

        this.#refreshTopicNoteCount(topicId);
        this.logEvent(noteId, note.user_id, "topic_removed", { topic_id: topicId, next_primary_topic_id: nextPrimaryId });
        this.invalidateMapCache(note.user_id);
        return true;
    }

    getNoteTopics(noteId) {
        return this.#db.prepare(
            `SELECT t.*, nt.is_primary
             FROM note_topics nt
             JOIN topics t ON t.id = nt.topic_id
             WHERE nt.note_id = ?
             ORDER BY nt.is_primary DESC, t.name COLLATE NOCASE`
        ).all(noteId);
    }

    computeActivation(note) {
        const accessCount = Number(note?.access_count || 0);
        const importance = Number(note?.importance || 0);
        const durability = String(note?.durability || "normal").toLowerCase();
        const decayRate = durability === "permanent"
            ? 0.001
            : durability === "ephemeral"
                ? 0.2
                : 0.05;
        const anchor = note?.last_accessed_at || note?.created_at;
        const anchorMs = anchor ? new Date(anchor).getTime() : Date.now();
        const daysSinceLastAccess = Math.max(0, (Date.now() - anchorMs) / 86400000);
        const floor = durability === "permanent" ? 0.5 : 0.01;
        const activation = Math.log(accessCount + 1) - (decayRate * daysSinceLastAccess) + (importance * 0.5);
        return Math.max(floor, activation);
    }

    trackAccess(noteId) {
        const note = this.getNote(noteId);
        if (!note) return null;

        const now = new Date().toISOString();
        this.#db.prepare(
            `UPDATE notes
             SET last_accessed_at = ?, access_count = COALESCE(access_count, 0) + 1, updated_at = ?
             WHERE id = ?`
        ).run(now, now, noteId);

        const updatedNote = this.getNote(noteId);
        const activation = this.computeActivation(updatedNote);
        this.#db.prepare("UPDATE notes SET activation = ? WHERE id = ?").run(activation, noteId);
        return activation;
    }

    decayAllActivations(userId) {
        const notes = this.#db.prepare(
            `SELECT id, access_count, last_accessed_at, created_at, importance, durability
             FROM notes
             WHERE user_id = ? AND valid_to IS NULL`
        ).all(userId);
        const update = this.#db.prepare("UPDATE notes SET activation = ? WHERE id = ?");
        for (const note of notes) {
            update.run(this.computeActivation(note), note.id);
        }
        log.info(`Decayed activations for ${notes.length} notes (user=${userId})`);
        return notes.length;
    }

    backfillTopics(userId) {
        const notes = this.#db.prepare(
            `SELECT id, title, content, tags
             FROM notes
             WHERE user_id = ? AND valid_to IS NULL AND primary_topic_id IS NULL`
        ).all(userId);
        if (notes.length === 0) return 0;

        const rootTopics = this.getTopics(userId);
        const topicsByName = new Map(rootTopics.map(topic => [topic.name.toLowerCase(), topic]));
        const peopleTopic = topicsByName.get("people") || this.resolveTopicName(userId, "People");
        const homeTopic = topicsByName.get("home") || this.resolveTopicName(userId, "Home");
        const lifeTopic = topicsByName.get("life") || this.resolveTopicName(userId, "Life");
        const entityStmt = this.#db.prepare(
            `SELECT e.name
             FROM entity_notes en
             JOIN entities e ON e.id = en.entity_id
             WHERE en.note_id = ?`
        );

        const peoplePattern = /\b(family|friend|colleague|birthday|meeting)\b/i;
        const homePattern = /\b(home|house|kitchen|bedroom|wifi|appliance|garden|renovation)\b/i;

        let backfilled = 0;
        for (const note of notes) {
            const entityNames = entityStmt.all(note.id).map(entity => entity.name).join(" ");
            const tags = (() => {
                try {
                    return note.tags ? JSON.parse(note.tags) : [];
                } catch {
                    return [];
                }
            })();
            const haystack = [note.title, note.content, Array.isArray(tags) ? tags.join(" ") : note.tags, entityNames]
                .filter(Boolean)
                .join(" ");

            let topic = lifeTopic;
            if (peopleTopic && (entityNames || peoplePattern.test(haystack))) {
                topic = peopleTopic;
            } else if (homeTopic && homePattern.test(haystack)) {
                topic = homeTopic;
            }

            if (!topic) continue;
            this.assignNoteToTopic(note.id, topic.id, true);
            backfilled += 1;
        }

        return backfilled;
    }

    #refreshTopicNoteCount(topicId) {
        if (!topicId) return 0;
        const noteCount = this.#db.prepare(
            `SELECT COUNT(DISTINCT note_id) AS cnt FROM (
                SELECT id AS note_id FROM notes WHERE primary_topic_id = ?
                UNION
                SELECT note_id FROM note_topics WHERE topic_id = ?
            )`
        ).get(topicId, topicId)?.cnt || 0;
        this.#db.prepare(
            "UPDATE topics SET note_count = ?, updated_at = ? WHERE id = ?"
        ).run(noteCount, new Date().toISOString(), topicId);
        return noteCount;
    }

    // ── Collections ─────────────────────────────────────

    createCollection(userId, { name, schema, topicId, description } = {}) {
        const trimmedName = String(name || "").trim();
        if (!trimmedName) throw new Error("Collection name is required");
        if (!schema || typeof schema !== "object" || Array.isArray(schema) || Object.keys(schema).length === 0) {
            throw new Error("Collection schema is required");
        }

        if (topicId) {
            const topic = this.getTopic(topicId);
            if (!topic || topic.user_id !== userId) {
                throw new Error("Topic not found");
            }
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        this.#db.prepare(
            `INSERT INTO collections (id, user_id, topic_id, name, description, schema_json, item_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(id, userId, topicId || null, trimmedName, description || null, JSON.stringify(schema), now, now);
        this.invalidateMapCache(userId);
        return { id, name: trimmedName };
    }

    getCollections(userId) {
        return this.#db.prepare(
            "SELECT * FROM collections WHERE user_id = ? ORDER BY name COLLATE NOCASE"
        ).all(userId);
    }

    getCollection(collectionId) {
        return this.#db.prepare("SELECT * FROM collections WHERE id = ?").get(collectionId) || null;
    }

    addCollectionItem(userId, collectionId, data, title) {
        const collection = this.getCollection(collectionId);
        if (!collection || collection.user_id !== userId) {
            throw new Error("Collection not found");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("Collection item data must be an object");
        }

        const generatedTitle = String(title || "").trim() || (() => {
            const preferred = [data.title, data.name, data.label, data.id]
                .find(value => typeof value === "string" && value.trim());
            if (preferred) return preferred.trim();
            const summary = Object.entries(data)
                .slice(0, 2)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" · ")
                .trim();
            return summary || "Collection item";
        })();

        const result = this.createNote({
            userId,
            type: "collection_item",
            title: generatedTitle.slice(0, 200),
            content: JSON.stringify(data),
            metadata: JSON.stringify(data),
            scope: "user",
        });

        const now = new Date().toISOString();
        this.#db.prepare(
            "UPDATE notes SET collection_id = ?, updated_at = ? WHERE id = ?"
        ).run(collectionId, now, result.id);
        this.#db.prepare(
            "UPDATE collections SET item_count = item_count + 1, updated_at = ? WHERE id = ?"
        ).run(now, collectionId);
        this.invalidateMapCache(userId);
        return result;
    }

    queryCollection(collectionId, userId, { filter, sortBy, limit = 20 } = {}) {
        const collection = this.getCollection(collectionId);
        if (!collection || collection.user_id !== userId) {
            throw new Error("Collection not found");
        }

        const params = [collectionId, userId];
        let sql = "SELECT * FROM notes WHERE collection_id = ? AND user_id = ? AND valid_to IS NULL";

        if (filter && typeof filter === "object" && !Array.isArray(filter)) {
            for (const [key, value] of Object.entries(filter)) {
                if (!/^[A-Za-z0-9_]+$/.test(key)) {
                    throw new Error(`Invalid filter field: ${key}`);
                }
                sql += ` AND json_extract(metadata, '$.${key}') = ?`;
                params.push(value);
            }
        }

        if (sortBy) {
            if (!/^[A-Za-z0-9_]+$/.test(sortBy)) {
                throw new Error(`Invalid sort field: ${sortBy}`);
            }
            sql += ` ORDER BY json_extract(metadata, '$.${sortBy}')`;
        } else {
            sql += " ORDER BY created_at DESC";
        }

        params.push(Number(limit) || 20);
        sql += " LIMIT ?";
        return this.#db.prepare(sql).all(...params);
    }

    updateCollectionItem(itemId, userId, data) {
        const note = this.getNote(itemId);
        if (!note) throw new Error("Note not found");
        if (note.user_id !== userId) throw new Error("Access denied");
        if (note.type !== "collection_item") throw new Error("Note is not a collection item");
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("Collection item data must be an object");
        }

        this.#db.prepare(
            "UPDATE notes SET content = ?, metadata = ?, updated_at = ? WHERE id = ?"
        ).run(JSON.stringify(data), JSON.stringify(data), new Date().toISOString(), itemId);
        return true;
    }

    removeCollectionItem(itemId, userId) {
        const note = this.getNote(itemId);
        if (!note) throw new Error("Note not found");
        if (note.user_id !== userId) throw new Error("Access denied");
        if (note.type !== "collection_item") throw new Error("Note is not a collection item");

        const collectionId = note.collection_id;
        this.secureDelete(itemId, userId);

        if (collectionId) {
            this.#db.prepare(
                "UPDATE collections SET item_count = CASE WHEN item_count > 0 THEN item_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?"
            ).run(new Date().toISOString(), collectionId);
        }

        this.invalidateMapCache(userId);
        return true;
    }

    deleteCollection(collectionId, userId) {
        const collection = this.getCollection(collectionId);
        if (!collection || collection.user_id !== userId) {
            throw new Error("Collection not found");
        }

        const items = this.#db.prepare(
            "SELECT id FROM notes WHERE collection_id = ? AND user_id = ?"
        ).all(collectionId, userId);
        for (const item of items) {
            this.secureDelete(item.id, userId);
        }

        this.#db.prepare("DELETE FROM collections WHERE id = ?").run(collectionId);
        this.invalidateMapCache(userId);
        return items.length;
    }

    // ── Navigation + Map ────────────────────────────────

    browseTopicNotes(topicId, userId, { sort = "activation", limit = 20, includeSecondary = true } = {}) {
        const topic = this.getTopic(topicId);
        if (!topic || topic.user_id !== userId) {
            throw new Error("Topic not found");
        }

        const orderBy = sort === "date"
            ? "n.created_at DESC"
            : sort === "title"
                ? "n.title COLLATE NOCASE"
                : "COALESCE(n.activation, 0) DESC, n.created_at DESC";
        const safeLimit = Number(limit) || 20;

        if (!includeSecondary) {
            return this.#db.prepare(
                `SELECT n.* FROM notes n
                 WHERE n.primary_topic_id = ? AND n.user_id = ? AND n.valid_to IS NULL
                 ORDER BY ${orderBy}
                 LIMIT ?`
            ).all(topicId, userId, safeLimit);
        }

        return this.#db.prepare(
            `SELECT n.*
             FROM notes n
             JOIN (
                 SELECT id FROM notes WHERE primary_topic_id = ?
                 UNION
                 SELECT note_id AS id FROM note_topics WHERE topic_id = ?
             ) matches ON matches.id = n.id
             WHERE n.user_id = ? AND n.valid_to IS NULL
             ORDER BY ${orderBy}
             LIMIT ?`
        ).all(topicId, topicId, userId, safeLimit);
    }

    getNeighbors(noteId, userId, { limit = 10 } = {}) {
        const note = this.getNote(noteId);
        if (!note) throw new Error("Note not found");
        if (note.user_id !== userId) throw new Error("Access denied");

        const rows = this.#db.prepare(`
            SELECT DISTINCT n.id, n.title, n.type, n.activation, 'entity' AS relation_source
            FROM notes n
            JOIN entity_notes en1 ON en1.note_id = n.id
            WHERE en1.entity_id IN (SELECT entity_id FROM entity_notes WHERE note_id = ?)
              AND n.id != ? AND n.user_id = ? AND n.valid_to IS NULL

            UNION ALL

            SELECT DISTINCT n.id, n.title, n.type, n.activation, 'topic' AS relation_source
            FROM notes n
            JOIN note_topics nt1 ON nt1.note_id = n.id
            WHERE nt1.topic_id IN (SELECT topic_id FROM note_topics WHERE note_id = ?)
              AND n.id != ? AND n.user_id = ? AND n.valid_to IS NULL

            UNION ALL

            SELECT DISTINCT n.id, n.title, n.type, n.activation, 'link' AS relation_source
            FROM notes n
            WHERE (n.id IN (SELECT target_id FROM note_links WHERE source_id = ?)
               OR n.id IN (SELECT source_id FROM note_links WHERE target_id = ?))
              AND n.user_id = ? AND n.valid_to IS NULL
        `).all(noteId, noteId, userId, noteId, noteId, userId, noteId, noteId, userId);

        const deduped = [];
        const seen = new Set();
        for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            deduped.push(row);
        }

        return deduped
            .sort((a, b) => (Number(b.activation) || 0) - (Number(a.activation) || 0))
            .slice(0, Number(limit) || 10);
    }

    getTimeline(userId, { period = "week", limit = 12 } = {}) {
        const periodExpr = period === "month"
            ? "substr(created_at, 1, 7)"
            : period === "year"
                ? "substr(created_at, 1, 4)"
                : "strftime('%Y-W%W', created_at)";

        const rows = this.#db.prepare(
            `SELECT ${periodExpr} AS period_key, COUNT(*) as note_count, GROUP_CONCAT(type) as types
             FROM notes
             WHERE user_id = ? AND valid_to IS NULL
             GROUP BY period_key
             ORDER BY period_key DESC
             LIMIT ?`
        ).all(userId, Number(limit) || 12);

        return rows.map(row => ({
            period: row.period_key,
            noteCount: row.note_count,
            types: [...new Set(String(row.types || "").split(",").map(type => type.trim()).filter(Boolean))],
        }));
    }

    getCrossTopicBridges(userId) {
        return this.#db.prepare(`
            SELECT
                t1.id AS topic1_id, t1.name AS topic1_name,
                t2.id AS topic2_id, t2.name AS topic2_name,
                COUNT(DISTINCT nt1.note_id) AS shared_count
            FROM note_topics nt1
            JOIN note_topics nt2 ON nt1.note_id = nt2.note_id AND nt1.topic_id < nt2.topic_id
            JOIN topics t1 ON t1.id = nt1.topic_id
            JOIN topics t2 ON t2.id = nt2.topic_id
            WHERE t1.user_id = ?
            GROUP BY nt1.topic_id, nt2.topic_id
            HAVING shared_count >= 2
            ORDER BY shared_count DESC
            LIMIT 3
        `).all(userId);
    }

    // ── Contradiction detection ────────────────────────────

    /**
     * Detect and handle contradictions for a newly created note.
     * Searches existing active notes of similar type/entities for conflicts.
     * If found, marks the old note as superseded.
     * @param {string} noteId - The newly created note
     * @param {string} userId - Note owner
     * @param {{ type: string, title?: string, content: string, dataType?: string }} noteData
     * @returns {{ superseded: string[] }} IDs of superseded notes
     */
    detectContradictions(noteId, userId, noteData) {
        const superseded = [];

        // Strategy 1: Structured data — same data_type supersedes older readings
        if (noteData.dataType) {
            const older = this.#db.prepare(`
                SELECT n.id FROM notes n
                JOIN structured_data sd ON sd.note_id = n.id
                WHERE sd.user_id = ? AND sd.data_type = ? AND n.id != ? AND n.valid_to IS NULL
                ORDER BY sd.measured_at DESC
            `).all(userId, noteData.dataType, noteId);

            for (const old of older) {
                this.#supersedeNote(old.id, noteId, userId);
                superseded.push(old.id);
            }
            return { superseded };
        }

        // Strategy 2: Preference/fact notes with similar title — newer supersedes older
        if (noteData.type === "preference" || noteData.type === "fact") {
            const titleWords = (noteData.title || "")
                .toLowerCase()
                .split(/\s+/)
                .filter(w => w.length > 3);

            if (titleWords.length >= 2) {
                // Find notes with similar titles (same type, same user, still active)
                const candidates = this.#db.prepare(`
                    SELECT id, title, content FROM notes
                    WHERE user_id = ? AND type = ? AND id != ? AND valid_to IS NULL
                    ORDER BY created_at DESC LIMIT 20
                `).all(userId, noteData.type, noteId);

                for (const cand of candidates) {
                    const candTitleLower = (cand.title || "").toLowerCase();
                    const matchCount = titleWords.filter(w => candTitleLower.includes(w)).length;
                    // If >60% of title words match, it's likely a contradiction
                    if (matchCount >= Math.ceil(titleWords.length * 0.6)) {
                        this.#supersedeNote(cand.id, noteId, userId);
                        superseded.push(cand.id);
                    }
                }
            }
        }

        return { superseded };
    }

    /** Mark a note as superseded by another */
    #supersedeNote(oldNoteId, newNoteId, userId) {
        const now = new Date().toISOString();
        this.#db.prepare(
            `UPDATE notes SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?`
        ).run(now, newNoteId, now, oldNoteId);
        this.logEvent(oldNoteId, userId, "superseded", { superseded_by: newNoteId });
        log.info(`Note ${oldNoteId} superseded by ${newNoteId}`);
    }
}

export default PkmStore;
