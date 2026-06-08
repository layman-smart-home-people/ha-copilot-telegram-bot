// ============================================================
// ACPPool — N-instance Copilot CLI pool with model routing
// ============================================================
// Replaces ACPManager (2-slot) with a configurable N-slot pool.
// Each instance has isolated COPILOT_HOME, model via settings.json,
// and MCP servers determined by permission profile (owner/guest).

import { EventEmitter } from "node:events";
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ACPClient } from "../ai/copilot/acp-client.mjs";
import { PoolInstance } from "./pool-instance.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger("pool");

// Models settable via settings.json in COPILOT_HOME
const MODEL_PROFILES = {
    fast:      { model: "claude-haiku-4.5" },
    standard:  { model: "claude-sonnet-4.5" },
    reasoning: { model: "claude-opus-4.6" },
};

/** Error thrown when pool is exhausted and wait queue times out. */
export class PoolExhaustedError extends Error {
    constructor(msg = "All instances busy. Try again in a moment.") {
        super(msg);
        this.name = "PoolExhaustedError";
    }
}

export class ACPPool extends EventEmitter {
    #instances = new Map();    // instanceId → PoolInstance
    #waitQueue = [];           // { scopeKey, model, mcpProfile, resolve, reject, timer }
    #nextId = 0;
    #healthInterval = null;

    // Config
    #maxSize;
    #preWarmCount;
    #idleTimeoutMs;
    #spawnCooldownMs;
    #waitTimeoutMs;
    #lastSpawnTime = 0;

    // Dependencies
    #config;                   // bot config object
    #mcpProfiles;              // { owner: { mcpServers }, guest: { mcpServers } }
    #baseCopilotHome;          // /tmp/copilot-pool
    #primaryAuthHome;          // primary COPILOT_HOME with auth tokens

    constructor({ config, mcpProfiles }) {
        super();
        this.#config = config;
        this.#mcpProfiles = mcpProfiles || {};

        // Pool sizing
        this.#maxSize = Math.min(Math.max(config.poolSize || 5, 1), 10);
        this.#preWarmCount = Math.min(config.poolPreWarm ?? 1, this.#maxSize);
        this.#idleTimeoutMs = (config.poolIdleMinutes || 5) * 60_000;
        this.#spawnCooldownMs = 5000;
        this.#waitTimeoutMs = (config.poolWaitTimeoutSeconds || 30) * 1000;

        // Paths
        this.#baseCopilotHome = "/tmp/copilot-pool";
        this.#primaryAuthHome = config.copilotConfigDir;
    }

    // ── Public API ───────────────────────────────────────────

