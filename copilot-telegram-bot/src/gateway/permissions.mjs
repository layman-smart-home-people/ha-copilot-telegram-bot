// ============================================================
// Permissions — Role gate for v7 (delegates to RBAC manager)
// ============================================================
// Resolves user roles, model tiers, and MCP profiles.
// Uses live RBACManager when available, falls back to config.

import { createLogger } from "../logger.mjs";

const log = createLogger("permissions");

export class Permissions {
    #ownerIds = new Set();
    #rbac = null;

    constructor({ config }) {
        // Owner IDs from add-on config (allowed_chat_ids) — always trusted
        for (const id of config.allowedChatIds || []) {
            this.#ownerIds.add(String(id));
        }
    }

    /** Wire the live RBAC manager (called after construction). */
    setRbac(rbac) {
        this.#rbac = rbac;
        log.info("Permissions wired to live RBAC manager");
    }

    /** Check if a user is allowed to interact at all. */
    isAllowed(userId) {
        const id = String(userId);
        if (this.#ownerIds.has(id)) return true;
        if (this.#rbac) return !!this.#rbac.getUser(Number(userId));
        return false;
    }

    /** Get user role: 'owner' | 'admin' | 'member' | 'guest' | null */
    getRole(userId) {
        const id = String(userId);
        if (this.#ownerIds.has(id)) return "owner";
        if (this.#rbac) {
            const user = this.#rbac.getUser(Number(userId));
            return user?.role || null;
        }
        return null;
    }

    /** Check if user is owner. */
    isOwner(userId) {
        return this.#ownerIds.has(String(userId));
    }

    /** Get the MCP profile to use for this user's role. */
    getMcpProfile(userId) {
        const role = this.getRole(userId);
        if (role === "guest") return "guest";
        return role ? "owner" : "guest";
    }

    /** Get the model tier for this user's role. */
    getModelTier(userId, config) {
        const role = this.getRole(userId);
        if (role === "guest") return config.guestModel || "fast";
        if (role) return config.defaultModel || "standard";
        return config.guestModel || "fast";
    }
}
