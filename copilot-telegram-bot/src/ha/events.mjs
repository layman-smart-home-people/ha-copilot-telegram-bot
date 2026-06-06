// ============================================================
// Home Assistant WebSocket Event Listener
// ============================================================
// Connects to Home Assistant via Supervisor, authenticates over the
// HA WebSocket protocol, subscribes to state_changed events, and
// re-emits normalized events via EventEmitter.

import { EventEmitter } from "node:events";
import { createLogger } from "../logger.mjs";

const DEFAULT_URL = "ws://supervisor/core/websocket";
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const NORMAL_CLOSE_CODE = 1000;
const STOP_TIMEOUT_MS = 5000;
const log = createLogger("ha");

export class HAEventListener extends EventEmitter {
    #token;
    #url;
    #ws = null;
    #connected = false;
    #shouldReconnect = false;
    #reconnectDelayMs = INITIAL_BACKOFF_MS;
    #reconnectTimer = null;
    #nextId = 1;
    #pendingRequests = new Map();
    #connectPromise = null;
    #connectResolve = null;
    #connectReject = null;

    constructor({
        token = process.env.SUPERVISOR_TOKEN,
        url = DEFAULT_URL,
    } = {}) {
        super();
        this.#token = token;
        this.#url = url || DEFAULT_URL;
    }

    get connected() {
        return this.#connected;
    }

    async start() {
        if (typeof WebSocket !== "function") {
            throw new Error("Global WebSocket is not available in this Node.js runtime");
        }
        if (!this.#token) {
            throw new Error("SUPERVISOR_TOKEN is required for Home Assistant WebSocket auth");
        }
        if (this.#connected) return;

        this.#shouldReconnect = true;
        this.#clearReconnectTimer();

        if (!this.#connectPromise) {
            this.#connectPromise = new Promise((resolve, reject) => {
                this.#connectResolve = resolve;
                this.#connectReject = reject;
            });
            this.#connect();
        }

