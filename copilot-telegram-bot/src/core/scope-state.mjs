// ============================================================
// ScopeState — Per-scope conversation/session container
// ============================================================
// Keeps Telegram/Copilot runtime state isolated per scope:
// - DM per user
// - Group per chat
// - Forum per topic

import { ChatHistory } from "./history.mjs";
import { normalizeModeId } from "../ai/copilot/acp-client.mjs";

const HISTORY_MAX = 50;

function toolGrantKey(userId, toolName) {
    const numericUserId = Number(userId);
    return Number.isSafeInteger(numericUserId) ? `${numericUserId}:${toolName}` : null;
}

export class ScopeState {
    constructor(scopeKey) {
        this.key = scopeKey;

        // ACP session
        this.sessionId = null;

        // Conversation history
        this.history = new ChatHistory(HISTORY_MAX);

        // Active response composer for the current prompt
        this.composer = null;

        // Preamble
        this.preambleSent = false;

        // Permission grants are isolated by user within the same scope
        this.grantedTools = new Set();

        // toolCallId -> { name, description }
        this.activeTools = new Map();

        // Streaming message accumulation
        this.messageBuffer = "";
        this.messageFlushTimer = null;

        // Turn-level tracking
        this.turnToolCount = 0;
        this.turnToolErrors = 0;
        this.lastBotMessageId = null;

        // ACP-side per-session settings
        this.model = "";
        this.mode = "";

        // Scope-local allow-all toggle
        this.allowAll = false;

        // Pending elicitation/ask_user state — set when waiting for user input
        // Shape: { requestId, propName, schema, resolve } or { reserved: true } or null
        this.pendingElicitation = null;

        // Newline injection flags — signal that a newline should be added
        // before the next text/thought chunk following a tool call
        this._toolJustEnded = false;
        this._toolJustEndedThought = false;

        // Per-scope prompt serialization
        this.promptQueue = [];       // queued prompts for this scope
        this.promptRunning = false;  // true while this scope's prompt is in-flight
        this.activeRef = null;       // conversation ref for current prompt / UDS resolution
        this.acpTag = null;          // 'primary' | 'overflow' | null

        // Activity tracking for LRU eviction
        this.lastActivity = Date.now();

        // Creation timestamp
        this.createdAt = Date.now();
    }

    /** Update the last-activity timestamp. */
    touch() {
        this.lastActivity = Date.now();
    }

    /**
     * Reset transient scope state for a fresh session.
     * Keeps the scope key and sessionId intact so callers can overwrite
     * sessionId immediately after creating a new ACP session.
     */
    reset() {
        this.preambleSent = false;
        this.grantedTools.clear();
        this.activeTools.clear();
        this.messageBuffer = "";

        if (this.messageFlushTimer) {
            clearTimeout(this.messageFlushTimer);
            this.messageFlushTimer = null;
        }

        this.turnToolCount = 0;
        this.turnToolErrors = 0;
        this.lastBotMessageId = null;
        this._toolJustEnded = false;
        this._toolJustEndedThought = false;

        // Clean up per-scope prompt state
        this.promptRunning = false;
        this.activeRef = null;
        this.acpTag = null;
        for (const entry of this.promptQueue) {
            // Resolve any pending promises with undefined
            if (typeof entry.reject === "function") entry.reject(new Error("Scope reset"));
        }
        this.promptQueue = [];

        // Clean up pending elicitation/ask_user promises
        if (this.pendingElicitation) {
            if (typeof this.pendingElicitation.resolve === "function") {
                this.pendingElicitation.resolve(undefined);
            }
            this.pendingElicitation = null;
        }

        if (this.composer?.active) {
            this.composer = null;
        }

        this.history.clear();
        this.touch();
    }

    /** Serialize only the fields that must survive restart. */
    toJSON() {
        return {
            key: this.key,
            sessionId: this.sessionId,
            model: this.model,
            mode: this.mode,
            allowAll: this.allowAll,
            lastActivity: this.lastActivity,
            createdAt: this.createdAt,
        };
    }

    /** Restore a scope from persisted JSON. */
    static fromJSON(data) {
        const scope = new ScopeState(data.key);
        scope.sessionId = data.sessionId ?? null;
        scope.model = data.model ?? "";
        scope.mode = normalizeModeId(data.mode ?? "");
        scope.allowAll = Boolean(data.allowAll);
        scope.lastActivity = data.lastActivity ?? Date.now();
        scope.createdAt = data.createdAt ?? Date.now();
        return scope;
    }

    /** Check whether a tool is granted for a specific user in this scope. */
    isToolGranted(userId, toolName) {
        const key = toolGrantKey(userId, toolName);
        return key ? this.grantedTools.has(key) : false;
    }

    /** Grant a tool for a specific user in this scope. */
    grantTool(userId, toolName) {
        const key = toolGrantKey(userId, toolName);
        if (key) this.grantedTools.add(key);
    }
}
