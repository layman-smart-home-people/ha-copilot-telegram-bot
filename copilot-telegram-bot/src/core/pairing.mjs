// ============================================================
// PairingManager — Multi-user authentication via pairing codes
// ============================================================
// Generates time-limited pairing codes logged to HA add-on logs.
// Users enter codes via DM to pair their Telegram account.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.mjs";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No 0/O/1/I confusion
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const log = createLogger("pairing");

export class PairingManager {
    #persistPath;
    #users = new Map();       // userId → { username, pairedAt, isAdmin }
    #pendingCodes = new Map(); // code → { userId, username, expiresAt }
    #adminIds;                 // Set of admin user IDs (from allowed_chat_ids)

    constructor({ persistPath, preApprovedIds = [] }) {
        this.#persistPath = persistPath;
        this.#adminIds = new Set(preApprovedIds.map(Number));
        this.#load();

        // Auto-pair pre-approved IDs
        for (const id of this.#adminIds) {
            if (!this.#users.has(id)) {
                this.#users.set(id, {
                    username: null,
                    pairedAt: new Date().toISOString(),
                    isAdmin: true,
                });
            } else {
                // Ensure admin flag is set
                this.#users.get(id).isAdmin = true;
            }
        }
        this.#save();
    }

    /**
     * Check if a user is paired (allowed to use the bot).
     */
    isPaired(userId) {
        return this.#users.has(Number(userId));
    }

    /**
     * Check if a user is an admin.
     */
    isAdmin(userId) {
        const user = this.#users.get(Number(userId));
        return user?.isAdmin || this.#adminIds.has(Number(userId));
    }

    /**
     * Generate a pairing code for a user.
     * Logs the code to stdout (visible in HA add-on logs).
     * @returns {string} The generated code
     */
    generateCode(userId, username) {
        userId = Number(userId);

        // Clear any existing code for this user
        for (const [code, entry] of this.#pendingCodes) {
            if (entry.userId === userId) {
                this.#pendingCodes.delete(code);
            }
        }

        // Generate unique code
        let code;
        do {
            const bytes = randomBytes(CODE_LENGTH);
            code = Array.from(bytes)
                .map(b => CODE_CHARS[b % CODE_CHARS.length])
                .join("");
        } while (this.#pendingCodes.has(code));

        const expiresAt = Date.now() + CODE_TTL_MS;
        this.#pendingCodes.set(code, { userId, username, expiresAt });

        // Log to stdout — visible in HA add-on logs (make it obvious)
        const userLabel = username ? `@${username}` : `user`;
        log.info(`\n${"=".repeat(50)}`);
        log.info(`🔐 PAIRING CODE: ${code}`);
        log.info(`👤 For: ${userLabel} (ID: ${userId})`);
        log.info(`⏳ Expires in 15 minutes`);
        log.info(`${"=".repeat(50)}\n`);

        // Clean up expired codes
        this.#cleanExpired();

        return code;
    }

    /**
     * Verify a pairing code entered by a user.
     * @returns {boolean} true if code is valid and user is now paired
     */
    verifyCode(userId, code) {
        userId = Number(userId);
        code = code.trim().toUpperCase();

        this.#cleanExpired();

        const entry = this.#pendingCodes.get(code);
        if (!entry) return false;
        if (entry.userId !== userId) return false;
        if (Date.now() > entry.expiresAt) {
            this.#pendingCodes.delete(code);
            return false;
        }

        // Code is valid — pair the user
        this.#pendingCodes.delete(code);
        this.#users.set(userId, {
            username: entry.username,
            pairedAt: new Date().toISOString(),
            isAdmin: this.#adminIds.has(userId),
        });
        this.#save();

        log.info(`User ${entry.username || userId} paired successfully`);
        return true;
    }

    /**
     * Check if a user has a pending pairing code (waiting for input).
     */
    hasPendingCode(userId) {
        userId = Number(userId);
        this.#cleanExpired();
        for (const entry of this.#pendingCodes.values()) {
            if (entry.userId === userId) return true;
        }
        return false;
    }

    /**
     * Get all paired users.
     */
    getPairedUsers() {
        return Array.from(this.#users.entries()).map(([userId, info]) => ({
            userId,
            ...info,
        }));
    }

    /**
     * Revoke a user's pairing.
     */
    revoke(userId) {
        userId = Number(userId);
        if (this.#adminIds.has(userId)) {
            return false; // Cannot revoke admin users
        }
        const existed = this.#users.delete(userId);
        if (existed) this.#save();
        return existed;
    }

    /**
     * Update username for a paired user (e.g., when they message).
     */
    updateUsername(userId, username) {
        userId = Number(userId);
        const user = this.#users.get(userId);
        if (user && username && user.username !== username) {
            user.username = username;
            this.#save();
        }
    }

    // --- Persistence ---

    #load() {
        if (!existsSync(this.#persistPath)) return;
        try {
            const data = JSON.parse(readFileSync(this.#persistPath, "utf-8"));
            if (data.version !== 1) {
                log.warn(`Unknown persistence version: ${data.version}`);
                return;
            }
            for (const [id, info] of Object.entries(data.users || {})) {
                this.#users.set(Number(id), info);
            }
            log.info(`Loaded ${this.#users.size} paired users`);
        } catch (err) {
            log.error(`Failed to load ${this.#persistPath}: ${err.message}`);
        }
    }

    #save() {
        const data = {
            version: 1,
            users: Object.fromEntries(this.#users),
        };
        const tmp = this.#persistPath + ".tmp";
        try {
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, this.#persistPath);
        } catch (err) {
            log.error(`Failed to save: ${err.message}`);
        }
    }

    #cleanExpired() {
        const now = Date.now();
        for (const [code, entry] of this.#pendingCodes) {
            if (now > entry.expiresAt) {
                this.#pendingCodes.delete(code);
            }
        }
    }
}