        return this.#connectPromise;
    }

    async stop() {
        this.#shouldReconnect = false;
        this.#clearReconnectTimer();
        this.#rejectConnectPromise(new Error("HA event listener stopped"));

        const ws = this.#ws;
        this.#connected = false;
        this.#pendingRequests.clear();

        if (!ws || ws.readyState === WebSocket.CLOSED) {
            this.#ws = null;
            return;
        }

        const closed = new Promise((resolve) => {
            const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
            ws.addEventListener("close", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });

        try {
            if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
                ws.close(NORMAL_CLOSE_CODE, "Client stopping");
            }
        } catch {}

        await closed;
        if (this.#ws === ws) this.#ws = null;
    }

    #connect() {
        if (!this.#shouldReconnect) return;
        if (this.#ws && (this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN)) {
            return;
        }

        log.info(`HA WS connecting to ${this.#url}`);

        let ws;
        try {
            ws = new WebSocket(this.#url);
        } catch (err) {
            this.#handleDisconnect(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        this.#ws = ws;
        this.#connected = false;
        this.#pendingRequests.clear();

        ws.addEventListener("open", () => {
            if (ws !== this.#ws) return;
            log.info("HA WS connected; waiting for auth challenge");
        });

        ws.addEventListener("message", (event) => {
            void this.#handleMessage(ws, event);
        });

        ws.addEventListener("error", (event) => {
            const err = event?.error instanceof Error
                ? event.error
                : new Error("HA WebSocket transport error");
            log.warn(`HA WS error: ${err.message}`);
            this.#emitError(err);
        });

        ws.addEventListener("close", (event) => {
            if (ws !== this.#ws) return;
            const reason = event.reason ? ` (${event.reason})` : "";
            const err = new Error(`HA WebSocket closed: ${event.code}${reason}`);
            const cleanStop = !this.#shouldReconnect && event.code === NORMAL_CLOSE_CODE;
            this.#handleDisconnect(err, cleanStop);
        });
    }

    async #handleMessage(ws, event) {
        if (ws !== this.#ws) return;

        let message;
        try {
            message = JSON.parse(await this.#messageText(event.data));
        } catch (err) {
            const error = new Error(`Failed to parse HA WebSocket message: ${err instanceof Error ? err.message : String(err)}`);
            log.error(error.message);
            this.#emitError(error);
            return;
        }

        switch (message?.type) {
        case "auth_required":
            log.debug("HA WS auth_required received");
            this.#send({ type: "auth", access_token: this.#token });
            break;
        case "auth_ok":
            this.#connected = true;
            this.#reconnectDelayMs = INITIAL_BACKOFF_MS;
            log.info("HA WS authenticated");
            this.emit("connected");
            this.#resolveConnectPromise();
            this.#subscribeToStateChanged();
            break;
        case "auth_invalid": {
            const error = new Error(`HA WebSocket auth failed: ${message.message || "auth_invalid"}`);
            log.error(error.message);
            this.#emitError(error);
            this.#safeClose(4001, "Authentication failed");
            break;
        }
        case "ping":
            if (typeof message.id === "number") {
                this.#send({ id: message.id, type: "pong" });
            }
            break;
        case "pong":
            break;
        case "result":
            this.#handleResult(message);
            break;
        case "event":
            this.#handleEvent(message.event);
            break;
        default:
            log.debug(`HA WS ignored message type: ${String(message?.type || "unknown")}`);
        }
    }

    #handleResult(message) {
        const requestType = this.#pendingRequests.get(message.id);
        this.#pendingRequests.delete(message.id);

        if (message.success) {
            if (requestType === "subscribe_events") {
                log.info("HA WS subscribed to state_changed events");
            }
            return;
        }

        const detail = message.error ? JSON.stringify(message.error) : "unknown error";
        const error = new Error(`HA WebSocket request failed${requestType ? ` (${requestType})` : ""}: ${detail}`);
        log.error(error.message);
        this.#emitError(error);
        this.#safeClose(1011, "Request failed");
    }

    #handleEvent(event) {
        if (!event || event.event_type !== "state_changed") return;

        const payload = event.data || {};
        const newState = payload.new_state || {};
        const oldState = payload.old_state || {};
        const entityId = payload.entity_id || newState.entity_id || oldState.entity_id;

        if (!entityId) return;

        this.emit("state_changed", {
            entity_id: entityId,
            new_state: typeof newState.state === "string" ? newState.state : "",
            old_state: typeof oldState.state === "string" ? oldState.state : "",
            last_changed: newState.last_changed || oldState.last_changed || "",
            last_updated: newState.last_updated || oldState.last_updated || "",
            attributes: isPlainObject(newState.attributes) ? newState.attributes : {},
        });
    }

    #subscribeToStateChanged() {
        const id = this.#nextMessageId();
        this.#pendingRequests.set(id, "subscribe_events");
        this.#send({ id, type: "subscribe_events", event_type: "state_changed" });
    }

    #send(payload) {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error("HA WebSocket is not open");
        }
        ws.send(JSON.stringify(payload));
    }

    #safeClose(code, reason) {
        try {
            this.#ws?.close(code, reason);
        } catch {}
    }

    #handleDisconnect(error, cleanStop = false) {
        const wasConnected = this.#connected;
        this.#connected = false;
        this.#pendingRequests.clear();
        if (this.#ws?.readyState === WebSocket.CLOSED || cleanStop) this.#ws = null;

        if (wasConnected && !cleanStop) {
            log.warn("HA WS disconnected");
            this.emit("disconnected");
        }

        if (cleanStop || !this.#shouldReconnect) return;

        const delayMs = this.#reconnectDelayMs;
        this.#reconnectDelayMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
        log.warn(`${error.message}; reconnecting in ${Math.round(delayMs / 1000)}s`);

        if (this.#reconnectTimer) return;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#connect();
        }, delayMs);
    }

    #clearReconnectTimer() {
        if (!this.#reconnectTimer) return;
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
    }

    #nextMessageId() {
        return this.#nextId++;
    }

    #resolveConnectPromise() {
        if (!this.#connectResolve) return;
        this.#connectResolve();
        this.#connectPromise = null;
        this.#connectResolve = null;
        this.#connectReject = null;
    }

    #rejectConnectPromise(error) {
        if (!this.#connectReject) return;
        this.#connectReject(error);
        this.#connectPromise = null;
        this.#connectResolve = null;
        this.#connectReject = null;
    }

    #emitError(error) {
        if (this.listenerCount("error") > 0) {
            this.emit("error", error);
        }
    }

    async #messageText(data) {
        if (typeof data === "string") return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
        if (ArrayBuffer.isView(data)) {
            return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
        }
        if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
        return String(data);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
