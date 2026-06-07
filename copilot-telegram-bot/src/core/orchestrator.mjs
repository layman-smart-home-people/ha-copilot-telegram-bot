// ============================================================
// Orchestrator — Telegram ↔ Copilot ACP Coordination Hub
// ============================================================
// Renamed from bridge.mjs (Phase 5). Central orchestrator that owns
// the prompt queue, ACP event wiring, session lifecycle, and
// message routing between Telegram and Copilot.

import { markdownToTelegramHtml, chunkMessage, describeToolCall } from "../transport/telegram/formatter.mjs";
import { parseSlashCommand, handleSlashCommand } from "./commands.mjs";
import { normalizeModeId } from "../ai/copilot/acp-client.mjs";
import { ButtonManager } from "../transport/telegram/buttons.mjs";
import { ResponseComposer } from "../transport/telegram/response-composer.mjs";
import { formatError } from "./errors.mjs";
import { MessageTransport, makeRef } from "../transport/telegram/transport-ref.mjs";
import { AgentMemory } from "./agent-memory.mjs";
import { PromptBuilder, sanitizePinnedInstruction } from "../ai/copilot/prompt-builder.mjs";
import { CopilotLifecycle } from "../ai/copilot/lifecycle.mjs";
import { PermissionHandler } from "../ai/copilot/permissions.mjs";
import { InteractiveFlows } from "../ai/copilot/interactive-flows.mjs";
import { StatusMenu } from "./status.mjs";
import { ToolNotifications } from "./tool-notifications.mjs";
import { TelegramAdapter } from "../transport/telegram/adapter.mjs";
import { eventLog } from "./event-log.mjs";
import { metrics } from "./metrics.mjs";
import { createLogger } from "../logger.mjs";

const log = createLogger('orchestrator');

const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Prompt watchdog: auto-cancel hung prompts
const SI_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes for SI-triggered prompts
const USER_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes for user-interactive prompts
const CANCEL_GRACE_MS = 15_000;                  // 15s after cancel before force-kill
const HEARTBEAT_INTERVAL_MS = 60_000;            // log heartbeat every 60s during active prompt

export class Orchestrator {
    #telegram;
    #acp;        // primary ACP instance (shorthand)
    #acpMgr;     // ACPManager for multi-ACP support
    #config;
    #allowedChatIds;

    // Subsystems
    #transport;
    #pairing;
    #scopeMgr;
    #sessionMgr;

    // --- Primary ACP context ---
    // Active conversation ref — where primary ACP output is routed
    #activeRef = null;
    // Active scope — per-scope state for the current primary prompt
    #activeScope = null;
    // Session switch guard — true while loading a different ACP session
    #switching = false;

    // --- Overflow ACP context ---
    #overflowScope = null;
    #overflowRef = null;

    // Set when the active prompt was cancelled due to message edit
    #editCancelled = false;

    // Typing state
    #typingInterval = null;
    #typingDebounce = null;

    // Message flush interval (safety net timer length)
    #messageFlushMs = 2000;

    // Pinned instructions per chat (chatId → text)
    #pinnedInstructions = new Map();

    // Prompt lock (one prompt at a time on primary)
    #promptActive = false;
    #promptQueue = [];
    #lastProcessedScope = null;
    #lastProcessedAt = 0;

    // --- Background task queue (overflow ACP) ---
    #backgroundQueue = [];
    #backgroundActive = false;
    static #BACKGROUND_QUEUE_MAX = 5;
    static #BACKGROUND_WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes

    // Prompt watchdog (auto-cancel hung prompts)
    #watchdogTimer = null;
    #heartbeatTimer = null;
    #promptStartedAt = 0;
    #promptGeneration = 0;  // incremented on each prompt; prevents stale force-cancel
    #intentionalKill = false; // set true before force-killing ACP to preserve queue
    #stallWarned = false;     // true after first stall warning for current prompt


    // Prompt builder (extracted module)
    #promptBuilder;

    // Copilot lifecycle manager (extracted module)
    #lifecycle;

    // Button manager for inline keyboards
    #buttons;

    // Global session state (shared across all scopes)
    #models = [];
    #modes = [];
    #availableCommands = [];  // Copilot slash commands from ACP
    #knownTools = new Map();  // MCP tool names seen → description

    // Active status menu — managed by StatusMenu module
    #statusMenu;

    // Permission handler (extracted module)
    #permissionHandler;

    // Interactive flows — elicitation + MCP ask_user (extracted module)
    #interactiveFlows;

    // Tool notifications (extracted module)
    #toolNotify;

    // Agent persistent memory
    #agentMemory;

    // Telegram adapter (extracted module)
    #adapter;

