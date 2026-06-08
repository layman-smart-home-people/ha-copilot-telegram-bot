// ============================================================
// PoolInstance — State container for a single ACP CLI process
// ============================================================

export class PoolInstance {
    constructor({ id, acp, model, mcpProfile, copilotHome }) {
        this.id = id;
        this.acp = acp;
        this.state = "booting";       // booting | idle | claimed | draining | dead
        this.model = model;           // fast | standard | reasoning
        this.mcpProfile = mcpProfile; // owner | guest
        this.claimedBy = null;        // scopeKey or null
        this.copilotHome = copilotHome;
        this.sessionId = null;

        // Timing
        this.createdAt = Date.now();
        this.lastActiveAt = Date.now();
        this.claimedAt = null;
        this.idleTimer = null;

        // Metrics
        this.promptsServed = 0;
        this.totalPromptMs = 0;
        this.crashes = 0;
        this.rssBytes = 0;
    }

    get pid() {
        return this.acp?.pid ?? null;
    }

    get alive() {
        return this.acp?.alive ?? false;
    }

    get uptimeMs() {
        return Date.now() - this.createdAt;
    }

    get idleSinceMs() {
        return this.state === "idle" ? Date.now() - this.lastActiveAt : null;
    }

    /** Record a prompt served. */
    recordPrompt(durationMs) {
        this.promptsServed++;
        this.totalPromptMs += durationMs;
        this.lastActiveAt = Date.now();
    }

    /** Serializable status snapshot. */
    toStatus() {
        return {
            id: this.id,
            state: this.state,
            model: this.model,
            mcpProfile: this.mcpProfile,
            claimedBy: this.claimedBy,
            uptimeMs: this.uptimeMs,
            idleSinceMs: this.idleSinceMs,
            promptsServed: this.promptsServed,
            rssBytes: this.rssBytes,
            pid: this.pid,
        };
    }
}