    /** Boot the pool: create base dir, pre-warm instances, start health checks. */
    async boot() {
        log.info(`Pool booting: maxSize=${this.#maxSize} preWarm=${this.#preWarmCount} ` +
                 `idleTimeout=${this.#idleTimeoutMs / 1000}s`);

        mkdirSync(this.#baseCopilotHome, { recursive: true });

        // Pre-warm instances in parallel
        if (this.#preWarmCount > 0) {
            const defaultModel = this.#resolveModelTier(this.#config.defaultModel);
            const promises = Array.from({ length: this.#preWarmCount }, (_, i) =>
                this.#spawn(defaultModel, "owner")
                    .then(inst => log.info(`Pre-warm ${i + 1}/${this.#preWarmCount}: ${inst.id} ready`))
                    .catch(err => log.warn(`Pre-warm ${i + 1} failed: ${err.message}`))
            );
            await Promise.allSettled(promises);
        }

        // Start health check interval
        this.#healthInterval = setInterval(() => this.#healthCheck(), 60_000);
        this.#healthInterval.unref?.();

        log.info(`Pool ready: ${this.#countByState("idle")} idle, ${this.#instances.size} total`);
    }

    /** Gracefully shut down all instances. */
    async shutdown() {
        log.info("Pool shutting down...");
        if (this.#healthInterval) {
            clearInterval(this.#healthInterval);
            this.#healthInterval = null;
        }

        // Reject all waiters
        for (const entry of this.#waitQueue) {
            clearTimeout(entry.timer);
            entry.reject(new Error("Pool shutting down"));
        }
        this.#waitQueue.length = 0;

        // Stop all instances in parallel
        const stopPromises = [];
        for (const inst of this.#instances.values()) {
            inst.state = "draining";
            if (inst.idleTimer) clearTimeout(inst.idleTimer);
            if (inst.acp?.alive) {
                inst.acp.removeAllListeners();
                stopPromises.push(inst.acp.stop().catch(() => {}));
            }
        }
        await Promise.allSettled(stopPromises);

        // Clean up all COPILOT_HOME dirs
        try { rmSync(this.#baseCopilotHome, { recursive: true, force: true }); } catch {}
        this.#instances.clear();
        log.info("Pool shutdown complete");
    }

    /**
     * Acquire a pool instance for a scope.
     * @param {string} scopeKey — conversation scope identifier
     * @param {{ model?: string, mcpProfile?: string }} options
     * @returns {Promise<PoolInstance>}
     * @throws {PoolExhaustedError} if pool is full and wait times out
     */
    async acquire(scopeKey, { model = "standard", mcpProfile = "owner" } = {}) {
        const tier = this.#resolveModelTier(model);

        // 1. STICKY — already claimed by this scope
        for (const inst of this.#instances.values()) {
            if (inst.claimedBy === scopeKey && inst.state === "claimed") {
                return inst;
            }
        }

        // 2. MATCHING IDLE — same model + mcpProfile
        for (const inst of this.#instances.values()) {
            if (inst.state === "idle" && inst.model === tier && inst.mcpProfile === mcpProfile) {
                this.#claim(inst, scopeKey);
                return inst;
            }
        }

        // 3. SPAWN — under maxSize
        if (this.#instances.size < this.#maxSize) {
            const inst = await this.#spawn(tier, mcpProfile);
            this.#claim(inst, scopeKey);
            return inst;
        }

        // 4. REUSE IDLE (different model, same profile) — requires restart
        for (const inst of this.#instances.values()) {
            if (inst.state === "idle" && inst.mcpProfile === mcpProfile) {
                await this.#reconfigure(inst, tier);
                this.#claim(inst, scopeKey);
                return inst;
            }
        }

        // 5. EVICT — oldest idle (any profile)
        const evictable = this.#findOldestIdle();
        if (evictable) {
            await this.#evict(evictable);
            const inst = await this.#spawn(tier, mcpProfile);
            this.#claim(inst, scopeKey);
            return inst;
        }

        // 6. WAIT — queue with timeout
        return this.#waitForSlot(scopeKey, tier, mcpProfile);
    }

    /** Release an instance back to the pool (conversation done or idle). */
    release(instanceId) {
        const inst = this.#instances.get(instanceId);
        if (!inst || inst.state !== "claimed") return;

        inst.claimedBy = null;
        inst.claimedAt = null;
        inst.state = "idle";
        inst.lastActiveAt = Date.now();
        log.debug(`Released ${instanceId}`);

        // Check wait queue first — give slot to a waiter before starting idle timer
        if (this.#drainWaitQueue()) return;

        this.#startIdleTimer(inst);
    }

    /** Gracefully drain a specific instance (admin action). */
    async drain(instanceId) {
        const inst = this.#instances.get(instanceId);
        if (!inst) return;
        log.info(`Draining instance ${instanceId}`);
        inst.state = "draining";
        if (inst.idleTimer) clearTimeout(inst.idleTimer);
        await this.#stopAndCleanup(inst);
    }

    /** Pool status for /status command and WebUI. */
    status() {
        const instances = [...this.#instances.values()].map(i => i.toStatus());
        return {
            maxSize: this.#maxSize,
            total: this.#instances.size,
            claimed: this.#countByState("claimed"),
            idle: this.#countByState("idle"),
            booting: this.#countByState("booting"),
            waitQueueLength: this.#waitQueue.length,
            instances,
        };
    }

    /** Get aggregate metrics. */
    getMetrics() {
        let totalPrompts = 0, totalMs = 0, totalCrashes = 0, totalRss = 0;
        for (const inst of this.#instances.values()) {
            totalPrompts += inst.promptsServed;
            totalMs += inst.totalPromptMs;
            totalCrashes += inst.crashes;
            totalRss += inst.rssBytes;
        }
        return { totalPrompts, totalMs, totalCrashes, totalRss, instanceCount: this.#instances.size };
    }

    // ── Private: Spawn & Lifecycle ───────────────────────────

    async #spawn(modelTier, mcpProfile) {
        const now = Date.now();
        if (now - this.#lastSpawnTime < this.#spawnCooldownMs) {
            await new Promise(r => setTimeout(r, this.#spawnCooldownMs - (now - this.#lastSpawnTime)));
        }
        this.#lastSpawnTime = Date.now();

        const id = `pool-${++this.#nextId}`;
        const home = join(this.#baseCopilotHome, id);
        log.info(`Spawning ${id}: model=${modelTier} profile=${mcpProfile}`);

        // 1. Create isolated COPILOT_HOME
        mkdirSync(home, { recursive: true });

        // 2. Copy auth tokens
        const srcConfig = join(this.#primaryAuthHome, "config.json");
        if (existsSync(srcConfig)) {
            copyFileSync(srcConfig, join(home, "config.json"));
        }

        // 3. Write model settings
        const modelConfig = MODEL_PROFILES[modelTier] || MODEL_PROFILES.standard;
        writeFileSync(join(home, "settings.json"), JSON.stringify(modelConfig));

        // 4. Build MCP server config for this profile
        const profileConfig = this.#mcpProfiles[mcpProfile] || this.#mcpProfiles.owner || {};
        const mcpServers = profileConfig.mcpServers || null;

        // 5. Create ACP client
        const acp = new ACPClient({
            binary: this.#config.copilotBinary,
            cwd: this.#config.workingDirectory || "/config",
            copilotHome: home,
            permissionPolicy: "allow_all",
            stdioMcpServers: mcpServers,
            tag: id,
        });

        // 6. Build instance
        const inst = new PoolInstance({ id, acp, model: modelTier, mcpProfile, copilotHome: home });
        this.#instances.set(id, inst);
        this.#setupSupervision(inst);

        // 7. Start + Auth + Session
        try {
            await acp.start();
            await acp.authenticate();
            // Brief pause for ACP to stabilize
            await new Promise(r => setTimeout(r, 300));
            await acp.newSession({ cwd: this.#config.workingDirectory || "/config" });

            inst.sessionId = acp.sessionId;
            inst.state = "idle";
            inst.lastActiveAt = Date.now();
            log.info(`${id} ready: session=${inst.sessionId} pid=${inst.pid}`);
            this.emit("instance-ready", { instanceId: id, model: modelTier, mcpProfile });
            return inst;
        } catch (err) {
            log.error(`${id} spawn failed: ${err.message}`);
            inst.state = "dead";
            await this.#cleanup(inst);
            throw new Error(`Failed to spawn ${id}: ${err.message}`);
        }
    }

    async #reconfigure(inst, newModelTier) {
        log.info(`Reconfiguring ${inst.id}: ${inst.model} → ${newModelTier}`);

        // Write new settings
        const modelConfig = MODEL_PROFILES[newModelTier] || MODEL_PROFILES.standard;
        writeFileSync(join(inst.copilotHome, "settings.json"), JSON.stringify(modelConfig));

        // Restart the CLI process
        if (inst.acp?.alive) {
            inst.acp.removeAllListeners();
            await inst.acp.stop().catch(() => {});
        }

        // Respawn with same COPILOT_HOME
        const acp = new ACPClient({
            binary: this.#config.copilotBinary,
            cwd: this.#config.workingDirectory || "/config",
            copilotHome: inst.copilotHome,
            permissionPolicy: "allow_all",
            stdioMcpServers: (this.#mcpProfiles[inst.mcpProfile] || {}).mcpServers || null,
            tag: inst.id,
        });

        inst.acp = acp;
        inst.state = "booting";
        this.#setupSupervision(inst);

        await acp.start();
        await acp.authenticate();
        await new Promise(r => setTimeout(r, 300));
        await acp.newSession({ cwd: this.#config.workingDirectory || "/config" });

        inst.sessionId = acp.sessionId;
        inst.model = newModelTier;
        inst.state = "idle";
        inst.lastActiveAt = Date.now();
        log.info(`${inst.id} reconfigured: model=${newModelTier} session=${inst.sessionId}`);
    }

    // ── Private: Claim & Release ─────────────────────────────

    #claim(inst, scopeKey) {
        if (inst.idleTimer) {
            clearTimeout(inst.idleTimer);
            inst.idleTimer = null;
        }
        inst.state = "claimed";
        inst.claimedBy = scopeKey;
        inst.claimedAt = Date.now();
        inst.lastActiveAt = Date.now();
        log.debug(`Claimed ${inst.id} for ${scopeKey}`);
    }

    // ── Private: Idle & Eviction ─────────────────────────────

    #startIdleTimer(inst) {
        if (inst.idleTimer) clearTimeout(inst.idleTimer);
        if (this.#idleTimeoutMs <= 0) return;

        inst.idleTimer = setTimeout(() => {
            if (inst.state !== "idle") return;
            log.info(`${inst.id} idle timeout — reaping`);
            inst.state = "draining";
            this.#stopAndCleanup(inst).catch(err =>
                log.warn(`Idle reap error for ${inst.id}: ${err.message}`)
            );
        }, this.#idleTimeoutMs);
        inst.idleTimer.unref?.();
    }

    #findOldestIdle() {
        let oldest = null;
        let oldestTime = Infinity;
        for (const inst of this.#instances.values()) {
            if (inst.state === "idle" && inst.lastActiveAt < oldestTime) {
                oldest = inst;
                oldestTime = inst.lastActiveAt;
            }
        }
        return oldest;
    }

    async #evict(inst) {
        log.info(`Evicting ${inst.id} (idle since ${Date.now() - inst.lastActiveAt}ms ago)`);
        inst.state = "draining";
        if (inst.idleTimer) clearTimeout(inst.idleTimer);
        await this.#stopAndCleanup(inst);
    }

    // ── Private: Wait Queue ──────────────────────────────────

    #waitForSlot(scopeKey, model, mcpProfile) {
        return new Promise((resolve, reject) => {
            const entry = {
                scopeKey, model, mcpProfile, resolve, reject,
                timer: setTimeout(() => {
                    const idx = this.#waitQueue.indexOf(entry);
                    if (idx >= 0) this.#waitQueue.splice(idx, 1);
                    reject(new PoolExhaustedError());
                }, this.#waitTimeoutMs),
            };
            this.#waitQueue.push(entry);
            log.debug(`${scopeKey} waiting for slot (queue size: ${this.#waitQueue.length})`);
        });
    }

    /** Try to fulfill waiters. Returns true if a waiter was served. */
    #drainWaitQueue() {
        let served = false;
        while (this.#waitQueue.length > 0) {
            const entry = this.#waitQueue[0];
            // Find an idle instance matching the waiter's needs
            let match = null;
            for (const inst of this.#instances.values()) {
                if (inst.state === "idle" && inst.mcpProfile === entry.mcpProfile) {
                    match = inst;
                    if (inst.model === entry.model) break; // prefer exact model match
                }
            }
            if (!match) break;

            this.#waitQueue.shift();
            clearTimeout(entry.timer);
            this.#claim(match, entry.scopeKey);
            entry.resolve(match);
            served = true;
        }
        return served;
    }

    // ── Private: Supervision ─────────────────────────────────

    #setupSupervision(inst) {
        inst.acp.on("exit", ({ code, signal }) => {
            if (inst.state === "draining" || inst.state === "dead") {
                this.#cleanup(inst);
                return;
            }
            // Unexpected crash
            log.error(`${inst.id} crashed: code=${code} signal=${signal}`);
            const crashedScope = inst.claimedBy;
            inst.state = "dead";
            inst.crashes++;

            if (crashedScope) {
                this.emit("instance-crash", { instanceId: inst.id, scopeKey: crashedScope, code, signal });
            }

            this.#cleanup(inst);
            this.#drainWaitQueue();

            // Replace if below pre-warm threshold
            if (this.#countAlive() < this.#preWarmCount) {
                const defaultModel = this.#resolveModelTier(this.#config.defaultModel);
                this.#spawn(defaultModel, "owner").catch(err =>
                    log.warn(`Post-crash pre-warm failed: ${err.message}`)
                );
            }
        });

        inst.acp.on("log", (text) => {
            log.debug(`[${inst.id}] ${text}`);
        });
    }

    async #healthCheck() {
        for (const inst of this.#instances.values()) {
            if (inst.state !== "idle") continue;
            try {
                await Promise.race([
                    inst.acp.listSessions(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("health timeout")), 5000)),
                ]);
                // Measure RSS while we're at it
                this.#measureRss(inst);
            } catch {
                log.warn(`${inst.id} failed health check — marking dead`);
                inst.state = "dead";
                this.#cleanup(inst);
            }
        }
    }

    #measureRss(inst) {
        if (!inst.pid) return;
        try {
            const status = readFileSync(`/proc/${inst.pid}/status`, "utf8");
            const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
            if (match) inst.rssBytes = parseInt(match[1]) * 1024;
        } catch {
            // Process may have died
        }
    }

    // ── Private: Cleanup ─────────────────────────────────────

    async #stopAndCleanup(inst) {
        if (inst.acp?.alive) {
            inst.acp.removeAllListeners();
            await inst.acp.stop().catch(() => {});
        }
        this.#cleanup(inst);
    }

    #cleanup(inst) {
        this.#instances.delete(inst.id);
        if (inst.idleTimer) {
            clearTimeout(inst.idleTimer);
            inst.idleTimer = null;
        }
        // Clean up COPILOT_HOME
        try { rmSync(inst.copilotHome, { recursive: true, force: true }); } catch {}
        log.debug(`Cleaned up ${inst.id}`);
    }

    // ── Private: Helpers ─────────────────────────────────────

    #countByState(state) {
        let n = 0;
        for (const inst of this.#instances.values()) {
            if (inst.state === state) n++;
        }
        return n;
    }

    #countAlive() {
        let n = 0;
        for (const inst of this.#instances.values()) {
            if (inst.state !== "dead" && inst.state !== "draining") n++;
        }
        return n;
    }

    /** Normalize model string to one of the 3 tiers. */
    #resolveModelTier(model) {
        if (!model) return "standard";
        const m = model.toLowerCase();
        if (m === "fast" || m === "haiku" || m.includes("haiku")) return "fast";
        if (m === "reasoning" || m === "opus" || m.includes("opus")) return "reasoning";
        return "standard";
    }
}
