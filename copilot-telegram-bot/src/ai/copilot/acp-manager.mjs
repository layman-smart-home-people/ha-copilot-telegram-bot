// ============================================================
// ACPManager — Manages primary + overflow ACP processes
// ============================================================
// Provides isolated ACP instances for concurrent multi-user support.
// Primary is always alive while bot is running.
// Overflow is spawned on demand when primary is busy, reaped after idle.

import { ACPClient } from "./acp-client.mjs";
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../logger.mjs";

const OVERFLOW_SPAWN_COOLDOWN_MS = 5000; // min time between overflow spawns
const log = createLogger("acp-mgr");

export class ACPManager {
    #primaryAcp = null;
    #overflowAcp = null;
    #config;

    // Which scope key each ACP is currently serving (null = idle)
    #primaryScopeKey = null;
    #overflowScopeKey = null;

    // Overflow lifecycle
    #overflowEnabled;
    #overflowIdleMs;
    #overflowIdleTimer = null;
    #overflowLastSpawn = 0;
    #overflowStartPromise = null;

    // Overflow config overrides
    #overflowMcpServers;
    #overflowExtraArgs;
    #backgroundModel;

    // COPILOT_HOME paths
    #primaryHome;
    #overflowHome;

    // Auth state
    #authenticated = false;

    // Callback when overflow is spawned
    #onOverflowSpawned = null;

    constructor({ config, overflowEnabled = false, overflowIdleMinutes = 5,
        overflowMcpServers, overflowExtraArgs, backgroundModel }) {
        this.#config = config;
        this.#overflowEnabled = overflowEnabled;
        this.#overflowIdleMs = overflowIdleMinutes * 60 * 1000;
        this.#backgroundModel = backgroundModel || "";

        // Overflow MCP config: default to si-tools only (no tg-ux, no rbac-tools)
        // RBAC tools excluded: overflow uses --allow-all, bypassing permission checks.
        // Including rbac-tools would allow privilege escalation via background_task.
        this.#overflowMcpServers = overflowMcpServers || {
            "si-tools": {
                type: "stdio",
                command: "node",
                args: ["/app/src/ai/copilot/si-mcp-server.mjs"],
            },
        };

        // Overflow extra args: restrict to MCP tools, no shell.
        // No shell quotes needed — args are passed directly via spawn (no shell expansion).
        this.#overflowExtraArgs = overflowExtraArgs ||
            "--allow-tool=mcp(*) --deny-tool=shell";

