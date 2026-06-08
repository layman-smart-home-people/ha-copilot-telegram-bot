// ============================================================
// Permissions — Simple 3-role gate for v7
// ============================================================
// Roles: owner (full access) | member (chat only) | guest (limited)
// Reads from /data/rbac.json if it exists, falls back to config.

import { readFileSync, existsSync } from "node:fs";
import { createLogger } from "../logger.mjs";

const log = createLogger("permissions");

export class Permissions {
    #ownerIds = new Set();
    #memberIds = new Set();
    #guestIds = new Set();

    constructor({ config }) {
        // Owner IDs from add-on config (allowed_chat_ids)
        for (const id of config.allowedChatIds || []) {
            this.#ownerIds.add(String(id));
        }

        // Load RBAC file if it exists for members/guests
        this.#loadRbac();
    }

    /** Check if a user is allowed to interact at all. */
    isAllowed(userId) {
        const id = String(userId);
        return this.#ownerIds.has(id) || this.#memberIds.has(id) || this.#guestIds.has(id);
    }

    /** Get user role: 'owner' | 'member' | 'guest' | null */
    getRole(userId) {
        const id = String(userId);
        if (this.#ownerIds.has(id)) return "owner";
        if (this.#memberIds.has(id)) return "member";
        if (this.#guestIds.has(id)) return "guest";
        return null;
    }

    /** Check if user is owner. */
    isOwner(userId) {
        return this.#ownerIds.has(String(userId));
    }

    /** Get the MCP profile to use for this user's role. */
    getMcpProfile(userId) {
        const role = this.getRole(userId);
        if (role === "owner" || role === "member") return "owner";
        return "guest";
    }

    /** Get the model tier for this user's role. */
    getModelTier(userId, config) {
        const role = this.getRole(userId);
        if (role === "owner") return config.defaultModel || "standard";
        if (role === "member") return config.defaultModel || "standard";
        return config.guestModel || "fast";
    }

    #loadRbac() {
        const path = "/data/rbac.json";
        if (!existsSync(path)) return;

        try {
            const data = JSON.parse(readFileSync(path, "utf-8"));
            if (data.users) {
                for (const [id, user] of Object.entries(data.users)) {
                    const role = user.role || user.effectiveRole;
                    if (role === "owner" || role === "admin") this.#ownerIds.add(String(id));
                    else if (role === "member") this.#memberIds.add(String(id));
                    else if (role === "guest") this.#guestIds.add(String(id));
                }
            }
            log.info(`Loaded roles: ${this.#ownerIds.size} owners, ${this.#memberIds.size} members, ${this.#guestIds.size} guests`);
        } catch (err) {
            log.warn(`Failed to load RBAC: ${err.message}`);
        }
    }
}
