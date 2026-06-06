// ============================================================
// CopilotLifecycle — manages ACP start/stop/restart/login
// ============================================================
// Extracted from bridge.mjs (Phase 3). Handles copilot process
// lifecycle including device login flow.

import { spawn } from "node:child_process";
import { createLogger } from "../../logger.mjs";

const log = createLogger('lifecycle');

export class CopilotLifecycle {
    #acp;
    #config;
    #scopeMgr;
    #resetPreamble;
    #refreshStatus;
    #clearKnownTools;
    #broadcastAdmin;
    #loginPromise = null;
    #startPromise = null;

    /**
     * @param {object} opts
     * @param {object} opts.acp - ACP client instance
     * @param {object} opts.config - Bot config (needs .copilotBinary, .workingDirectory)
     * @param {object} opts.scopeMgr - ScopeManager instance
     * @param {Function} opts.resetPreamble - callback to reset preamble on all scopes
     * @param {Function} opts.refreshStatus - callback to refresh status menu
     * @param {Function} opts.clearKnownTools - callback to clear known tools map
     * @param {Function} opts.broadcastAdmin - callback to send message to all admin chats
     */
    constructor({ acp, config, scopeMgr, resetPreamble, refreshStatus, clearKnownTools, broadcastAdmin }) {
        this.#acp = acp;
        this.#config = config;
        this.#scopeMgr = scopeMgr;
        this.#resetPreamble = resetPreamble;
        this.#refreshStatus = refreshStatus;
        this.#clearKnownTools = clearKnownTools;
        this.#broadcastAdmin = broadcastAdmin;
    }

