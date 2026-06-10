import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.mjs";

const log = createLogger("control-store");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scope_grants (
    scope_key   TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    grant_key   TEXT NOT NULL,
    granted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (scope_key, user_id, grant_key)
);

CREATE TABLE IF NOT EXISTS approval_log (
    id             TEXT PRIMARY KEY,
    scope_key      TEXT NOT NULL,
    actor_id       TEXT NOT NULL,
    actor_type     TEXT NOT NULL,
    tool           TEXT NOT NULL,
    entity_id      TEXT,
    action_class   TEXT NOT NULL,
    decision       TEXT NOT NULL,
    decided_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    correlation_id TEXT,
    details_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_log_scope ON approval_log(scope_key, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_log_actor ON approval_log(actor_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS pending_questions (
    id          TEXT PRIMARY KEY,
    scope_key   TEXT NOT NULL,
    chat_id     TEXT NOT NULL,
    thread_id   TEXT,
    message     TEXT NOT NULL,
    options     TEXT,
    message_id  TEXT,
    free_text   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webui_principals (
    principal_id     TEXT PRIMARY KEY,
    principal_source TEXT NOT NULL,
    scope_key        TEXT NOT NULL UNIQUE,
    username         TEXT,
    display_name     TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export class ControlPlaneStore {
    #dbPath;
    #db;

    constructor(dbPath = "/data/control-plane.db") {
        this.#dbPath = dbPath;
        this.#db = new DatabaseSync(this.#dbPath);
        this.#db.exec("PRAGMA journal_mode = WAL");
        this.#db.exec("PRAGMA busy_timeout = 5000");
        this.#db.exec(SCHEMA_SQL);
        log.info(`Control plane store ready: ${this.#dbPath}`);
    }

    close() {
        this.#db?.close();
    }

    grantScope(scopeKey, userId, grantKey) {
        this.#db.prepare(`
            INSERT OR REPLACE INTO scope_grants(scope_key, user_id, grant_key, granted_at)
            VALUES (?, ?, ?, unixepoch())
        `).run(String(scopeKey), String(userId), String(grantKey));
    }

    hasScopeGrant(scopeKey, userId, grantKey) {
        const row = this.#db.prepare(`
            SELECT 1 AS found
            FROM scope_grants
            WHERE scope_key = ? AND user_id = ? AND grant_key = ?
            LIMIT 1
        `).get(String(scopeKey), String(userId), String(grantKey));
        return !!row?.found;
    }

    logApproval({
        id = randomUUID(),
        scopeKey,
        actorId,
        actorType,
        tool,
        entityId = null,
        actionClass,
        decision,
        correlationId = null,
        details = null,
    }) {
        this.#db.prepare(`
            INSERT INTO approval_log(
                id, scope_key, actor_id, actor_type, tool, entity_id,
                action_class, decision, decided_at, correlation_id, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?)
        `).run(
            String(id),
            String(scopeKey),
            String(actorId),
            String(actorType),
            String(tool),
            entityId == null ? null : String(entityId),
            String(actionClass),
            String(decision),
            correlationId == null ? null : String(correlationId),
            details == null ? null : JSON.stringify(details),
        );
        return id;
    }

    savePendingQuestion({
        id,
        scopeKey,
        chatId,
        threadId = null,
        message,
        options = [],
        messageId = null,
        freeText = false,
        expiresAt,
    }) {
        this.#db.prepare(`
            INSERT OR REPLACE INTO pending_questions(
                id, scope_key, chat_id, thread_id, message, options, message_id,
                free_text, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
        `).run(
            String(id),
            String(scopeKey),
            String(chatId),
            threadId == null ? null : String(threadId),
            String(message),
            JSON.stringify(options || []),
            messageId == null ? null : String(messageId),
            freeText ? 1 : 0,
            Number(expiresAt),
        );
    }

    updatePendingQuestionMessageId(id, messageId) {
        this.#db.prepare(`
            UPDATE pending_questions
            SET message_id = ?
            WHERE id = ?
        `).run(messageId == null ? null : String(messageId), String(id));
    }

    removePendingQuestion(id) {
        this.#db.prepare(`DELETE FROM pending_questions WHERE id = ?`).run(String(id));
    }

    drainPendingQuestions() {
        const rows = this.#db.prepare(`
            SELECT id, scope_key, chat_id, thread_id, message, options, message_id, free_text, created_at, expires_at
            FROM pending_questions
            ORDER BY created_at ASC
        `).all();
        this.#db.exec(`DELETE FROM pending_questions`);
        return rows.map((row) => ({
            ...row,
            options: row.options ? JSON.parse(row.options) : [],
            free_text: !!row.free_text,
        }));
    }

    resolveWebuiPrincipal({ haUserId, username = null, displayName = null }) {
        const principalId = String(haUserId);
        const existing = this.#db.prepare(`
            SELECT principal_id, principal_source, scope_key, username, display_name, created_at, last_active_at
            FROM webui_principals
            WHERE principal_id = ?
        `).get(principalId);
        const scopeKey = existing?.scope_key || `webui:u:${principalId}`;
        this.#db.prepare(`
            INSERT INTO webui_principals(
                principal_id, principal_source, scope_key, username, display_name, created_at, last_active_at
            ) VALUES (?, 'ha_ingress', ?, ?, ?, unixepoch(), unixepoch())
            ON CONFLICT(principal_id) DO UPDATE SET
                username = excluded.username,
                display_name = excluded.display_name,
                last_active_at = unixepoch()
        `).run(principalId, scopeKey, username, displayName);
        return {
            principalId,
            actorType: "webui",
            principalSource: "ha_ingress",
            scopeKey,
            username,
            displayName,
        };
    }
}