        this.#primaryHome = config.copilotConfigDir;
        this.#overflowHome = config.copilotConfigDir + "-overflow";
    }

    get primary() { return this.#primaryAcp; }
    get overflow() { return this.#overflowAcp; }
    get overflowEnabled() { return this.#overflowEnabled; }
    set overflowEnabled(v) { this.#overflowEnabled = !!v; }
    get overflowAlive() { return this.#overflowAcp?.alive ?? false; }
    get primaryScopeKey() { return this.#primaryScopeKey; }
    get overflowScopeKey() { return this.#overflowScopeKey; }
    get authenticated() { return this.#authenticated; }

    /** Register callback to wire overflow event handlers after spawn. */
    set onOverflowSpawned(fn) { this.#onOverflowSpawned = fn; }

    /** Create the primary ACP client (does not start it). */
    createPrimary() {
        this.#primaryAcp = new ACPClient({
            binary: this.#config.copilotBinary,
            cwd: this.#config.workingDirectory,
            model: this.#config.model,
            extraArgs: this.#config.copilotExtraArgs,
            copilotHome: this.#primaryHome,
            permissionPolicy: this.#config.permissionPolicy || "interactive",
        });
        return this.#primaryAcp;
    }

    /**
     * Try to acquire an ACP instance for a scope.
     * Returns { acp, tag: 'primary'|'overflow' } or null if none available.
     * Does NOT spawn overflow — use acquireOrSpawn for that.
     */
    tryAcquire(scopeKey) {
        // If primary is serving this scope or idle → use primary
        if (this.#primaryScopeKey === null || this.#primaryScopeKey === scopeKey) {
            return { acp: this.#primaryAcp, tag: "primary" };
        }

        // If overflow is enabled and serving this scope or idle
        if (this.#overflowEnabled && this.#overflowAcp?.alive) {
            if (this.#overflowScopeKey === null || this.#overflowScopeKey === scopeKey) {
                this.#clearOverflowIdleTimer();
                return { acp: this.#overflowAcp, tag: "overflow" };
            }
        }

        // Both busy with different scopes
        return null;
    }

    /**
     * Try to acquire, spawning overflow if needed.
     * Returns { acp, tag } or null if both are busy.
     */
    async acquireOrSpawn(scopeKey) {
        const result = this.tryAcquire(scopeKey);
        if (result) return result;

        // Primary is busy with another scope. Try overflow.
        if (!this.#overflowEnabled) return null;

        // Overflow exists but busy with yet another scope
        if (this.#overflowAcp?.alive && this.#overflowScopeKey !== null) {
            return null;
        }

        // Spawn overflow
        try {
            await this.#spawnOverflow();
            return { acp: this.#overflowAcp, tag: "overflow" };
        } catch (err) {
            log.warn(`Overflow spawn failed: ${err.message}`);
            return null;
        }
    }

    /** Mark an ACP as busy with a scope. */
    claim(tag, scopeKey) {
        if (tag === "primary") {
            this.#primaryScopeKey = scopeKey;
        } else {
            this.#overflowScopeKey = scopeKey;
            this.#clearOverflowIdleTimer();
        }
    }

    /** Mark an ACP as idle (done with its scope's prompt). */
    release(tag) {
        if (tag === "primary") {
            this.#primaryScopeKey = null;
        } else {
            this.#overflowScopeKey = null;
            this.#resetOverflowIdleTimer();
        }
    }

    /** Check if a specific ACP tag is busy. */
    isBusy(tag) {
        return tag === "primary"
            ? this.#primaryScopeKey !== null
            : this.#overflowScopeKey !== null;
    }

    /** Get the scope key an ACP is serving. */
    getScopeKey(tag) {
        return tag === "primary" ? this.#primaryScopeKey : this.#overflowScopeKey;
    }

    /** Get the ACP instance by tag. */
    getAcp(tag) {
        return tag === "primary" ? this.#primaryAcp : this.#overflowAcp;
    }

    setAuthenticated(val) {
        this.#authenticated = !!val;
    }

    // --- Overflow lifecycle ---

    async #spawnOverflow() {
        if (this.#overflowAcp?.alive) return;

        // Cooldown check
        const now = Date.now();
        if (now - this.#overflowLastSpawn < OVERFLOW_SPAWN_COOLDOWN_MS) {
            throw new Error("Overflow spawn cooldown");
        }

        // Deduplicate concurrent spawn calls
        if (this.#overflowStartPromise) {
            return this.#overflowStartPromise;
        }

        this.#overflowStartPromise = this.#doSpawnOverflow();
        try {
            await this.#overflowStartPromise;
        } finally {
            this.#overflowStartPromise = null;
        }
    }

    async #doSpawnOverflow() {
        log.info("Spawning overflow ACP process...");
        this.#overflowLastSpawn = Date.now();

        // Prepare isolated COPILOT_HOME
        this.#prepareOverflowHome();

        // Build overflow-specific extra args: base config args + overflow restrictions
        const baseExtra = this.#config.copilotExtraArgs || "";
        const overflowExtra = [baseExtra, this.#overflowExtraArgs].filter(Boolean).join(" ");

        this.#overflowAcp = new ACPClient({
            binary: this.#config.copilotBinary,
            cwd: this.#config.workingDirectory,
            model: this.#backgroundModel || this.#config.model,
            extraArgs: overflowExtra,
            copilotHome: this.#overflowHome,
            permissionPolicy: "allow_all",  // no interactive user for overflow
            stdioMcpServers: this.#overflowMcpServers,
            tag: "overflow",
        });

        // Wire exit handler to clean up
        this.#overflowAcp.on("exit", ({ code, signal }) => {
            log.info(`Overflow ACP exited: code=${code} signal=${signal}`);
            this.#overflowScopeKey = null;
            this.#clearOverflowIdleTimer();
        });

        this.#overflowAcp.on("log", (text) => {
            log.debug(`ACP[overflow]: ${text}`);
        });

        try {
            await this.#overflowAcp.start();

            // Authenticate overflow
            try {
                await this.#overflowAcp.authenticate();
                log.info("Overflow ACP authenticated");
            } catch (err) {
                if (err.message?.includes("Authentication required") || err.message?.includes("-32000")) {
                    log.warn("Overflow auth failed — will fall back to primary queue");
                    await this.#overflowAcp.stop();
                    this.#overflowAcp = null;
                    throw new Error("Overflow authentication failed — no token available");
                }
                throw err;
            }

            // Create initial session
            await new Promise(r => setTimeout(r, 300));
            await this.#overflowAcp.newSession({
                cwd: this.#config.workingDirectory || "/config",
            });

            log.info(`Overflow ACP started, session: ${this.#overflowAcp.sessionId}`);

            // Notify orchestrator to wire event handlers
            if (this.#onOverflowSpawned) {
                this.#onOverflowSpawned(this.#overflowAcp);
            }
        } catch (err) {
            try { await this.#overflowAcp?.stop(); } catch {}
            this.#overflowAcp = null;
            throw err;
        }
    }

    /** Prepare isolated COPILOT_HOME for overflow. */
    #prepareOverflowHome() {
        if (!existsSync(this.#overflowHome)) {
            mkdirSync(this.#overflowHome, { recursive: true });
        }

        // Copy auth tokens from primary's config.json
        const primaryConfig = join(this.#primaryHome, "config.json");
        const overflowConfig = join(this.#overflowHome, "config.json");
        if (existsSync(primaryConfig)) {
            try {
                copyFileSync(primaryConfig, overflowConfig);
                log.debug("Copied auth config to overflow COPILOT_HOME");
            } catch (err) {
                log.warn(`Failed to copy auth config: ${err.message}`);
            }
        }

        // Copy MCP config if present
        for (const name of ["mcp-config.json", "mcp.json"]) {
            const src = join(this.#primaryHome, name);
            const dst = join(this.#overflowHome, name);
            if (existsSync(src)) {
                try { copyFileSync(src, dst); } catch {}
            }
        }

        // Copy settings.json
        const srcSettings = join(this.#primaryHome, "settings.json");
        const dstSettings = join(this.#overflowHome, "settings.json");
        if (existsSync(srcSettings)) {
            try { copyFileSync(srcSettings, dstSettings); } catch {}
        }
    }

    /**
     * Ensure overflow ACP is alive (spawn if needed).
     * Does NOT acquire/claim — caller must claim/release manually.
     * @returns {ACPClient|null} The overflow ACP instance, or null if unavailable.
     */
    async ensureOverflow() {
        if (!this.#overflowEnabled) return null;
        if (this.#overflowAcp?.alive) return this.#overflowAcp;
        try {
            await this.#spawnOverflow();
            return this.#overflowAcp;
        } catch (err) {
            log.warn(`Failed to ensure overflow: ${err.message}`);
            return null;
        }
    }

    /** Stop the overflow process. */
    async reapOverflow() {
        this.#clearOverflowIdleTimer();
        if (!this.#overflowAcp) return;

        // Don't reap while busy
        if (this.#overflowScopeKey !== null) {
            log.debug("Overflow reap deferred — still busy");
            this.#resetOverflowIdleTimer();
            return;
        }

        log.info("Reaping overflow ACP process...");
        try {
            this.#overflowAcp.removeAllListeners();
            await this.#overflowAcp.stop();
        } catch (err) {
            log.warn(`Overflow reap error: ${err.message}`);
        }
        this.#overflowAcp = null;
        this.#overflowScopeKey = null;
    }

    #resetOverflowIdleTimer() {
        this.#clearOverflowIdleTimer();
        if (this.#overflowIdleMs <= 0) return;
        if (!this.#overflowAcp?.alive) return;

        this.#overflowIdleTimer = setTimeout(() => {
            log.info("Overflow idle timeout — reaping");
            this.reapOverflow().catch(err => {
                log.warn(`Overflow reap error: ${err.message}`);
            });
        }, this.#overflowIdleMs);
        this.#overflowIdleTimer.unref?.();
    }

    #clearOverflowIdleTimer() {
        if (this.#overflowIdleTimer) {
            clearTimeout(this.#overflowIdleTimer);
            this.#overflowIdleTimer = null;
        }
    }

    /** Stop all ACP processes. */
    async stopAll() {
        this.#clearOverflowIdleTimer();
        const promises = [];
        if (this.#overflowAcp) {
            this.#overflowAcp.removeAllListeners();
            promises.push(this.#overflowAcp.stop().catch(() => {}));
            this.#overflowAcp = null;
        }
        if (this.#primaryAcp) {
            promises.push(this.#primaryAcp.stop().catch(() => {}));
        }
        await Promise.allSettled(promises);
        this.#primaryScopeKey = null;
        this.#overflowScopeKey = null;
        this.#authenticated = false;
    }

    /** Status info for /status command. */
    status() {
        return {
            primaryAlive: this.#primaryAcp?.alive ?? false,
            primarySessionId: this.#primaryAcp?.sessionId ?? null,
            primaryScope: this.#primaryScopeKey,
            overflowEnabled: this.#overflowEnabled,
            overflowAlive: this.#overflowAcp?.alive ?? false,
            overflowSessionId: this.#overflowAcp?.sessionId ?? null,
            overflowScope: this.#overflowScopeKey,
        };
    }
}