    /** Start ACP process with lock guard to prevent overlapping starts. */
    async start() {
        if (this.#acp.alive) return;

        // If already starting, wait for that attempt
        if (this.#startPromise) {
            log.warn("Start already in progress, waiting...");
            return this.#startPromise;
        }

        this.#startPromise = this.#doStart();
        try {
            await this.#startPromise;
        } finally {
            this.#startPromise = null;
        }
    }

    async #doStart() {
        log.info("Starting ACP process...");
        try {
            await this.#acp.start();
        } catch (err) {
            throw new Error(`Failed to start copilot binary: ${err.message}. Check copilot_binary path in config.`);
        }

        // Authenticate — required by ACP protocol before session/new
        try {
            await this.#acp.authenticate();
            log.info("ACP authentication successful");
        } catch (err) {
            const isAuthRequired = err.message?.includes("Authentication required") || err.message?.includes("-32000");
            if (!isAuthRequired) {
                log.warn(`Authentication failed (unexpected): ${err.message}`);
                await this.#acp.stop();
                throw err;
            }

            if (process.env.COPILOT_GITHUB_TOKEN) {
                log.warn("Configured token rejected — clearing and retrying with stored tokens");
                delete process.env.COPILOT_GITHUB_TOKEN;
                await this.#acp.stop();
                await this.#acp.start();
                try {
                    await this.#acp.authenticate();
                    log.info("ACP authentication successful with stored tokens");
                } catch (retryErr) {
                    if (retryErr.message?.includes("Authentication required") || retryErr.message?.includes("-32000")) {
                        log.warn("No stored tokens either — starting device login");
                        await this.#acp.stop();
                        await this.#runDeviceLogin();
                        await this.#acp.start();
                        await this.#acp.authenticate();
                        log.info("ACP authentication successful after login");
                    } else {
                        log.error(`Authentication retry failed: ${retryErr.message}`);
                        await this.#acp.stop();
                        throw retryErr;
                    }
                }
            } else {
                log.warn("No valid token found — starting device login flow");
                await this.#acp.stop();
                await this.#runDeviceLogin();
                await this.#acp.start();
                await this.#acp.authenticate();
                log.info("ACP authentication successful after login");
            }
        }

        // Create session (small delay to let auth propagate in the ACP process)
        await new Promise(r => setTimeout(r, 500));
        log.info("Creating new ACP session...");
        try {
            await this.#acp.newSession({
                cwd: this.#config.workingDirectory || "/config",
            });
        } catch (err) {
            if (err.message?.includes("-32000")) {
                throw new Error(`Session creation failed: ${err.message}. This usually means the copilot token is expired or COPILOT_HOME is misconfigured.`);
            }
            throw new Error(`Session creation failed: ${err.message}`);
        }

        // Clear stale scope sessionIds — old ACP sessions don't survive restart
        if (this.#scopeMgr) {
            this.#scopeMgr.clearAllSessions();
            log.info("Cleared stale scope sessions after ACP restart");
        }
        this.#resetPreamble();
        log.info(`Copilot started, session: ${this.#acp.sessionId}`);
        this.#refreshStatus().catch(() => {});
    }

    async #runDeviceLogin() {
        // If PAT token is configured, no login needed
        if (process.env.COPILOT_GITHUB_TOKEN) {
            log.info("GitHub token configured — skipping device login");
            return;
        }

        // If login is already in progress, wait for that one
        if (this.#loginPromise) {
            log.warn("Login already in progress, waiting...");
            return this.#loginPromise;
        }

        log.info("Authentication required — starting device login flow...");
        const binary = this.#config.copilotBinary || "/share/copilot-tools/copilot";

        this.#loginPromise = new Promise((resolve, reject) => {
            // Spawn the configured binary directly so it is never interpreted by a shell.
            log.info(`[login] Spawning: ${binary} login`);
            const proc = spawn(binary, ["login"], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env },
            });
            const sendAutoConfirm = () => {
                if (proc.stdin && !proc.stdin.destroyed && proc.exitCode === null) {
                    proc.stdin.write("y\n");
                }
            };
            sendAutoConfirm();
            const yesInterval = setInterval(sendAutoConfirm, 100);
            const clearAutoConfirm = () => clearInterval(yesInterval);
            proc.stdin?.on("error", () => {});

            let stdout = "";
            let stderr = "";
            let codeSent = false;
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    clearAutoConfirm();
                    log.error("[login] Timed out after 10 minutes");
                    proc.kill();
                    this.#broadcastAdmin("⏰ Login timed out. Send any message to get a fresh code.");
                    reject(new Error("Login timed out"));
                }
            }, 10 * 60 * 1000);

            proc.stdout.on("data", (chunk) => {
                const text = chunk.toString();
                stdout += text;
                log.debug(`[login] stdout: ${text.trim()}`);
                if (!codeSent) {
                    const match = stdout.match(/enter code ([A-Z0-9]{4}-[A-Z0-9]{4})/);
                    if (match) {
                        codeSent = true;
                        const code = match[1];
                        log.info(`[login] Device code: ${code}`);
                        this.#broadcastAdmin(
                            `🔐 GitHub authentication required\n\n` +
                            `1️⃣ Visit: https://github.com/login/device\n` +
                            `2️⃣ Enter code: ${code}\n\n` +
                            `⏳ Waiting for you to authorize...\n` +
                            `(One-time setup — takes 30 seconds)`
                        );
                    }
                }
            });

            proc.stderr.on("data", (chunk) => {
                const text = chunk.toString().trim();
                if (text) {
                    stderr += text + "\n";
                    log.debug(`[login] stderr: ${text}`);
                }
            });

            proc.on("close", (exitCode) => {
                clearTimeout(timeout);
                clearAutoConfirm();
                this.#loginPromise = null;
                if (resolved) return;
                resolved = true;
                log.info(`[login] Process exited with code ${exitCode}`);
                if (stderr) log.debug(`[login] stderr: ${stderr.trim()}`);

                // Always resolve — the caller will verify auth via acp.authenticate()
                // Login may exit non-zero due to browser/clipboard warnings in containers
                this.#broadcastAdmin("✅ Login flow completed — verifying token...");
                resolve();
            });

            proc.on("error", (err) => {
                clearTimeout(timeout);
                clearAutoConfirm();
                this.#loginPromise = null;
                if (!resolved) {
                    resolved = true;
                    log.error(`[login] Spawn error: ${err.message}`);
                    reject(err);
                }
            });
        });

        return this.#loginPromise;
    }

    async stop() {
        await this.#acp.stop();
        this.#resetPreamble();
    }

    async restart() {
        await this.stop();
        this.#clearKnownTools();
        await this.start();
    }
}