    constructor({ telegram, acp, acpMgr, config, pairing, scopeMgr, sessionMgr }) {
        this.#telegram = telegram;
        this.#acpMgr = acpMgr || null;
        this.#acp = acpMgr ? acpMgr.primary : acp;
        this.#config = config;
        this.#allowedChatIds = (config.allowedChatIds || []).map(Number);
        this.#buttons = new ButtonManager(telegram);
        this.#transport = new MessageTransport(telegram);
        this.#pairing = pairing || null;
        this.#scopeMgr = scopeMgr || null;
        this.#sessionMgr = sessionMgr || null;
        this.#agentMemory = new AgentMemory({ agentDir: config.agentDir });

        // Extracted modules
        this.#promptBuilder = new PromptBuilder({
            config,
            agentMemory: this.#agentMemory,
            scopeMgr: this.#scopeMgr,
            pinnedInstructions: this.#pinnedInstructions,
            getActiveScope: () => this.#activeScope,
            getActiveRef: () => this.#activeRef,
        });

        this.#statusMenu = new StatusMenu({
            telegram,
            acp: this.#acp,
            config,
            scopeMgr: this.#scopeMgr,
            getActiveScope: () => this.#activeScope,
            getModels: () => this.#models,
            getModes: () => this.#modes,
            getAllowedChatIds: () => this.#allowedChatIds,
            getPairing: () => this.#pairing,
            getStandingOrchestrator: () => this.standingOrchestrator,
            getBackgroundStatus: () => this.backgroundStatus,
        });

        this.#lifecycle = new CopilotLifecycle({
            acp: this.#acp,
            config,
            scopeMgr: this.#scopeMgr,
            resetPreamble: () => this.resetPreamble(),
            refreshStatus: () => this.#statusMenu.refreshIfAlive(),
            clearKnownTools: () => this.#knownTools.clear(),
            broadcastAdmin: (text) => this.#broadcastAdmin(text),
        });

        this.#permissionHandler = new PermissionHandler({
            buttons: this.#buttons,
            getAllowedChatIds: () => this.#allowedChatIds,
        });

        this.#interactiveFlows = new InteractiveFlows({
            buttons: this.#buttons,
            telegram,
            acp: this.#acp,
            scopeMgr: this.#scopeMgr,
            getActiveScope: () => this.#activeScope,
            getOverflowScope: () => this.#overflowScope,
            getActiveRef: () => this.#activeRef,
            getAllowedChatIds: () => this.#allowedChatIds,
            onBackgroundTask: ({ taskId, prompt, description, chatId }) => {
                this.injectBackgroundPrompt(prompt, chatId, {
                    priority: 2,
                    description,
                    taskId,
                });
            },
        });

        this.#toolNotify = new ToolNotifications({
            buttons: this.#buttons,
            telegram,
            getAllowedChatIds: () => this.#allowedChatIds,
            getActiveScope: () => this.#activeScope,
            getActiveRef: () => this.#activeRef,
            queuePrompt: (text, opts, ref, messageId) => this.#queuePrompt(text, opts, ref, messageId),
        });

        this.#adapter = new TelegramAdapter({
            telegram,
            orchestrator: this,
            config,
            pairing: this.#pairing,
            scopeMgr: this.#scopeMgr,
            transport: this.#transport,
            buttons: this.#buttons,
            statusMenu: this.#statusMenu,
            pinnedInstructions: this.#pinnedInstructions,
        });
    }

    get allowedChatIds() { return this.#allowedChatIds; }
    get promptActive() { return this.#promptActive; }
    get acpMgr() { return this.#acpMgr; }
    standingOrchestrator = null;
    get allowAll() { return this.#activeScope?.allowAll ?? false; }
    set allowAll(v) {
        const val = !!v;
        if (this.#activeScope) this.#activeScope.allowAll = val;
        log.info(`Allow-all mode: ${val}`);
    }

    /** Resolve scope and ref for a given ACP tag. */
    #getCtxForTag(tag) {
        if (tag === "overflow") {
            return { scope: this.#overflowScope, ref: this.#overflowRef };
        }
        return { scope: this.#activeScope, ref: this.#activeRef };
    }

    /** Resolve scope/ref for whichever ACP tag a scope is using. */
    #getCtxForScope(scopeKey) {
        if (this.#overflowScope?.key === scopeKey) {
            return { scope: this.#overflowScope, ref: this.#overflowRef, tag: "overflow" };
        }
        if (this.#activeScope?.key === scopeKey) {
            return { scope: this.#activeScope, ref: this.#activeRef, tag: "primary" };
        }
        return { scope: null, ref: null, tag: null };
    }

    resetPreamble() {
        this.#promptBuilder.resetPreamble();
    }

    /** Best-effort notification before process exit. */
    async notifyShutdown() {
        const promises = [];
        const scope = this.#activeScope;

        // Cancel any queued MCP questions
        this.#interactiveFlows.cancelQuestionQueue("Bot shutting down");

        // If a response was in progress, notify the user
        if (scope?.composer?.active && this.#activeRef) {
            promises.push(
                this.#telegram.sendMessage(
                    this.#activeRef.chatId,
                    "⚠️ Add-on is shutting down — current operation was interrupted. Send a message to resume when it's back."
                ).catch(() => {})
            );
        }

        // Update status menu if one exists
        promises.push(this.#statusMenu.handleShutdown());

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
        this.#interactiveFlows.stopUdsServer();
        this.#buttons.destroy();
    }

    /** Re-submit a message as if the user sent it (for /retry) */
    submitRetry(ref, text) {
        this.#queuePrompt(this.#promptBuilder.getPrefix(ref) + text, {}, ref);
    }

    /** Send an ACP slash command without the [Via Telegram] prefix. */
    submitSlashCommand(ref, text) {
        this.#queuePrompt(text, {}, ref);
    }

    /**
     * Inject a system-generated prompt into the agent (for standing instructions,
     * event-triggered wake-ups, scheduled tasks, etc.).
     * Routes output to the specified chatId (defaults to owner DM).
     */
    async injectSystemPrompt(text, chatId) {
        const targetChatId = chatId || this.#allowedChatIds[0];
        if (!targetChatId) {
            log.warn("Cannot inject prompt — no target chatId");
            return;
        }
        const ref = makeRef(targetChatId, null, null, "private");
        ref.scopeKey = `standing:${targetChatId}`;
        const prefix = this.#promptBuilder.getPrefix(ref);
        log.info(`Injecting system prompt to chat=${targetChatId}`);

        // Ensure copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                log.error(`Failed to start copilot for injection: ${err.message}`);
                // Notify owner about the failure
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(targetChatId,
                        `⚠️ Standing instruction triggered but Copilot couldn't start: ${err.message}`)
                );
                return;
            }
        }

        // Fire-and-forget but handle promise rejection properly
        this.#queuePrompt(prefix + text, {}, ref).catch(err => {
            log.error(`Injected prompt failed: ${err.message}`);
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(targetChatId,
                    `⚠️ Standing instruction triggered but the agent couldn't process it. Try again later.`)
            ).catch(() => {});
        });
    }

    // --- Background task pipeline (overflow ACP) ---

    /**
     * Enqueue a background task to run on the overflow ACP.
     * Falls back to primary queue if overflow is disabled.
     * @param {string} prompt - The prompt text to send
     * @param {string|number} chatId - Where to deliver results
     * @param {object} [options]
     * @param {number} [options.priority=2] - 1=high (SI), 2=normal (agent)
     * @param {string} [options.description=""] - Short description for status
     */
    injectBackgroundPrompt(prompt, chatId, { priority = 2, description = "Background task", taskId: providedTaskId } = {}) {
        if (!this.#acpMgr?.overflowEnabled) {
            log.info("Background task falling back to primary queue (overflow disabled)");
            return this.injectSystemPrompt(prompt, chatId);
        }

        if (this.#backgroundQueue.length >= Orchestrator.#BACKGROUND_QUEUE_MAX) {
            log.warn("Background queue full, rejecting task");
            if (chatId) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, `⚠️ Background queue full (${Orchestrator.#BACKGROUND_QUEUE_MAX}) — task rejected.\n${description}`)
                ).catch(() => {});
            }
            return;
        }

        const taskId = providedTaskId || `bg-${Date.now().toString(36)}`;
        const task = { prompt, chatId, priority, description, taskId, createdAt: Date.now() };

        // Insert by priority (lower number = higher priority, jump ahead of lower-priority items)
        const insertIdx = this.#backgroundQueue.findIndex(t => t.priority > priority);
        if (insertIdx === -1) {
            this.#backgroundQueue.push(task);
        } else {
            this.#backgroundQueue.splice(insertIdx, 0, task);
        }

        log.info(`Background task queued: ${taskId} "${description}" (priority=${priority}, queue=${this.#backgroundQueue.length})`);

        // Start processing if not already running
        if (!this.#backgroundActive) {
            this.#processBackgroundQueue().catch(err => {
                log.error(`Background queue processing error: ${err.message}`);
            });
        }
    }

    /** Background queue status for /status display. */
    get backgroundStatus() {
        return {
            queueLength: this.#backgroundQueue.length,
            active: this.#backgroundActive,
            tasks: this.#backgroundQueue.map(t => ({
                taskId: t.taskId,
                description: t.description,
                priority: t.priority,
                age: Math.floor((Date.now() - t.createdAt) / 1000),
            })),
        };
    }

    async #processBackgroundQueue() {
        if (this.#backgroundActive) return;
        this.#backgroundActive = true;

        try {
            while (this.#backgroundQueue.length > 0) {
                const task = this.#backgroundQueue.shift();
                await this.#executeBackgroundTask(task);
            }
        } finally {
            this.#backgroundActive = false;
        }
    }

    async #executeBackgroundTask(task) {
        const { prompt, chatId, taskId, description } = task;
        const startTime = Date.now();
        log.info(`Background task starting: ${taskId} "${description}"`);

        try {
            // Acquire overflow ACP (spawns if needed)
            const result = await this.#acpMgr.acquireOrSpawn("background:task");
            if (!result) {
                log.warn(`No overflow ACP available for ${taskId} — falling back to primary`);
                this.injectSystemPrompt(prompt, chatId);
                return;
            }

            const { acp: overflowAcp, tag } = result;
            this.#acpMgr.claim(tag, "background:task");

            // Create fresh session for task isolation
            try {
                await overflowAcp.newSession({
                    cwd: this.#config.workingDirectory || "/config",
                });
            } catch (err) {
                log.warn(`Failed to create overflow session for ${taskId}: ${err.message}`);
                this.#acpMgr.release(tag);
                this.injectSystemPrompt(prompt, chatId);
                return;
            }

            // Set up text collector (separate from wired overflow handlers)
            const textChunks = [];
            const onText = (text) => textChunks.push(text);
            overflowAcp.on("text_chunk", onText);

            // Build preamble with agent context
            const fullPrompt = this.#buildBackgroundPreamble() + "\n\n" + prompt;

            // 5-minute watchdog
            let timedOut = false;
            const watchdog = setTimeout(() => {
                timedOut = true;
                log.warn(`Background task ${taskId} timed out — killing overflow ACP`);
                overflowAcp.stop().catch(() => {});
            }, Orchestrator.#BACKGROUND_WATCHDOG_MS);
            watchdog.unref?.();

            try {
                await overflowAcp.prompt(fullPrompt, {});
            } catch (err) {
                if (timedOut) {
                    if (chatId) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, `⚠️ Background task timed out (5 min)\n_${description}_`)
                        ).catch(() => {});
                    }
                    return;
                }
                throw err;
            } finally {
                clearTimeout(watchdog);
                overflowAcp.off("text_chunk", onText);
                this.#acpMgr.release(tag);
            }

            // Deliver results
            const fullText = textChunks.join("");
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info(`Background task completed: ${taskId} in ${elapsed}s (${fullText.length} chars)`);

            if (fullText.trim() && chatId) {
                const header = `📋 *Background Task* (${elapsed}s)\n_${description}_\n\n`;
                const content = header + fullText;
                const chunks = chunkMessage(content);
                for (const chunk of chunks) {
                    const html = markdownToTelegramHtml(chunk);
                    await this.#telegram.enqueue(() =>
                        this.#telegram.sendMessage(chatId, html, "HTML")
                    );
                }
            } else if (!fullText.trim()) {
                log.info(`Background task ${taskId} produced no output`);
            }

        } catch (err) {
            log.error(`Background task ${taskId} failed: ${err.message}`);
            if (chatId) {
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, `❌ Background task failed\n_${description}_\n\n${err.message}`)
                ).catch(() => {});
            }
        }
    }

    #buildBackgroundPreamble() {
        const parts = [
            "You are running in background mode. Do not attempt user interaction — no ask_user, no questions, no confirmations. Report findings directly and concisely.",
            "You have access to HA MCP tools (ha-mcp) and standing instruction tools (si_*). Use them to complete your task.",
        ];
        const agentContext = this.#agentMemory.buildContext();
        if (agentContext) {
            parts.push("---\nAgent context:\n" + agentContext);
        }
        return parts.join("\n\n");
    }

    #resolveScopeKey(scope, ref = null) {
        if (scope?.key) return scope.key;
        if (ref?.scopeKey) return ref.scopeKey;
        if (this.#scopeMgr && ref) return this.#scopeMgr.resolveKey(ref);
        return null;
    }

    isPromptActiveForScope(scope, ref = null) {
        const requestedKey = this.#resolveScopeKey(scope, ref);
        if (!this.#promptActive) return false;
        if (!requestedKey) return true;
        return this.#activeScope?.key === requestedKey;
    }

    async cancelActivePromptForScope(scope, ref = null, opts = {}) {
        const { notifyIfMissing = true, force = false } = opts;
        const requestedKey = this.#resolveScopeKey(scope, ref);

        // Cancel any queued questions for this scope
        this.#interactiveFlows.cancelQuestionQueue("User cancelled");

        if (this.#promptActive && (force || !requestedKey || this.#activeScope?.key === requestedKey)) {
            await this.#acp.cancel();
            return true;
        }

        if (notifyIfMissing && ref) {
            this.#transport.enqueueSend(ref, "ℹ️ No active request in this conversation to cancel.");
        }
        return false;
    }

    /**
     * Force-cancel the active prompt. Attempts graceful cancel first,
     * then kills the ACP process if it doesn't respond within CANCEL_GRACE_MS.
     * @param {string} reason - why we're cancelling
     * @param {number} generation - the prompt generation that triggered this cancel
     */
    async #forceCancel(reason, generation) {
        if (!this.#promptActive) return;
        log.warn(`Force cancel: ${reason} (generation=${generation})`);

        eventLog.emit("prompt.cancelled", {
            scopeKey: this.#activeScope?.key || "unknown",
            reason,
            elapsedMs: this.#promptStartedAt ? Date.now() - this.#promptStartedAt : null,
        });
        metrics.increment("prompt_cancels");

        // Attempt graceful cancel
        try {
            await this.#acp.cancel();
        } catch (err) {
            log.warn(`Cancel RPC failed: ${err.message}`);
        }

        // Check if the original prompt already ended (cancel worked or prompt completed)
        if (this.#promptGeneration !== generation) {
            log.info("Force cancel: prompt generation changed — cancel was effective, skipping kill");
            return;
        }

        // Wait for the prompt to finish gracefully
        if (this.#promptActive && this.#acp.alive) {
            log.info(`Waiting ${CANCEL_GRACE_MS / 1000}s for graceful cancellation...`);
            await new Promise(r => setTimeout(r, CANCEL_GRACE_MS));
        }

        // Re-check generation — a new prompt may have started during grace period
        if (this.#promptGeneration !== generation) {
            log.info("Force cancel: prompt generation changed during grace period — aborting kill");
            return;
        }

        // If still stuck, kill the ACP process
        if (this.#promptActive && this.#acp.alive) {
            log.error("Prompt still active after cancel grace period — killing ACP process");
            this.#intentionalKill = true;
            try {
                await this.#acp.stop();
            } catch (err) {
                log.error(`ACP force-kill error: ${err.message}`);
            }
        }
    }

    /** Start watchdog and heartbeat timers for the active prompt. */
    #startPromptWatchdog(scopeKey) {
        this.#promptStartedAt = Date.now();
        this.#stallWarned = false;
        const generation = this.#promptGeneration;
        const isStanding = scopeKey?.startsWith("standing:");
        const timeoutMs = isStanding ? SI_PROMPT_TIMEOUT_MS : USER_PROMPT_TIMEOUT_MS;

        // Emit event + metrics
        eventLog.emit("prompt.started", { scopeKey, isStanding, timeoutMs });
        metrics.increment("prompts_total");
        metrics.gauge("prompt_active", 1);

        // Watchdog: force-cancel after timeout
        this.#watchdogTimer = setTimeout(() => {
            const elapsed = ((Date.now() - this.#promptStartedAt) / 60000).toFixed(1);
            const lastSeen = this.#acp.lastMessageAt
                ? `${((Date.now() - this.#acp.lastMessageAt) / 1000).toFixed(0)}s ago (${this.#acp.lastMessageType})`
                : "never";
            const msg = `Prompt timeout after ${elapsed}min — scope=${scopeKey}, ACP last seen: ${lastSeen}, pending RPCs: ${this.#acp.pendingCount}`;
            log.error(`⏰ ${msg}`);

            eventLog.emit("prompt.timeout", {
                scopeKey,
                elapsedMs: Date.now() - this.#promptStartedAt,
                lastMessageAge: this.#acp.lastMessageAt ? Date.now() - this.#acp.lastMessageAt : null,
                lastMessageType: this.#acp.lastMessageType,
                pendingRPCs: this.#acp.pendingCount,
            });
            metrics.increment("prompt_timeouts");

            // Notify user
            this.#broadcastAdmin(`⏰ Prompt watchdog triggered\n${msg}\nForce-cancelling...`);

            this.#forceCancel(`watchdog timeout (${elapsed}min)`, generation).catch(err => {
                log.error(`Force cancel from watchdog failed: ${err.message}`);
            });
        }, timeoutMs);
        this.#watchdogTimer.unref?.();

        // Heartbeat: periodic health check + stall detection during active prompts
        this.#heartbeatTimer = setInterval(() => {
            const elapsed = ((Date.now() - this.#promptStartedAt) / 1000).toFixed(0);
            const lastMsgAge = this.#acp.lastMessageAt
                ? (Date.now() - this.#acp.lastMessageAt) / 1000
                : Infinity;
            const lastStderrAge = this.#acp.lastStderrAt
                ? (Date.now() - this.#acp.lastStderrAt) / 1000
                : Infinity;
            const lastActivityAge = Math.min(lastMsgAge, lastStderrAge);
            const lastSeen = this.#acp.lastMessageAt
                ? `${lastMsgAge.toFixed(0)}s ago (${this.#acp.lastMessageType})`
                : "never";

            // PID liveness check (signal 0 — doesn't touch stdio)
            const pid = this.#acp.pid;
            let pidAlive = false;
            if (pid) {
                try { process.kill(pid, 0); pidAlive = true; } catch { pidAlive = false; }
            }

            const tools = this.#activeScope?.activeTools?.size || 0;
            log.info(`💓 Prompt heartbeat: scope=${scopeKey}, elapsed=${elapsed}s, ACP last msg: ${lastSeen}, pid=${pid} alive=${pidAlive}, active tools: ${tools}, pending RPCs: ${this.#acp.pendingCount}, queue: ${this.#promptQueue.length}`);

            // Stall detection
            if (!pidAlive && pid && !this.#stallWarned) {
                this.#stallWarned = true;
                log.error(`🚨 ACP process (pid=${pid}) is dead but prompt still active!`);
                eventLog.emit("acp.stall_detected", {
                    type: "pid_dead",
                    pid,
                    scopeKey,
                    elapsedSeconds: parseInt(elapsed),
                });
                this.#broadcastAdmin(
                    `🚨 ACP process dead (pid=${pid}) but prompt still marked active\n` +
                    `Scope: ${scopeKey}, elapsed: ${elapsed}s`
                );
                metrics.increment("stall_warnings");
            } else if (pidAlive && lastActivityAge > 300 && !this.#stallWarned) {
                // No ACP activity (no stdio messages, no stderr) for >300s during active prompt
                this.#stallWarned = true;
                log.warn(`⚠️ ACP stall: no activity for ${lastActivityAge.toFixed(0)}s during active prompt`);
                eventLog.emit("acp.stall_detected", {
                    type: "no_activity",
                    lastActivityAgeSeconds: Math.round(lastActivityAge),
                    scopeKey,
                    elapsedSeconds: parseInt(elapsed),
                    pendingRPCs: this.#acp.pendingCount,
                });
                this.#broadcastAdmin(
                    `⚠️ ACP appears stalled — no activity for ${Math.round(lastActivityAge)}s\n` +
                    `Scope: ${scopeKey}, elapsed: ${elapsed}s, pending RPCs: ${this.#acp.pendingCount}`
                );
                metrics.increment("stall_warnings");
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.#heartbeatTimer.unref?.();
    }

    /** Clear watchdog and heartbeat timers. */
    #clearPromptWatchdog() {
        if (this.#watchdogTimer) {
            clearTimeout(this.#watchdogTimer);
            this.#watchdogTimer = null;
        }
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
        metrics.gauge("prompt_active", 0);
    }

    // --- Status menu (delegated to StatusMenu module) ---

    async showStatusMenu(chatId, scope = null) {
        await this.#statusMenu.show(chatId, scope);
    }

    // --- Setup event handlers ---

    setupACPHandlers() {
        // Wire primary ACP event handlers
        this.#wireACPEvents(this.#acp, {
            getScope: () => this.#activeScope,
            getRef: () => this.#activeRef,
            getSwitching: () => this.#switching,
            tag: "primary",
        });

        // Wire overflow ACP handler callback (called when overflow spawns)
        if (this.#acpMgr) {
            this.#acpMgr.onOverflowSpawned = (overflowAcp) => {
                this.#wireOverflowHandlers(overflowAcp);
            };
        }

        // Start UDS server for tg-ux MCP sidecar IPC
        this.#interactiveFlows.startUdsServer();
    }

    /** Wire overflow ACP event handlers (called when overflow spawns). */
    #wireOverflowHandlers(overflowAcp) {
        this.#wireACPEvents(overflowAcp, {
            getScope: () => this.#overflowScope,
            getRef: () => this.#overflowRef,
            getSwitching: () => false,
            tag: "overflow",
        });
    }

    /**
     * Wire ACP event handlers parametrized by scope/ref resolvers.
     * This allows the same handler logic for both primary and overflow ACP.
     */
    #wireACPEvents(acp, { getScope, getRef, getSwitching, tag }) {

        // Text chunks → feed to composer for progressive display
        acp.on("text_chunk", (text) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            this.#resetTypingDebounce();

            // When text resumes after tool calls → new agent turn detected.
            // (ACP doesn't send agent_message_start/end, so we infer boundaries here.)
            if (scope._toolJustEnded) {
                if (scope.messageBuffer?.trim() && scope.composer?.active) {
                    // Commit previous turn's text as an intermediate message
                    scope.composer.commitTurn();
                    scope.messageBuffer = "";
                    log.debug(`Committed intermediate turn [${tag}]`);
                } else if (scope.messageBuffer && !scope.messageBuffer.endsWith("\n")) {
                    // No substantive text to commit — just add newline separator
                    scope.messageBuffer += "\n";
                    if (scope.composer?.active) scope.composer.appendText("\n");
                }
                scope._toolJustEnded = false;
            }

            scope.messageBuffer += text;
            if (scope.composer?.active) {
                scope.composer.appendText(text);
            } else {
                // Legacy path: no composer, flush as separate messages
                if (scope.messageFlushTimer) clearTimeout(scope.messageFlushTimer);
                scope.messageFlushTimer = setTimeout(() => this.#flushMessageBuffer(getScope, getRef), this.#messageFlushMs);
            }
        });

        // Thought chunks → feed to composer for live reasoning display
        acp.on("thought_chunk", (text) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            this.#resetTypingDebounce();

            // Add newline separator when thoughts resume after tool calls
            if (scope._toolJustEndedThought && scope.composer?.active) {
                scope.composer.appendThought("\n");
            }
            scope._toolJustEndedThought = false;

            if (scope.composer?.active) {
                scope.composer.appendThought(text);
            }
        });

        // Message boundaries — ACP v1.0.60 does NOT send these events.
        // Turn boundaries are inferred in text_chunk handler above via _toolJustEnded.
        // Kept for forward compatibility if a future ACP version adds them.
        acp.on("message_start", () => {
            log.info(`Agent message_start [${tag}]`);
            if (getSwitching()) return;
            const scope = getScope();
            if (scope) {
                // Commit previous turn's text as intermediate before clearing
                if (scope.messageBuffer?.trim() && scope.composer?.active) {
                    scope.composer.commitTurn();
                }
                scope.messageBuffer = "";
                scope._toolJustEnded = false;
                scope._toolJustEndedThought = false;
            }
        });

        acp.on("message_end", () => {
            log.info(`Agent message_end [${tag}]`);
            if (getSwitching()) return;
            // Don't finalize — defer to finally block in #handlePrompt.
            // The composer stays alive to accumulate intermediates across turns.
            this.#stopTyping();
        });

        // Tool calls → composer progress updates
        acp.on("tool_start", ({ toolCallId, toolName, arguments: args }) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            log.debug(`Tool start [${tag}]: ${toolName} (${toolCallId})`);
            scope.turnToolCount++;
            this.#resetTypingDebounce();
            const desc = describeToolCall(toolName, args);
            if (desc) {
                scope.activeTools.set(toolCallId, { name: toolName, description: desc });
                if (scope.composer?.active) {
                    scope.composer.addToolStep(toolCallId, desc, "running");
                }
            }
            // Track tool for /skills discovery
            if (toolName && !this.#knownTools.has(toolName) && this.#knownTools.size < 200) {
                this.#knownTools.set(toolName, desc || toolName);
            }
            // Detect task(mode: "background") — warn that results will be lost
            if (toolName === "task" && args) {
                try {
                    const parsed = typeof args === "string" ? JSON.parse(args) : args;
                    if (parsed?.mode === "background") {
                        log.warn(`⚠️ Agent used task(mode: "background") — results will be lost when prompt completes. Should use background_task MCP tool instead.`);
                    }
                } catch {}
            }
        });

        acp.on("tool_end", ({ toolCallId, status, result }) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            const completed = scope.activeTools.get(toolCallId);
            const resultSummary = result ? JSON.stringify(result).substring(0, 100) : "null";
            log.debug(`Tool end [${tag}]: ${completed?.name || toolCallId} [${status}] (${resultSummary.length > 99 ? 'truncated' : 'full'})`);
            if (status === "failed") {
                scope.turnToolErrors++;
                log.warn(`Tool failed: ${completed?.name || toolCallId}`);
            } else {
                const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
                if (result?.isError || result?.error || /\"isError\"\s*:\s*true/i.test(resultStr)) {
                    scope.turnToolErrors++;
                    log.warn(`Tool error detected: ${completed?.name || toolCallId}`);
                }
            }
            this.#resetTypingDebounce();
            scope.activeTools.delete(toolCallId);
            scope._toolJustEnded = true;  // signal next text_chunk to add newline
            scope._toolJustEndedThought = true;  // signal next thought_chunk to add newline
            if (scope.composer?.active && completed?.description) {
                scope.composer.addToolStep(toolCallId, completed.description, status === "failed" ? "failed" : "completed");
            }

            // Interactive mode: show notification + undo for HA write tools
            if (!scope.allowAll && status === "completed" && completed?.name) {
                this.#toolNotify.showToolNotification(completed.name, result, getScope, getRef);
            }

            // Relay images from tool results
            this.#relayToolImages(result, getRef);
        });

        // Tool progress updates (in_progress status)
        acp.on("tool_update", ({ toolCallId, status }) => {
            if (getSwitching()) return;
            if (status === "in_progress") {
                this.#resetTypingDebounce();
            }
        });

        // Plan entries — display in composer
        acp.on("plan", (entries) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            log.debug(`Plan update [${tag}]: ${entries.length} entries`);
            if (scope.composer?.active) {
                scope.composer.setPlan(entries);
            }
        });

        // Mode change notification
        acp.on("mode_update", (modeId) => {
            const scope = getScope();
            if (scope && modeId) {
                scope.mode = normalizeModeId(modeId);
                log.debug(`Mode updated [${tag}]: ${scope.mode}`);
                this.#statusMenu.refreshIfAlive();
            }
        });

        // Process exit — handle crash recovery
        acp.on("exit", ({ code, signal }) => {
            this.#handleACPExit(code, signal, acp, getScope, getRef, tag);
        });

        acp.on("error", (err) => {
            log.error(`ACP [${tag}] error: ${err.message}`);
        });

        acp.on("log", (text) => {
            log.debug(`ACP[${tag}]: ${text}`);
        });

        acp.on("permission_request", (req) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) return;
            this.#permissionHandler.handlePermissionRequest(req, acp, scope, getRef, tag).catch((err) => {
                log.error(`Permission handler error: ${err.message}`);
                try { acp.respondPermission(req.requestId, null, true); } catch {}
            });
        });

        // Capture session data (models, modes) from session events
        acp.on("session", (result) => {
            if (result.models?.availableModels) {
                this.#models = result.models.availableModels;
                log.info(`Models available: ${this.#models.length}`);
            }
            const scope = getScope();
            if (scope) {
                if (result.models?.currentModelId) {
                    scope.model = result.models.currentModelId;
                }
                if (result.modes?.currentModeId) {
                    scope.mode = normalizeModeId(result.modes.currentModeId);
                }
            }
            if (result.modes?.availableModes) {
                this.#modes = result.modes.availableModes;
            }
        });

        // config_option_update can update models/modes mid-session
        acp.on("config_options", (options) => {
            const scope = getScope();
            const modelOpt = options?.find(o => o.id === "model");
            if (modelOpt?.options) {
                this.#models = modelOpt.options.map(o => ({
                    modelId: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modelOpt?.currentValue && scope) {
                scope.model = modelOpt.currentValue;
            }
            const modeOpt = options?.find(o => o.id === "mode");
            if (modeOpt?.options) {
                this.#modes = modeOpt.options.map(o => ({
                    id: o.value,
                    name: o.name,
                    description: o.description,
                }));
            }
            if (modeOpt?.currentValue && scope) {
                scope.mode = normalizeModeId(modeOpt.currentValue);
            }
            this.#statusMenu.refreshIfAlive();
        });

        // Capture available commands (copilot slash commands)
        acp.on("commands", (commands) => {
            if (Array.isArray(commands)) {
                this.#availableCommands = commands;
                log.info(`Copilot commands available: ${commands.length}`);
            }
        });

        // Elicitation — agent asks structured questions
        acp.on("elicitation_request", (req) => {
            if (getSwitching()) return;
            const scope = getScope();
            if (!scope) {
                acp.respondElicitation(req.requestId, "cancel");
                return;
            }
            this.#interactiveFlows.handleElicitationRequest(req, acp, scope, getRef, tag).catch((err) => {
                log.error(`Elicitation handler error: ${err.message}`);
                try { acp.respondElicitation(req.requestId, "cancel"); } catch {}
            });
        });
    }  // end of #wireACPEvents

    /** Handle ACP process exit — crash recovery and state cleanup. */
    #handleACPExit(code, signal, acp, getScope, getRef, tag) {
        this.#stopTyping();
        const scope = getScope();
        const ref = getRef();
        if (scope) {
            if (scope.composer?.active) {
                scope.composer.abort("Copilot process exited unexpectedly").catch(() => {});
                scope.composer = null;
            }
            scope.activeTools.clear();
            this.#flushMessageBuffer(() => scope, () => ref);

            // Cancel any pending elicitation
            if (scope.pendingElicitation) {
                const { requestId, resolve } = scope.pendingElicitation;
                if (requestId) {
                    try { acp.respondElicitation(requestId, "cancel"); } catch {}
                }
                if (typeof resolve === "function") resolve(undefined);
                scope.pendingElicitation = null;
            }
            // Cancel any pending button menus for this chat
            const chatId = ref?.chatId;
            if (chatId && this.#buttons) {
                this.#buttons.cancelForChat(chatId, "🛑 Session ended");
            }

            // Cancel any queued MCP questions
            this.#interactiveFlows.cancelQuestionQueue("Session ended");
        }

        if (tag === "primary") {
            // Clear watchdog timers — ACP is gone
            this.#clearPromptWatchdog();

            // Capture pre-cleanup state for post-mortem
            const wasIntentional = this.#intentionalKill;
            const activePromptScope = this.#activeScope?.key || null;
            const promptElapsed = this.#promptStartedAt
                ? Math.floor((Date.now() - this.#promptStartedAt) / 1000)
                : null;

            if (this.#promptActive) {
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                this.#scopeMgr?.clearActive();

                if (this.#intentionalKill) {
                    // Intentional kill (watchdog/force-cancel) — preserve queue for restart
                    this.#intentionalKill = false;
                    const preserved = this.#promptQueue.length;
                    if (preserved > 0) {
                        log.info(`Preserved ${preserved} queued message(s) after intentional ACP kill`);
                    }
                } else {
                    // Unexpected crash — drop queue (session state lost)
                    const dropped = this.#promptQueue.length;
                    this.#promptQueue = [];
                    if (dropped > 0) {
                        this.#broadcastAdmin(`⚠️ ${dropped} queued message(s) dropped due to Copilot crash.`);
                    }
                }
            }

            // Structured event + crash post-mortem
            if (!wasIntentional && (code !== 0 || signal)) {
                const postMortem = {
                    exitCode: code,
                    signal,
                    pid: acp.pid,
                    uptimeSeconds: acp.uptimeSeconds,
                    lastStderr: acp.stderrTail,
                    activePromptScope,
                    promptElapsedSeconds: promptElapsed,
                    queueDepth: this.#promptQueue.length,
                };
                eventLog.emit("acp.crashed", postMortem);
                metrics.increment("acp_crashes");

                const stderrSnippet = postMortem.lastStderr.slice(-5).join("\n") || "none";
                const uptimeStr = this.#formatDuration(postMortem.uptimeSeconds);
                this.#broadcastAdmin(
                    `💥 *ACP crashed*\n` +
                    `Exit: code=${code} signal=${signal || "none"}\n` +
                    `Uptime: ${uptimeStr}\n` +
                    (activePromptScope ? `Active prompt: ${activePromptScope} (${promptElapsed}s)\n` : "") +
                    `Queue: ${this.#promptQueue.length} message(s)\n` +
                    `Last stderr:\n\`\`\`\n${stderrSnippet}\n\`\`\``
                );
            } else if (wasIntentional) {
                eventLog.emit("acp.stopped", {
                    exitCode: code,
                    signal,
                    intentional: true,
                    uptimeSeconds: acp.uptimeSeconds,
                });
            } else {
                // Clean exit (code 0, no signal)
                eventLog.emit("acp.stopped", {
                    exitCode: code,
                    signal,
                    intentional: false,
                    uptimeSeconds: acp.uptimeSeconds,
                });
            }
        } else {
            // Overflow exit — clean up overflow state
            this.#overflowScope = null;
            this.#overflowRef = null;
            if (this.#acpMgr) this.#acpMgr.release("overflow");
            if (code !== 0 && code !== null) {
                log.warn(`Overflow ACP crashed (code: ${code}). Will respawn on next demand.`);
            }
        }

        // Clear stale mode/model from scope
        const exitScope = getScope();
        if (exitScope) {
            exitScope.mode = "";
            exitScope.model = "";
            exitScope.promptRunning = false;
            exitScope.acpTag = null;
        }
        this.#statusMenu.refreshIfAlive().catch(() => {});
    }
    setupTelegramHandlers() {
        this.#telegram.on("update", (update) => {
            this.#processUpdate(update).catch((err) => {
                log.error(`Unhandled error in processUpdate: ${err.message}`);
            });
        });

        this.#telegram.on("conflict", () => {
            log.warn("Telegram 409 conflict — another process is polling this bot");
        });

        this.#telegram.on("poll_error", (err) => {
            log.warn(`Telegram poll error: ${err.message}`);
        });
    }

    // --- Build command context (public — used by TelegramAdapter) ---

    buildCommandContext(ref) {
        const scopeKey = ref.scopeKey || (this.#scopeMgr ? this.#scopeMgr.resolveKey(ref) : null);
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : this.#activeScope;
        return {
            acp: this.#acp,
            telegram: this.#telegram,
            transport: this.#transport,
            chatId: ref.chatId,
            chatIds: this.#allowedChatIds,
            ref,
            scope,
            host: {
                submitSlashCommand: (r, t) => this.submitSlashCommand(r, t),
                showStatusMenu: (cid, s) => this.showStatusMenu(cid, s),
                cancelActivePromptForScope: (...a) => this.cancelActivePromptForScope(...a),
                submitRetry: (r, t) => this.submitRetry(r, t),
                resetPreamble: () => this.resetPreamble(),
                startCopilot: () => this.startCopilot(),
                stopCopilot: () => this.stopCopilot(),
                restartCopilot: () => this.restartCopilot(),
                standingOrchestrator: this.standingOrchestrator,
            },
            buttons: this.#buttons,
            models: this.#models,
            modes: this.#modes,
            history: scope?.history || null,
            availableCommands: this.#availableCommands,
            knownTools: this.#knownTools,
            pairing: this.#pairing,
            sessionMgr: this.#sessionMgr,
            scopeMgr: this.#scopeMgr,
            config: this.#config,
            promptActive: this.#promptActive,
            promptElapsed: this.#promptActive && this.#promptStartedAt ? Math.round((Date.now() - this.#promptStartedAt) / 1000) : null,
            acpLastMessageAge: this.#acp?.lastMessageAt ? Math.round((Date.now() - this.#acp.lastMessageAt) / 1000) : null,
            acpLastMessageType: this.#acp?.lastMessageType || null,
            queueDepth: this.#promptQueue.length,
        };
    }

    // --- Rate limiting (delegated to TelegramAdapter) ---

    #checkRateLimit(userId) {
        return this.#adapter.checkRateLimit(userId);
    }

    // --- Inbound message processing ---

    async #handleCallbackQuery(query) {
        return this.#adapter.handleCallbackQuery(query);
    }

    async #handleMembershipChange(memberUpdate) {
        return this.#adapter.handleMembershipChange(memberUpdate);
    }

    /** Handle an edited Telegram message — update queue, cancel+resubmit, or send correction. */
    async #handleEditedMessage(edited) {
        const editedText = edited.text || edited.caption || "";
        const messageId = edited.message_id;
        const chatId = edited.chat.id;

        if (!editedText.trim()) return;

        log.info(`Edited message: chat=${chatId} msg=${messageId} len=${editedText.length}`);

        // Check if this message is still in the prompt queue (not yet processing)
        const queueIdx = this.#promptQueue.findIndex(p => p.messageId === messageId);
        if (queueIdx !== -1) {
            const entry = this.#promptQueue[queueIdx];
            const ref = entry.ref;
            const prefix = this.#promptBuilder.getPrefix(ref);
            entry.text = prefix + editedText;
            log.debug(`Updated queued prompt with edited text for msg=${messageId}`);
            this.#telegram.enqueue(() =>
                this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
            );
            return;
        }

        // Check if currently being processed (same message) — cancel and resubmit
        if (this.#activeRef && messageId === this.#activeRef.triggerMessageId) {
            log.info(`Edit to active message msg=${messageId} — cancelling current prompt`);
            this.#editCancelled = true;
            try {
                if (this.#acp?.alive) await this.#acp.cancel();
            } catch (err) {
                log.warn(`Cancel during edit failed: ${err.message}`);
            }
            const scope = this.#activeScope;
            if (scope?.composer?.active) {
                await scope.composer.abort("✏️ Message edited — reprocessing...");
                scope.composer = null;
            }
            const editRef = makeRef(chatId, edited.message_thread_id || null, null, edited.chat.type);
            editRef.userId = edited.from?.id;
            editRef.username = edited.from?.username || edited.from?.first_name;
            editRef.firstName = edited.from?.first_name || null;
            editRef.triggerMessageId = messageId;
            if (this.#scopeMgr) editRef.scopeKey = this.#scopeMgr.resolveKey(editRef);
            const editPrefix = this.#promptBuilder.getPrefix(editRef);
            this.#promptQueue.unshift({
                text: editPrefix + editedText,
                opts: {},
                ref: editRef,
                messageId,
                scopeKey: editRef.scopeKey,
            });
            this.#telegram.enqueue(() =>
                this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
            );
            return;
        }

        // Message was already processed — send correction as new prompt
        const userId = edited.from?.id;
        const threadId = edited.message_thread_id || null;
        if (userId == null) return;

        // Auth check
        if (this.#pairing) {
            if (!this.#pairing.isPaired(userId)) {
                log.warn(`Ignoring edit from unpaired user: ${userId}`);
                return;
            }
        } else {
            if (!this.#allowedChatIds.includes(userId)) {
                log.warn(`Ignoring edit from unauthorized user: ${userId}`);
                return;
            }
        }

        const ref = makeRef(chatId, threadId, null, edited.chat.type);
        ref.userId = userId;
        ref.username = edited.from?.username || edited.from?.first_name;

        if (this.#scopeMgr) {
            ref.scopeKey = this.#scopeMgr.resolveKey(ref);
        }

        const prefix = this.#promptBuilder.getPrefix(ref);
        const correctionPrompt = prefix + `[CORRECTION — The user edited their previous message. This is NOT a new request. Do NOT re-execute any actions already taken. Just acknowledge the correction or adjust your previous response if needed.]\nCorrected message: ${editedText}`;

        this.#telegram.enqueue(() =>
            this.#telegram.setMessageReaction(chatId, messageId, "✏️").catch(() => {})
        );
        await this.#queuePrompt(correctionPrompt, {}, ref, messageId);
    }

    async #processUpdate(update) {
        // Handle callback queries (inline keyboard buttons)
        if (update.callback_query) {
            await this.#handleCallbackQuery(update.callback_query);
            return;
        }

        // Handle bot membership changes (added/removed from groups)
        if (update.my_chat_member) {
            await this.#handleMembershipChange(update.my_chat_member);
            return;
        }

        // Handle edited messages
        if (update.edited_message) {
            await this.#handleEditedMessage(update.edited_message);
            return;
        }

        const message = update.message;
        if (!message) return;

        const chatId = message.chat.id;
        const userId = message.from?.id;
        const username = message.from?.username || message.from?.first_name || null;
        if (userId == null) return;

        log.info(`Incoming message: chatId=${chatId} userId=${userId} chatType=${message.chat.type} len=${(message.text || "").length}`);

        const threadId = message.message_thread_id || null;
        const isForum = message.chat.is_forum === true;
        let text = message.text || message.caption || "";

        // --- Auth check: pairing-based or legacy allowed_chat_ids ---
        if (this.#pairing) {
            // Update username for known users
            if (this.#pairing.isPaired(userId)) {
                this.#pairing.updateUsername(userId, username);
            } else {
                // Check if user has a pending code — they might be entering it
                if (this.#pairing.hasPendingCode(userId)) {
                    const verified = this.#pairing.verifyCode(userId, text);
                    if (verified) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "✅ Paired successfully! You can now use the bot.")
                        );
                        // Notify admin
                        this.#notifyAdminPairing(userId, username, chatId);
                    } else {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(chatId, "❌ Invalid or expired code. Check HA logs for a fresh code.")
                        );
                    }
                    return;
                }

                // Not paired — start pairing flow (works in DMs and groups)
                const code = this.#pairing.generateCode(userId, username);
                const isGroup = message.chat.type !== "private";
                const prompt = isGroup
                    ? `🔐 Hi ${username || "there"}! Pairing required.\n\nA code has been generated — check HA add-on logs or ask the admin.\nReply here or DM me with the code.\n\n⏳ Expires in 15 minutes.`
                    : `🔐 Pairing required\n\nA pairing code has been generated.\nCheck your Home Assistant add-on logs and enter the code here.\n\n⏳ Code expires in 15 minutes.`;
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, prompt)
                );
                // Notify admin about new pairing request
                this.#notifyAdminPairingRequest(userId, username, isGroup, chatId);
                return;
            }
        } else {
            // Legacy mode: check allowed_chat_ids
            if (!this.#allowedChatIds.includes(userId)) {
                log.warn(`Ignoring message from unauthorized user: ${userId}`);
                return;
            }
        }

        // --- Group mention filter (non-forum groups only) ---
        const chatType = message.chat.type;
        const groupMode = this.#config.groupMode || "mention";
        if ((chatType === "group" || chatType === "supergroup") && !isForum && groupMode !== "all") {
            const botUsername = this.#telegram.botInfo?.username;
            const botId = this.#telegram.botInfo?.id;

            // Check 1: @mention via Telegram entities
            const entities = message.text ? (message.entities || []) : (message.caption_entities || []);
            const mentioned = entities.some((e) =>
                e.type === "mention" &&
                text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername?.toLowerCase()}`
            );

            // Check 2: Reply to bot message
            const repliedToBot = message.reply_to_message?.from?.id === botId;

            // Check 3: Slash command with @botname
            const commandForBot = text.startsWith("/") &&
                text.toLowerCase().includes(`@${botUsername?.toLowerCase()}`);

            log.debug(`Group filter: mentioned=${mentioned} repliedToBot=${repliedToBot} commandForBot=${commandForBot} entities=${entities?.length || 0}`);

            if (!mentioned && !repliedToBot && !commandForBot) {
                log.debug(`Group message ignored — not addressed to bot`);
                return; // Not addressed to us — silently ignore
            }

            // Strip @botname from the text
            if (botUsername) {
                text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
            }
        }

        if (!this.#checkRateLimit(userId)) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, "⏳ Rate limit reached (10 messages/minute). Please wait.")
            );
            return;
        }

        // Handle pinned messages as agent instructions (after auth check)
        if (message.pinned_message) {
            const chatType = message.chat.type;
            if (chatType === "group" || chatType === "supergroup") {
                const pairingAdmin = this.#pairing?.isAdmin(userId) === true;
                if (!pairingAdmin) {
                    try {
                        const member = await this.#telegram.call("getChatMember", {
                            chat_id: chatId,
                            user_id: userId,
                        });
                        if (!["administrator", "creator"].includes(member?.status)) {
                            log.warn(`Non-admin ${userId} tried to pin instructions in group ${chatId}`);
                            return;
                        }
                    } catch (err) {
                        log.warn(`Rejecting pinned instructions for ${userId} in group ${chatId}: ${err.message}`);
                        return;
                    }
                }
            }

            const pinned = message.pinned_message;
            const pinnedText = (pinned.text || pinned.caption || "").trim().slice(0, 2000);
            if (pinnedText) {
                // Cap to 20 chats to prevent unbounded growth
                if (this.#pinnedInstructions.size >= 20 && !this.#pinnedInstructions.has(chatId)) {
                    const oldest = this.#pinnedInstructions.keys().next().value;
                    this.#pinnedInstructions.delete(oldest);
                }
                const sanitizedPinnedText = sanitizePinnedInstruction(pinnedText);
                this.#pinnedInstructions.set(chatId, sanitizedPinnedText);
                this.resetPreamble(); // force preamble refresh across all scopes
                log.info(`Pinned instruction set for chat=${chatId}: ${sanitizedPinnedText.substring(0, 100)}`);
                this.#telegram.enqueue(() =>
                    this.#telegram.sendMessage(chatId, "📌 Noted! This pinned message will be included as context for all future messages in this chat.")
                );
            }
            return;
        }

        // Build ConversationRef with scope resolution
        const ref = makeRef(chatId, threadId, null, message.chat.type);
        ref.userId = userId;
        ref.firstName = message.from?.first_name || null;
        ref.username = message.from?.username || null;
        ref.triggerMessageId = message.message_id;

        // Resolve scope
        const scopeKey = this.#scopeMgr ? this.#scopeMgr.resolveKey(ref) : `dm:${userId}`;
        const scope = this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : null;
        ref.scopeKey = scopeKey;
        if (scope?.sessionId) ref.sessionId = scope.sessionId;

        // --- Forum routing ---
        if (isForum && this.#scopeMgr) {
            // Auto-detect forum chat on first message
            if (!this.#scopeMgr.isForumChat(chatId)) {
                this.#scopeMgr.setForumChat(chatId);
                log.info(`Forum chat detected: ${chatId}`);
            }

            // Management topic: commands only, no ACP routing
            if (this.#scopeMgr.isManagementTopic(ref)) {
                if (scope) scope.history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });

                if (message.text?.startsWith("/")) {
                    const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
                    if (parsed) {
                        await handleSlashCommand(this.buildCommandContext(ref), parsed.command, parsed.args);
                        return;
                    }
                }

                // Non-command in management topic
                this.#telegram.enqueue(() =>
                    this.#transport.send(ref, "💡 This is the management topic. Use commands like /new, /status, /sessions, /help.")
                );
                return;
            }
        }

        // Track incoming user message in history
        if (scope) scope.history.push({ role: "user", text, messageId: message.message_id, replyToMessageId: message.reply_to_message?.message_id });

        // Check if scope has a pending elicitation or MCP question (text input)
        // Only intercept if the pendingElicitation has a resolve function
        // (not just { reserved: true } from the atomic TOCTOU guard)
        if (scope?.pendingElicitation && typeof scope.pendingElicitation.resolve === "function") {
            // Let /stop and /cancel through to the slash command handler
            if (text.startsWith("/")) {
                const parsed = parseSlashCommand(text, this.#telegram.botInfo?.username);
                if (parsed && (parsed.command === "stop" || parsed.command === "cancel")) {
                    scope.pendingElicitation.resolve(undefined);
                    scope.pendingElicitation = null;
                    // Fall through to slash command handler below
                } else {
                    // Other slash commands: treat as the answer text
                    scope.pendingElicitation.resolve(text);
                    scope.pendingElicitation = null;
                    return;
                }
            } else {
                const { resolve, schema } = scope.pendingElicitation;
                let value = text;
                // Type coercion for number/integer schemas
                if (schema?.type === "number" || schema?.type === "integer") {
                    if (!text || !text.trim()) {
                        await this.#telegram.sendMessage(chatId, "⚠️ Please enter a valid number.");
                        return;
                    }
                    const num = Number(text.trim());
                    if (isNaN(num)) {
                        await this.#telegram.sendMessage(chatId, "⚠️ Please enter a valid number.");
                        return;
                    }
                    value = schema.type === "integer" ? Math.round(num) : num;
                }
                resolve(value);
                scope.pendingElicitation = null;
                return;
            }
        }

        // Handle slash commands BEFORE typing
        if (message.text?.startsWith("/")) {
            const parsed = parseSlashCommand(message.text, this.#telegram.botInfo?.username);
            if (parsed) {
                const handled = await handleSlashCommand(this.buildCommandContext(ref), parsed.command, parsed.args);
                if (handled) return;
            }
            // Unknown command — fall through to prompt
        }

        // Start typing
        this.#startTyping(ref);

        // Ensure Copilot is running
        if (!this.#acp.alive) {
            try {
                await this.startCopilot();
            } catch (err) {
                this.#stopTyping();
                if (scope?.composer) {
                    await scope.composer.abort(formatError(err));
                    scope.composer = null;
                }
                if (scope) scope.activeTools.clear();
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                return;
            }
        }

        // Build prompt
        const prefix = this.#promptBuilder.getPrefix(ref);
        const replyContext = this.#extractReplyContext(message);
        let promptText = prefix + (replyContext ? replyContext + "\n" : "") + (text || "");

        // Handle file attachments
        if (message.photo || message.document) {
            try {
                const attachment = await this.#handleFileAttachment(message);
                if (attachment) {
                    if (attachment.isImage) {
                        await this.#queuePrompt(promptText || prefix + "User sent a file.", {
                            images: [{
                                data: attachment.buffer.toString("base64"),
                                mimeType: attachment.mimeType || "image/png",
                            }],
                        }, ref, message.message_id);
                        return;
                    }
                    if (attachment.textContent) {
                        const fileContext = `User attached file '${attachment.displayName}':\n\`\`\`\n${attachment.textContent}\n\`\`\``;
                        promptText = promptText ? `${fileContext}\n\n${promptText}` : prefix + fileContext;
                        await this.#queuePrompt(promptText, {}, ref, message.message_id);
                        return;
                    }
                    // Non-image, non-text file — let the model know
                    const sizeKB = Math.round(attachment.buffer.length / 1024);
                    const notice = `User attached a file '${attachment.displayName}' (${attachment.mimeType || 'unknown type'}, ${sizeKB}KB) but it's too large or not a text format I can read.`;
                    promptText = promptText ? `${notice}\n\n${promptText}` : prefix + notice;
                    await this.#queuePrompt(promptText, {}, ref, message.message_id);
                    return;
                }
            } catch (err) {
                this.#transport.enqueueSend(ref, formatError(err));
                return;
            }
        }

        // Handle stickers — extract emoji and send as context
        if (message.sticker) {
            const emoji = message.sticker.emoji || "🎭";
            const stickerText = `User sent a sticker: ${emoji}`;
            await this.#queuePrompt(prefix + stickerText, {}, ref, message.message_id);
            return;
        }

        // Handle location — valuable for Home Assistant context
        if (message.location) {
            const { latitude, longitude } = message.location;
            const locationText = `User shared their location: ${latitude}°, ${longitude}°`;
            await this.#queuePrompt(prefix + locationText, {}, ref, message.message_id);
            return;
        }

        // Handle voice messages — friendly rejection with suggestion
        if (message.voice || message.audio) {
            this.#transport.enqueueSend(ref, "🎤 Voice/audio messages aren't supported yet. Please type your message or use your keyboard's speech-to-text button.");
            return;
        }

        // Handle video — friendly rejection with suggestion
        if (message.video || message.video_note) {
            this.#transport.enqueueSend(ref, "🎬 I can't process videos yet. Try sending a screenshot or photo instead!");
            return;
        }

        // Handle animations/GIFs — friendly rejection
        if (message.animation) {
            this.#transport.enqueueSend(ref, "🎞️ I can't process GIFs. Try sending a photo instead!");
            return;
        }

        // Handle contact — friendly rejection
        if (message.contact) {
            this.#transport.enqueueSend(ref, "👤 I can't process contact cards. How can I help you?");
            return;
        }

        // Silently ignore polls (not directed at bot)
        if (message.poll) {
            return;
        }

        if (promptText.trim()) {
            await this.#queuePrompt(promptText, {}, ref, message.message_id);
            return;
        }

        this.#transport.enqueueSend(ref, "Unsupported message type.");
    }

    // --- Session management ---

    /**
     * Ensure the scope has a valid ACP session (switch or create).
     * Returns true if ready, false if failed (caller should return early).
     */
    async #ensureScopeSession(scope, scopeKey, ref) {
        if (scope.sessionId) {
            // Check if we need to switch sessions
            if (this.#scopeMgr && this.#scopeMgr.needsSwitch(scopeKey)) {
                this.#switching = true;
                try {
                    log.debug(`Switching session to ${scope.sessionId} for ${scopeKey}`);
                    await this.#acp.loadSession(scope.sessionId);
                    this.#scopeMgr.setActive(scopeKey);
                } catch (err) {
                    log.warn(`Session load failed for ${scope.sessionId}: ${err.message} — creating new session`);
                    try {
                        const result = await this.#acp.newSession({
                            cwd: this.#config.workingDirectory || "/config",
                        });
                        scope.sessionId = result.sessionId;
                        if (ref) ref.sessionId = result.sessionId;
                        scope.preambleSent = false;
                        if (this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);
                    } catch (createErr) {
                        log.warn(`Fallback session create failed: ${createErr.message}`);
                        const msg = `⚠️ Could not create session: ${createErr.message}`;
                        if (scope.composer?.active) {
                            await scope.composer.abort(msg);
                            scope.composer = null;
                        } else if (ref) {
                            this.#transport.enqueueSend(ref, msg);
                        }
                        this.#promptActive = false;
                        this.#activeRef = null;
                        this.#activeScope = null;
                        this.#scopeMgr?.clearActive();
                        return false;
                    }
                } finally {
                    this.#switching = false;
                }
            }
        } else {
            // New scope — create session
            try {
                log.debug(`Auto-creating session for scope ${scopeKey}`);
                const result = await this.#acp.newSession({
                    cwd: this.#config.workingDirectory || "/config",
                });
                scope.sessionId = result.sessionId;
                if (ref) ref.sessionId = result.sessionId;
                scope.preambleSent = false;
                if (this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);
            } catch (err) {
                log.warn(`Auto-create session failed: ${err.message}`);
                const msg = `⚠️ Failed to create session: ${err.message}`;
                if (scope.composer?.active) {
                    await scope.composer.abort(msg);
                    scope.composer = null;
                } else if (ref) {
                    this.#transport.enqueueSend(ref, msg);
                }
                this.#promptActive = false;
                this.#activeRef = null;
                this.#activeScope = null;
                this.#scopeMgr?.clearActive();
                return false;
            }
        }
        return true;
    }

    // --- Prompt queue (one at a time) ---

    async #queuePrompt(text, opts = {}, ref = null, messageId = null) {
        const scopeKey = ref?.scopeKey || (this.#scopeMgr && ref ? this.#scopeMgr.resolveKey(ref) : null);

        if (this.#promptActive) {
            const existing = this.#promptQueue.find((p) => p.scopeKey === scopeKey);
            if (existing) {
                existing.text += `

[Follow-up]: ${text}`;
                existing.messageId = messageId;
                existing.ref = ref;
                if (opts?.images?.length) {
                    existing.opts = {
                        ...existing.opts,
                        ...opts,
                        images: [...(existing.opts?.images || []), ...opts.images],
                    };
                } else {
                    existing.opts = { ...existing.opts, ...opts };
                }
                log.debug(`Appended to queued prompt for ${scopeKey}`);
                return;
            }
            if (this.#promptQueue.length >= 10) {
                log.warn("Prompt queue full (10), rejecting new message");
                if (ref) {
                    this.#telegram.enqueue(() =>
                        this.#transport.send(ref, "❌ Queue is full — your message couldn't be processed. Please try again in a minute.")
                    );
                }
                return;
            }
            this.#promptQueue.push({ text, opts, ref, messageId, scopeKey });
            metrics.gauge("queue_depth", this.#promptQueue.length);
            log.debug(`Queue depth: ${this.#promptQueue.length} (added scope=${scopeKey})`);
            // Set ⏳ on the user's message to indicate it's queued
            if (ref && messageId) {
                this.#telegram.setMessageReaction(ref.chatId, messageId, "⏳").catch(() => {});
            }
            // Notify the waiting user
            const pos = this.#promptQueue.length;
            if (ref && pos > 0) {
                const activeScopeKey = this.#activeScope?.key;
                const isSameScope = activeScopeKey === scopeKey;
                if (!isSameScope) {
                    this.#telegram.enqueue(() =>
                        this.#transport.send(ref, `⏳ Queued (#${pos}) — another conversation is in progress. You'll get a response shortly.`)
                    );
                }
            }
            return;
        }
        this.#promptActive = true;

        // Increment prompt generation (prevents stale force-cancel from killing subsequent prompts)
        this.#promptGeneration++;

        // Start prompt watchdog and heartbeat
        this.#startPromptWatchdog(scopeKey);

        // Resolve scope for this prompt
        const scope = scopeKey && this.#scopeMgr ? this.#scopeMgr.getOrCreate(scopeKey) : null;

        // Reset turn-level tracking on scope
        if (scope) {
            scope.turnToolCount = 0;
            scope.turnToolErrors = 0;
            scope.lastBotMessageId = null;
            scope.touch();
        }

        // Set active ref and scope for ACP output routing
        this.#activeRef = ref;
        this.#activeScope = scope;
        if (scopeKey && this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);

        // Create composer for progressive message display
        if (ref && scope) {
            log.debug(`Creating ResponseComposer for chat=${ref.chatId}`);
            scope.composer = new ResponseComposer(this.#telegram);
            try {
                await scope.composer.start(ref);
                log.debug(`Composer started, messageId=${scope.composer.messageId}`);
            } catch (err) {
                log.warn(`Composer start failed: ${err.message}`);
            }
        }

        // Set reaction: ⚡ (now being processed)
        if (ref && messageId) {
            this.#telegram.setMessageReaction(ref.chatId, messageId, "⚡").catch(() => {});
        }

        try {
            // Session switching for scope-based sessions
            if (scope && this.#acp.alive) {
                const sessionOk = await this.#ensureScopeSession(scope, scopeKey, ref);
                if (!sessionOk) return;
            }

            if (scopeKey?.startsWith("group:")) {
                const name = ref?.firstName || `User ${ref?.userId}`;
                text = `[${name}]: ${text}`;
            }

            const promptStartMs = Date.now();
            const result = await this.#acp.prompt(text, opts);
            const elapsedMs = Date.now() - promptStartMs;
            const elapsed = (elapsedMs / 1000).toFixed(1);
            const toolCount = scope?.turnToolCount || 0;
            const toolErrors = scope?.turnToolErrors || 0;
            const hasContent = !!(scope?.messageBuffer?.trim());
            log.info(`Prompt completed: ${scopeKey || 'unknown'} in ${elapsed}s (${toolCount} tool calls${toolErrors ? `, ${toolErrors} errors` : ''})`);

            // Record metrics + event
            eventLog.emit("prompt.completed", {
                scopeKey,
                durationMs: elapsedMs,
                toolCount,
                toolErrors,
                hasContent,
            });
            metrics.recordDuration(elapsedMs);
            metrics.increment("tool_calls_total", toolCount);
            metrics.increment("tool_errors_total", toolErrors);

            // Detect empty response (context exhaustion / backend issue)
            // If prompt returned in <1s with no tool calls and no text, the session is likely exhausted
            if (parseFloat(elapsed) < 1.0 && toolCount === 0 && !hasContent && scope?.sessionId) {
                log.warn(`Empty response detected (${elapsed}s, 0 tools, no text) — session likely exhausted, creating new session`);
                eventLog.emit("session.exhausted", { sessionId: scope.sessionId, scopeKey });
                metrics.increment("sessions_exhausted");
                try {
                    const newSession = await this.#acp.newSession({
                        cwd: this.#config.workingDirectory || "/config",
                    });
                    scope.sessionId = newSession.sessionId;
                    if (ref) ref.sessionId = newSession.sessionId;
                    scope.preambleSent = false;
                    if (this.#scopeMgr) this.#scopeMgr.setActive(scopeKey);
                    log.info(`New session created after empty response: ${newSession.sessionId}`);

                    // Retry the prompt once with the new session
                    // Text already contains the preamble from the first attempt — reuse as-is
                    // Mark preambleSent true so the NEXT prompt after this doesn't double it
                    scope.preambleSent = true;
                    const retryResult = await this.#acp.prompt(text, opts);
                    const retryElapsed = ((Date.now() - promptStartMs) / 1000).toFixed(1);
                    log.info(`Retry prompt completed: ${scopeKey || 'unknown'} in ${retryElapsed}s (${scope?.turnToolCount || 0} tool calls)`);
                } catch (retryErr) {
                    log.error(`Empty response recovery failed: ${retryErr.message}`);
                    scope.preambleSent = false; // next prompt should include preamble
                    if (ref) {
                        this.#transport.enqueueSend(ref, `⚠️ Session expired. Please send your message again.`);
                    }
                }
            }
        } catch (err) {
            // Skip error handling if this prompt was cancelled due to a message edit
            if (this.#editCancelled) {
                log.info(`Prompt cancelled (edit): ${err.message}`);
            } else {
                log.error(`Prompt error: ${err.message}`);
                eventLog.emit("prompt.error", { scopeKey, error: err.message });
                metrics.increment("prompt_errors");
                if (scope) scope.turnToolErrors++;
                const userMsg = formatError(err);
                if (scope?.composer?.active) {
                    await scope.composer.abort(userMsg);
                    scope.composer = null;
                } else if (ref) {
                    this.#transport.enqueueSend(ref, userMsg);
                } else {
                    for (const cid of this.#allowedChatIds) {
                        this.#telegram.enqueue(() =>
                            this.#telegram.sendMessage(cid, userMsg)
                        );
                    }
                }
            }
        } finally {
            // Clear watchdog and heartbeat timers
            this.#clearPromptWatchdog();

            // Set reaction on user's message — response delivered
            // Skip if this prompt was cancelled due to an edit (the resubmitted prompt will set it)
            if (ref && messageId && !this.#editCancelled) {
                const emoji = scope?.turnToolErrors > 0 ? "⚠️" : "✅";
                this.#telegram.setMessageReaction(ref.chatId, messageId, emoji).catch(() => {});
            }
            this.#editCancelled = false;

            // Finalize composer if still active (safety net)
            await this.#finalizeComposer();
            this.#stopTyping();
            if (scope) scope.activeTools.clear();

            this.#promptActive = false;
            this.#activeRef = null;
            this.#activeScope = null;
            this.#lastProcessedScope = scopeKey;
            this.#lastProcessedAt = Date.now();
            if (this.#scopeMgr) this.#scopeMgr.clearActive();

            // Process queued prompts or restart ACP if killed
            if (!this.#acp.alive) {
                // ACP was killed (watchdog/force-cancel) — restart it
                try {
                    log.info("Restarting ACP after intentional kill...");
                    await this.startCopilot();
                } catch (err) {
                    log.error(`ACP restart failed: ${err.message}`);
                    if (this.#promptQueue.length > 0) {
                        this.#broadcastAdmin(`⚠️ ACP restart failed. ${this.#promptQueue.length} queued message(s) dropped.`);
                        this.#promptQueue = [];
                    }
                    return;
                }
            }
            if (this.#promptQueue.length > 0) {
                let nextIndex = 0;
                if (this.#lastProcessedScope && Date.now() - this.#lastProcessedAt < 5000) {
                    const affinityIndex = this.#promptQueue.findIndex((entry) => entry.scopeKey === this.#lastProcessedScope);
                    if (affinityIndex >= 0) nextIndex = affinityIndex;
                }
                const [next] = this.#promptQueue.splice(nextIndex, 1);
                metrics.gauge("queue_depth", this.#promptQueue.length);
                await this.#queuePrompt(next.text, next.opts, next.ref, next.messageId);
            }
        }
    }

    // --- Copilot lifecycle (delegated to CopilotLifecycle module) ---

    async startCopilot() {
        await this.#lifecycle.start();
    }

    async stopCopilot() {
        await this.#lifecycle.stop();
    }

    async restartCopilot() {
        await this.#lifecycle.restart();
    }

    /** Format seconds into a human-readable duration string. */
    #formatDuration(seconds) {
        if (!seconds && seconds !== 0) return "unknown";
        if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
        if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
        return `${seconds}s`;
    }

    // --- Reply-to context extraction ---

    #extractReplyContext(message) {
        return this.#adapter.extractReplyContext(message, this.#activeScope);
    }

    // --- File handling (delegated to TelegramAdapter) ---

    async #handleFileAttachment(message) {
        return this.#adapter.handleFileAttachment(message);
    }

    // --- Response Composer lifecycle ---

    async #finalizeComposer(getScope, getRef) {
        const scope = getScope ? getScope() : this.#activeScope;
        if (!scope?.composer) {
            this.#flushMessageBuffer(getScope, getRef);
            return;
        }

        const composer = scope.composer;
        scope.composer = null;

        if (scope.messageFlushTimer) {
            clearTimeout(scope.messageFlushTimer);
            scope.messageFlushTimer = null;
        }

        let fullText = scope.messageBuffer.trim();
        scope.messageBuffer = "";

        // If buffer is empty (e.g., last turn was tools-only with no text),
        // recover the last committed intermediate as the final answer (C15 fix)
        if (!fullText) {
            fullText = composer.popLastIntermediate();
        }

        if (!fullText && !composer.active) {
            await composer.cleanup();
            return;
        }

        let botHistoryEntry = null;
        if (fullText && scope.history) {
            botHistoryEntry = { role: "bot", text: fullText, messageId: null };
            scope.history.push(botHistoryEntry);
        }

        try {
            const overflow = await composer.finalize(fullText);

            if (composer.messageId) {
                scope.lastBotMessageId = composer.messageId;
            }

            if (overflow?.length > 0) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    for (let i = 0; i < overflow.length; i++) {
                        const chunk = overflow[i];
                        const chunkIndex = i;
                        this.#telegram.enqueue(async () => {
                            const html = markdownToTelegramHtml(chunk);
                            let sent;
                            try {
                                sent = await this.#transport.send(ref, html, "HTML");
                            } catch (err) {
                                if (err.message && /can.t parse|entit/i.test(err.message)) {
                                    sent = await this.#transport.send(ref, chunk);
                                } else { throw err; }
                            }
                            if (sent?.message_id) {
                                scope.lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0 && scope.history) {
                                    scope.history.push({
                                        role: "bot", text: `(continued)`, messageId: sent.message_id,
                                        replyToMessageId: botHistoryEntry?.messageId,
                                    });
                                }
                            }
                        });
                    }
                }
            } else if (botHistoryEntry && composer.messageId) {
                botHistoryEntry.messageId = composer.messageId;
            }

            // Send collapsible details (reasoning + steps) as trailing message
            if (composer.trailingHtml) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    const detailsHtml = composer.trailingHtml;
                    this.#telegram.enqueue(async () => {
                        try {
                            await this.#transport.send(ref, detailsHtml, "HTML");
                        } catch (err) {
                            log.error(`Trailing details send failed: ${err.message}`);
                        }
                    });
                }
            }
        } catch (err) {
            log.error(`Composer finalize error: ${err.message}`);
            if (fullText) {
                const ref = getRef ? getRef() : this.#activeRef;
                if (ref) {
                    const chunks = chunkMessage(fullText);
                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkIndex = i;
                        this.#telegram.enqueue(async () => {
                            const html = markdownToTelegramHtml(chunk);
                            let sent;
                            try {
                                sent = await this.#transport.send(ref, html, "HTML");
                            } catch (sendErr) {
                                if (sendErr.message && /can.t parse|entit/i.test(sendErr.message)) {
                                    sent = await this.#transport.send(ref, chunk);
                                } else { throw sendErr; }
                            }
                            if (sent?.message_id) {
                                scope.lastBotMessageId = sent.message_id;
                                if (chunkIndex === 0 && botHistoryEntry && !botHistoryEntry.messageId) {
                                    botHistoryEntry.messageId = sent.message_id;
                                } else if (chunkIndex > 0 && scope.history) {
                                    scope.history.push({
                                        role: "bot", text: `(continued)`, messageId: sent.message_id,
                                        replyToMessageId: botHistoryEntry?.messageId,
                                    });
                                }
                            }
                        });
                    }
                }
            }
        }
    }

    // --- Message buffer (accumulate chunks → send) ---

    #flushMessageBuffer(getScope, getRef) {
        const scope = getScope ? getScope() : this.#activeScope;
        if (scope?.messageFlushTimer) {
            clearTimeout(scope.messageFlushTimer);
            scope.messageFlushTimer = null;
        }
        if (!scope?.messageBuffer?.trim()) return;

        const content = scope.messageBuffer;
        scope.messageBuffer = "";

        const chunks = chunkMessage(content);
        const ref = getRef ? getRef() : this.#activeRef;

        if (ref) {
            for (const chunk of chunks) {
                this.#telegram.enqueue(() => this.#sendFormatted(ref, chunk));
            }
        } else {
            for (const chatId of this.#allowedChatIds) {
                const fallbackRef = makeRef(chatId);
                for (const chunk of chunks) {
                    this.#telegram.enqueue(() => this.#sendFormatted(fallbackRef, chunk));
                }
            }
        }
    }

    async #sendFormatted(ref, markdown, scope) {
        const html = markdownToTelegramHtml(markdown);
        const resolvedScope = scope || this.#activeScope;
        let sent;
        try {
            sent = await this.#transport.send(ref, html, "HTML");
        } catch (err) {
            if (err.message && /can.t parse|entit/i.test(err.message)) {
                sent = await this.#transport.send(ref, markdown);
            } else {
                throw err;
            }
        }
        if (sent?.message_id) {
            if (resolvedScope) resolvedScope.lastBotMessageId = sent.message_id;
            if (resolvedScope?.history) resolvedScope.history.push({ role: "bot", text: markdown, messageId: sent.message_id });
        }
        return sent;
    }

    // --- Relay images from tool results ---

    #relayToolImages(result, getRef) {
        const contents = result?.contents;
        if (!contents || !Array.isArray(contents)) return;

        for (const block of contents) {
            if (block.type === "image" && block.data && block.mimeType) {
                const bytes = Math.ceil(block.data.length * 3 / 4);
                const ref = getRef ? getRef() : this.#activeRef;
                const targets = ref ? [ref] : this.#allowedChatIds.map(id => makeRef(id));

                for (const targetRef of targets) {
                    if (bytes > MAX_PHOTO_BYTES) {
                        this.#telegram.enqueue(() =>
                            this.#transport.send(targetRef, "(Image too large for Telegram, >10MB)")
                        );
                        continue;
                    }
                    const buf = Buffer.from(block.data, "base64");
                    if (PHOTO_MIMES.has(block.mimeType)) {
                        this.#telegram.enqueue(() => this.#transport.sendPhoto(targetRef, buf, block.mimeType));
                    } else {
                        const ext = block.mimeType.split("/")[1] || "bin";
                        this.#telegram.enqueue(() =>
                            this.#transport.sendDocument(targetRef, buf, block.mimeType, `image.${ext}`)
                        );
                    }
                }
            }
        }
    }

    // --- Typing indicators ---

    #startTyping(ref) {
        this.#stopTyping();
        const doType = () => {
            const targetRef = ref || this.#activeRef;
            if (targetRef) {
                this.#telegram.enqueue(() => this.#transport.sendChatAction(targetRef).catch(() => {}));
            } else {
                for (const chatId of this.#allowedChatIds) {
                    this.#telegram.enqueue(() => this.#telegram.sendChatAction(chatId).catch(() => {}));
                }
            }
        };
        doType();
        this.#typingInterval = setInterval(doType, TYPING_INTERVAL_MS);
        this.#resetTypingDebounce();
    }

    #resetTypingDebounce() {
        if (this.#typingDebounce) clearTimeout(this.#typingDebounce);
        this.#typingDebounce = setTimeout(() => this.#stopTyping(), TYPING_DEBOUNCE_MS);
    }

    #stopTyping() {
        if (this.#typingInterval) { clearInterval(this.#typingInterval); this.#typingInterval = null; }
        if (this.#typingDebounce) { clearTimeout(this.#typingDebounce); this.#typingDebounce = null; }
    }

    // --- Broadcast to admin chats ---

    #broadcastAdmin(text) {
        for (const chatId of this.#allowedChatIds) {
            this.#telegram.enqueue(() =>
                this.#telegram.sendMessage(chatId, text)
            );
        }
    }

    /** Notify first admin that someone is requesting to pair. */
    #notifyAdminPairingRequest(userId, username, isGroup, sourceChatId) {
        this.#adapter.notifyAdminPairingRequest(userId, username, isGroup, sourceChatId);
    }

    /** Notify first admin that someone paired successfully. */
    #notifyAdminPairing(userId, username, sourceChatId) {
        this.#adapter.notifyAdminPairing(userId, username, sourceChatId);
    }

    // --- Cleanup ---

    cleanup() {
        this.#stopTyping();
        this.#clearPromptWatchdog();
        const scope = this.#activeScope;
        if (scope) scope.activeTools.clear();
        if (scope?.messageFlushTimer) clearTimeout(scope.messageFlushTimer);
        if (this.#scopeMgr) this.#scopeMgr.shutdown();
    }
}
