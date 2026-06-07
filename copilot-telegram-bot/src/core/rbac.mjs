// ============================================================
// RBACManager — Configurable Role-Based Access Control
// ============================================================
// Replaces PairingManager with hierarchical roles, capabilities,
// per-entity overrides, and delegation boundaries.
// Backward-compatible API: isPaired(), isAdmin(), etc.

import { readFileSync, writeFileSync, existsSync, renameSync, appendFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.mjs";

const log = createLogger("rbac");

// --- Constants ---

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const AUDIT_MAX_LINES = 10000;
const AUDIT_TRIM_TO = 7500; // trim to this when exceeding max

// Safe domains — controllable by entity:control:safe
export const SAFE_DOMAINS = new Set([
    "light", "switch", "fan", "cover", "media_player", "climate", "scene",
    "button", "input_boolean", "input_number", "input_select", "input_text",
    "input_datetime", "script", "humidifier", "vacuum", "remote", "number",
    "select", "text", "date", "time", "datetime",
]);

// Sensitive domains — require entity:control:sensitive
export const SENSITIVE_DOMAINS = new Set([
    "lock", "alarm_control_panel", "siren", "camera",
]);

// All valid capabilities
export const ALL_CAPABILITIES = new Set([
    "entity:read",
    "entity:search",
    "entity:control:safe",
    "entity:control:sensitive",
    "automation:read",
    "automation:write",
    "dashboard:read",
    "dashboard:write",
    "si:manage:own",
    "si:manage:all",
    "user:manage",
    "role:manage",
    "system:manage",
    "dev:tools",
    "agent:memory",
    "background:task",
    "reminder:manage",
]);

// Capability → tool mapping
const CAPABILITY_TOOLS = {
    "entity:read": [
        "ha_get_state", "ha_get_entity_state", "ha_get_history",
        "ha_search_entities", "ha_get_overview", "ha_deep_search",
        "ha_eval_template",
    ],
    "entity:search": [
        "ha_search_entities", "ha_get_overview", "ha_deep_search",
    ],
    "entity:control:safe": [
        // Handled via domain check in getRequiredCapability
    ],
    "entity:control:sensitive": [
        // Handled via domain check in getRequiredCapability
    ],
    "automation:read": [
        "ha_search_automations", "ha_get_automation",
        "ha_config_get_automation", "ha_config_get_script",
    ],
    "automation:write": [
        "ha_config_set_automation", "ha_config_delete_automation",
        "ha_config_set_script", "ha_config_delete_script",
    ],
    "dashboard:read": [
        "ha_config_get_dashboard", "ha_config_get_dashboards",
    ],
    "dashboard:write": [
        "ha_config_set_dashboard",
    ],
    "si:manage:own": [
        "si_create", "si_list", "si_get", "si_update", "si_delete", "si_toggle",
    ],
    "si:manage:all": [
        "si_create", "si_list", "si_get", "si_update", "si_delete", "si_toggle",
    ],
    "user:manage": [
        "rbac_list_users", "rbac_get_user", "rbac_set_user_role",
        "rbac_revoke_user", "rbac_create_invite",
    ],
    "role:manage": [
        "rbac_list_roles", "rbac_get_role", "rbac_create_role",
        "rbac_update_role", "rbac_delete_role",
    ],
    "system:manage": [
        "ha_restart", "ha_get_system_health", "ha_get_addon_info",
        "ha_manage_addon", "ha_create_backup",
        "si_reconnect",
    ],
    "dev:tools": [
        "bash", "edit", "create", "view", "grep", "glob",
    ],
    "agent:memory": [
        // Agent memory file operations — checked contextually
    ],
    "background:task": [
        "background_task",
    ],
    "reminder:manage": [
        // Reminder tools — checked contextually
    ],
};

// Build reverse map: toolName → capability
// Note: si_* tools map to si:manage:own (the less restrictive check).
// Ownership enforcement (own vs all) is handled at the application layer.
const TOOL_TO_CAPABILITY = new Map();
for (const [cap, tools] of Object.entries(CAPABILITY_TOOLS)) {
    for (const tool of tools) {
        if (typeof tool === "string") {
            if (!TOOL_TO_CAPABILITY.has(tool)) {
                TOOL_TO_CAPABILITY.set(tool, cap);
            }
        }
    }
}

// Tools that require special domain-based capability checks
const DOMAIN_CHECKED_TOOLS = new Set([
    "ha_call_service", "ha_bulk_control",
]);

// Tools that are safe for everyone (no capability needed)
const UNIVERSAL_TOOLS = new Set([
    "rbac_check_permission",
]);

// Default role definitions
const DEFAULT_ROLES = {
    owner: {
        rank: 100,
        inherits: null,
        capabilities: [], // Owner bypasses all checks; capabilities are moot
        builtin: true,
        icon: "👑",
        description: "System owner — bypasses all permission checks",
    },
    admin: {
        rank: 80,
        inherits: null, // admin gets explicit capabilities, not inheritance
        capabilities: [
            "entity:read", "entity:search", "entity:control:safe",
            "entity:control:sensitive", "automation:read", "automation:write",
            "dashboard:read", "dashboard:write", "si:manage:all",
            "user:manage", "role:manage", "system:manage",
            "dev:tools", "agent:memory", "background:task", "reminder:manage",
        ],
        builtin: true,
        icon: "🛡️",
        description: "Full administrator — can manage users, roles, system, and all devices",
    },
    member: {
        rank: 40,
        inherits: null,
        capabilities: [
            "entity:read", "entity:search", "entity:control:safe",
            "automation:read", "dashboard:read",
            "si:manage:own", "reminder:manage",
        ],
        builtin: true,
        icon: "👤",
        description: "Regular member — can control safe devices and read status",
    },
    guest: {
        rank: 10,
        inherits: null,
        capabilities: [
            "entity:read", "entity:search", "entity:control:safe",
        ],
        builtin: true,
        icon: "🏠",
        description: "Guest — can read status and control safe devices",
    },
};

export class RBACManager {
    #persistPath;
    #auditPath;
    #roles = {};           // roleName → { rank, inherits, capabilities[], builtin, icon, description }
    #users = new Map();    // userId → { username, displayName, role, pairedAt, pairedBy, expiresAt }
    #overrides = [];       // [{ entity_id, target_type, target_id, grants[], denies[] }]
    #invites = {};         // token → { role, createdBy, createdAt, expiresAt, roleExpiresAt, usedBy }
    #pendingCodes = new Map(); // code → { userId, username, expiresAt }
    #adminIds;             // Set of pre-approved admin IDs (from allowed_chat_ids)
    #capabilityCache = new Map(); // roleName → Set<capability>
    #expiryNotified = new Set(); // userIds already notified of expiry (in-memory only)

    constructor({ persistPath, preApprovedIds = [] }) {
        this.#persistPath = persistPath;
        this.#auditPath = persistPath.replace(/\.json$/, "-audit.log");
        this.#adminIds = new Set(preApprovedIds.map(Number));
        this.#load();

        // Auto-register pre-approved IDs as owners
        for (const id of this.#adminIds) {
            if (!this.#users.has(id)) {
                this.#users.set(id, {
                    username: null,
                    displayName: null,
                    role: "owner",
                    pairedAt: new Date().toISOString(),
                    pairedBy: "system",
                    expiresAt: null,
                });
            } else {
                // Ensure pre-approved IDs are at least owner
                const user = this.#users.get(id);
                if (user.role !== "owner") {
                    user.role = "owner";
                }
            }
        }
        this.#save();
    }

    // ==============================
    // Backward-compatible API
    // ==============================

    /** Check if a user is paired (has any role). */
    isPaired(userId) {
        userId = Number(userId);
        const user = this.#users.get(userId);
        if (!user) return false;
        // Expired users are not considered paired
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) return false;
        return true;
    }

    /** Check if a user is an admin (owner or admin role). */
    isAdmin(userId) {
        userId = Number(userId);
        if (this.#adminIds.has(userId)) return true;
        const user = this.#users.get(userId);
        if (!user) return false;
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) return false;
        return user.role === "owner" || user.role === "admin";
    }

    /** Get all paired users (backward-compatible format). */
    getPairedUsers() {
        return Array.from(this.#users.entries()).map(([userId, info]) => ({
            userId,
            username: info.username,
            pairedAt: info.pairedAt,
            isAdmin: info.role === "owner" || info.role === "admin",
            role: info.role,
            displayName: info.displayName,
            expiresAt: info.expiresAt,
        }));
    }

    /** Update username for a paired user. */
    updateUsername(userId, username) {
        userId = Number(userId);
        const user = this.#users.get(userId);
        if (user && username && user.username !== username) {
            user.username = username;
            this.#save();
        }
    }

    /** Revoke a user's access. */
    revoke(userId) {
        userId = Number(userId);
        // Cannot revoke pre-approved admin (owner) users
        if (this.#adminIds.has(userId)) return false;
        const user = this.#users.get(userId);
        const existed = this.#users.delete(userId);
        if (existed) {
            this.#invalidateCapabilityCache();
            this.#save();
            this.audit("ROLE_REVOKE", "system", userId, { previousRole: user?.role });
        }
        return existed;
    }

    // ==============================
    // Pairing code flow (preserved)
    // ==============================

    /** Generate a pairing code for a user. */
    generateCode(userId, username) {
        userId = Number(userId);
        // Clear any existing code for this user
        for (const [code, entry] of this.#pendingCodes) {
            if (entry.userId === userId) this.#pendingCodes.delete(code);
        }

        let code;
        do {
            const bytes = randomBytes(CODE_LENGTH);
            code = Array.from(bytes)
                .map(b => CODE_CHARS[b % CODE_CHARS.length])
                .join("");
        } while (this.#pendingCodes.has(code));

        const expiresAt = Date.now() + CODE_TTL_MS;
        this.#pendingCodes.set(code, { userId, username, expiresAt });

        const userLabel = username ? `@${username}` : `user`;
        log.info(`\n${"=".repeat(50)}`);
        log.info(`🔐 PAIRING CODE: ${code}`);
        log.info(`👤 For: ${userLabel} (ID: ${userId})`);
        log.info(`⏳ Expires in 15 minutes`);
        log.info(`${"=".repeat(50)}\n`);

        this.#cleanExpiredCodes();
        return code;
    }

    /** Verify a pairing code. Returns true if valid. */
    verifyCode(userId, code) {
        userId = Number(userId);
        code = code.trim().toUpperCase();
        this.#cleanExpiredCodes();

        const entry = this.#pendingCodes.get(code);
        if (!entry) return false;
        if (entry.userId !== userId) return false;
        if (Date.now() > entry.expiresAt) {
            this.#pendingCodes.delete(code);
            return false;
        }

        // Code valid — pair the user with default role
        this.#pendingCodes.delete(code);
        const role = this.#adminIds.has(userId) ? "owner" : "member";
        this.#users.set(userId, {
            username: entry.username,
            displayName: null,
            role,
            pairedAt: new Date().toISOString(),
            pairedBy: "pairing_code",
            expiresAt: null,
        });
        this.#save();
        log.info(`User ${entry.username || userId} paired as ${role}`);
        return true;
    }

    /** Check if a user has a pending pairing code. */
    hasPendingCode(userId) {
        userId = Number(userId);
        this.#cleanExpiredCodes();
        for (const entry of this.#pendingCodes.values()) {
            if (entry.userId === userId) return true;
        }
        return false;
    }

    // ==============================
    // New RBAC API
    // ==============================

    /** Get a user's role name. Returns null if not paired or expired. */
    getRole(userId) {
        userId = Number(userId);
        const user = this.#users.get(userId);
        if (!user) return null;
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) return null;
        return user.role;
    }

    /** Get full user record. Returns null if not found. */
    getUser(userId) {
        userId = Number(userId);
        const user = this.#users.get(userId);
        if (!user) return null;
        return { userId, ...user };
    }

    /** Check if user is an owner. */
    isOwner(userId) {
        userId = Number(userId);
        if (this.#adminIds.has(userId)) return true;
        const user = this.#users.get(userId);
        if (!user) return false;
        // Expired users lose owner status (unless pre-approved)
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) return false;
        return user.role === "owner";
    }

    /** Get a role configuration. */
    getRoleConfig(roleName) {
        return this.#roles[roleName] || null;
    }

    /** Get all role configurations. */
    getAllRoles() {
        return { ...this.#roles };
    }

    /** Get effective capabilities for a role (with inheritance). Cached. */
    getEffectiveCapabilities(roleName) {
        if (this.#capabilityCache.has(roleName)) {
            return this.#capabilityCache.get(roleName);
        }

        const caps = new Set();
        const visited = new Set();
        let current = roleName;

        while (current && !visited.has(current)) {
            visited.add(current);
            const role = this.#roles[current];
            if (!role) break;
            for (const cap of role.capabilities || []) {
                caps.add(cap);
            }
            current = role.inherits;
        }

        this.#capabilityCache.set(roleName, caps);
        return caps;
    }

    /**
     * Check if a user can perform a capability (optionally on a specific entity).
     * Implements the 8-step resolution algorithm from the design.
     * @returns {{ allowed: boolean, reason: string }}
     */
    canPerform(userId, capability, entityId = null) {
        userId = Number(userId);

        // 1. Owner always passes
        if (this.isOwner(userId)) {
            return { allowed: true, reason: "owner_bypass" };
        }

        // 2. Check active assignment
        const user = this.#users.get(userId);
        if (!user) {
            return { allowed: false, reason: "no_user" };
        }
        if (user.expiresAt && new Date(user.expiresAt) < new Date()) {
            return { allowed: false, reason: "expired" };
        }
        const roleName = user.role;
        if (!roleName || !this.#roles[roleName]) {
            return { allowed: false, reason: "invalid_role" };
        }

        // 3. Entity-level overrides (if entity specified)
        if (entityId) {
            // User-specific overrides on exact entity
            const userOverride = this.#findOverride("user", String(userId), entityId);
            if (userOverride?.denies?.includes(capability)) {
                return { allowed: false, reason: `user_override_deny:${entityId}` };
            }
            if (userOverride?.grants?.includes(capability)) {
                return { allowed: true, reason: `user_override_grant:${entityId}` };
            }

            // Role-specific overrides on exact entity
            const roleOverride = this.#findOverride("role", roleName, entityId);
            if (roleOverride?.denies?.includes(capability)) {
                return { allowed: false, reason: `role_override_deny:${entityId}` };
            }
            if (roleOverride?.grants?.includes(capability)) {
                return { allowed: true, reason: `role_override_grant:${entityId}` };
            }

            // Domain-level overrides (e.g., climate.*)
            const domain = entityId.split(".")[0];
            if (domain) {
                const domainWildcard = domain + ".*";

                const userDomainOverride = this.#findOverride("user", String(userId), domainWildcard);
                if (userDomainOverride?.denies?.includes(capability)) {
                    return { allowed: false, reason: `user_domain_deny:${domainWildcard}` };
                }
                if (userDomainOverride?.grants?.includes(capability)) {
                    return { allowed: true, reason: `user_domain_grant:${domainWildcard}` };
                }

                const roleDomainOverride = this.#findOverride("role", roleName, domainWildcard);
                if (roleDomainOverride?.denies?.includes(capability)) {
                    return { allowed: false, reason: `role_domain_deny:${domainWildcard}` };
                }
                if (roleDomainOverride?.grants?.includes(capability)) {
                    return { allowed: true, reason: `role_domain_grant:${domainWildcard}` };
                }
            }
        }

        // 4. Role base capabilities (with inheritance)
        const effectiveCaps = this.getEffectiveCapabilities(roleName);
        if (effectiveCaps.has(capability)) {
            return { allowed: true, reason: "role_capability" };
        }

        // 5. Default deny
        return { allowed: false, reason: "default_deny" };
    }

    /**
     * Determine which capability is required for a given tool call.
     * @param {string} toolName - The tool being called
     * @param {object} [toolArgs] - The tool arguments (for domain-based checks)
     * @returns {{ capability: string|null, entityId: string|null }}
     */
    getRequiredCapability(toolName, toolArgs = {}) {
        // Universal tools need no capability
        if (UNIVERSAL_TOOLS.has(toolName)) {
            return { capability: null, entityId: null };
        }

        // Domain-checked tools (ha_call_service, ha_bulk_control)
        if (DOMAIN_CHECKED_TOOLS.has(toolName)) {
            const domain = toolArgs?.domain || "";
            const entityId = toolArgs?.entity_id || null;

            if (SENSITIVE_DOMAINS.has(domain)) {
                return { capability: "entity:control:sensitive", entityId };
            }
            if (SAFE_DOMAINS.has(domain)) {
                return { capability: "entity:control:safe", entityId };
            }
            // Unknown domain — require admin-level
            if (domain) {
                return { capability: "system:manage", entityId };
            }
            // No domain info — check entity_id for domain
            if (entityId) {
                const d = entityId.split(".")[0];
                if (SENSITIVE_DOMAINS.has(d)) {
                    return { capability: "entity:control:sensitive", entityId };
                }
                if (SAFE_DOMAINS.has(d)) {
                    return { capability: "entity:control:safe", entityId };
                }
            }
            return { capability: "entity:control:safe", entityId };
        }

        // Lookup in reverse map
        const cap = TOOL_TO_CAPABILITY.get(toolName);
        if (cap) {
            return { capability: cap, entityId: toolArgs?.entity_id || null };
        }

        // Unknown tool — default deny (require admin)
        return { capability: "system:manage", entityId: null };
    }

    /**
     * Check if a user is allowed to call a specific tool.
     * Combines getRequiredCapability + canPerform.
     * For bulk tools, checks each entity individually.
     * @returns {{ allowed: boolean, reason: string, capability: string|null }}
     */
    checkToolPermission(userId, toolName, toolArgs = {}) {
        userId = Number(userId);

        // Owner bypasses everything
        if (this.isOwner(userId)) {
            return { allowed: true, reason: "owner_bypass", capability: null };
        }

        const { capability, entityId } = this.getRequiredCapability(toolName, toolArgs);

        // Universal tools — no capability needed
        if (capability === null) {
            return { allowed: true, reason: "universal_tool", capability: null };
        }

        // For bulk tools, check each entity individually for per-entity overrides
        if (toolName === "ha_bulk_control") {
            const entityIds = this.#extractBulkEntityIds(toolArgs);
            if (entityIds.length > 0) {
                for (const eid of entityIds) {
                    const result = this.canPerform(userId, capability, eid);
                    if (!result.allowed) {
                        return { ...result, capability };
                    }
                }
                return { allowed: true, reason: "all_entities_allowed", capability };
            }
        }

        const result = this.canPerform(userId, capability, entityId);
        return { ...result, capability };
    }

    // ==============================
    // Role management
    // ==============================

    /** Set a user's role. */
    setUserRole(userId, role, opts = {}) {
        userId = Number(userId);
        if (!this.#roles[role]) {
            throw new Error(`Unknown role: ${role}`);
        }

        const existing = this.#users.get(userId);
        const previousRole = existing?.role || null;
        this.#users.set(userId, {
            username: existing?.username || opts.username || null,
            displayName: opts.displayName !== undefined ? opts.displayName : (existing?.displayName || null),
            role,
            pairedAt: existing?.pairedAt || new Date().toISOString(),
            pairedBy: opts.pairedBy !== undefined ? opts.pairedBy : (existing?.pairedBy || "manual"),
            expiresAt: opts.expiresAt !== undefined ? opts.expiresAt : (existing?.expiresAt || null),
        });

        // Clear expiry notification flag so new expiry triggers notification
        this.#expiryNotified.delete(userId);

        this.#invalidateCapabilityCache();
        this.#save();
        this.audit("ROLE_GRANT", opts.pairedBy || "system", userId, {
            role, previousRole, expiresAt: opts.expiresAt || null,
        });
        log.info(`User ${userId} assigned role: ${role}`);
    }

    /** Create a custom role. */
    createRole(name, { rank, inherits = null, capabilities = [], icon = "", description = "" }) {
        if (this.#roles[name]) {
            throw new Error(`Role already exists: ${name}`);
        }
        if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
            throw new Error("Role name must be lowercase alphanumeric with - or _");
        }
        if (rank === 100) {
            throw new Error("Rank 100 is reserved for owner");
        }
        if (typeof rank !== "number" || rank < 1 || rank > 99) {
            throw new Error("Rank must be between 1 and 99");
        }
        if (inherits && !this.#roles[inherits]) {
            throw new Error(`Inherits from unknown role: ${inherits}`);
        }
        // Validate capabilities
        for (const cap of capabilities) {
            if (!ALL_CAPABILITIES.has(cap)) {
                throw new Error(`Unknown capability: ${cap}`);
            }
        }

        this.#roles[name] = {
            rank,
            inherits,
            capabilities: [...capabilities],
            builtin: false,
            icon: icon || "",
            description: description || "",
        };

        this.#invalidateCapabilityCache();
        this.#save();
        this.audit("ROLE_CREATE", "system", name, { rank, inherits, capabilities, icon, description });
        log.info(`Created role: ${name} (rank ${rank})`);
    }

    /** Update a role. Cannot modify owner's rank or builtin status. */
    updateRole(name, updates) {
        const role = this.#roles[name];
        if (!role) throw new Error(`Unknown role: ${name}`);
        if (name === "owner") {
            throw new Error("Cannot modify the owner role");
        }

        if (updates.rank !== undefined) {
            if (updates.rank === 100) throw new Error("Rank 100 is reserved for owner");
            if (typeof updates.rank !== "number" || updates.rank < 1 || updates.rank > 99) {
                throw new Error("Rank must be between 1 and 99");
            }
            role.rank = updates.rank;
        }
        if (updates.inherits !== undefined) {
            if (updates.inherits && !this.#roles[updates.inherits]) {
                throw new Error(`Inherits from unknown role: ${updates.inherits}`);
            }
            role.inherits = updates.inherits;
        }
        if (updates.capabilities !== undefined) {
            for (const cap of updates.capabilities) {
                if (!ALL_CAPABILITIES.has(cap)) throw new Error(`Unknown capability: ${cap}`);
            }
            role.capabilities = [...updates.capabilities];
        }
        if (updates.icon !== undefined) role.icon = updates.icon;
        if (updates.description !== undefined) role.description = updates.description;

        this.#invalidateCapabilityCache();
        this.#save();
        this.audit("ROLE_UPDATE", "system", name, updates);
        log.info(`Updated role: ${name}`);
    }

    /** Delete a non-builtin role. Fails if users are assigned. */
    deleteRole(name) {
        const role = this.#roles[name];
        if (!role) throw new Error(`Unknown role: ${name}`);
        if (role.builtin) throw new Error(`Cannot delete built-in role: ${name}`);

        // Check if any users are assigned this role
        for (const [userId, user] of this.#users) {
            if (user.role === name) {
                throw new Error(`Cannot delete role "${name}" — user ${userId} is still assigned`);
            }
        }

        // Check if any role inherits from this one
        for (const [rName, r] of Object.entries(this.#roles)) {
            if (r.inherits === name) {
                throw new Error(`Cannot delete role "${name}" — role "${rName}" inherits from it`);
            }
        }

        delete this.#roles[name];
        this.#invalidateCapabilityCache();
        this.#save();
        this.audit("ROLE_DELETE", "system", name, {});
        log.info(`Deleted role: ${name}`);
    }

    /** Check if a user can grant a specific role (delegation boundary). */
    canGrantRole(grantingUserId, targetRole) {
        grantingUserId = Number(grantingUserId);
        if (this.isOwner(grantingUserId)) return true;

        const grantingUser = this.#users.get(grantingUserId);
        if (!grantingUser) return false;

        const grantingRole = this.#roles[grantingUser.role];
        const target = this.#roles[targetRole];
        if (!grantingRole || !target) return false;

        return grantingRole.rank > target.rank;
    }

    // ==============================
    // Override management (Phase 4 will expand)
    // ==============================

    /** Get all overrides, optionally filtered. */
    getOverrides(filters = {}) {
        let result = [...this.#overrides];
        if (filters.entity_id) result = result.filter(o => o.entity_id === filters.entity_id);
        if (filters.target_type) result = result.filter(o => o.target_type === filters.target_type);
        if (filters.target_id) result = result.filter(o => o.target_id === filters.target_id);
        return result;
    }

    /** Add or update an override. */
    addOverride({ entity_id, target_type, target_id, grants = [], denies = [] }) {
        // Validate
        if (!entity_id) throw new Error("entity_id is required");
        if (!["user", "role"].includes(target_type)) throw new Error("target_type must be 'user' or 'role'");
        if (!target_id) throw new Error("target_id is required");

        for (const cap of [...grants, ...denies]) {
            if (!ALL_CAPABILITIES.has(cap)) throw new Error(`Unknown capability: ${cap}`);
        }

        // Remove existing override for same target
        this.#overrides = this.#overrides.filter(o =>
            !(o.entity_id === entity_id && o.target_type === target_type && o.target_id === target_id)
        );

        this.#overrides.push({ entity_id, target_type, target_id, grants, denies });
        this.#save();
        this.audit("OVERRIDE_ADD", "system", `${target_type}:${target_id}`, { entity_id, grants, denies });
        log.info(`Override added: ${target_type}:${target_id} on ${entity_id}`);
    }

    /** Remove an override. */
    removeOverride(entity_id, target_type, target_id) {
        const before = this.#overrides.length;
        this.#overrides = this.#overrides.filter(o =>
            !(o.entity_id === entity_id && o.target_type === target_type && o.target_id === target_id)
        );
        if (this.#overrides.length < before) {
            this.#save();
            this.audit("OVERRIDE_REMOVE", "system", `${target_type}:${target_id}`, { entity_id });
            return true;
        }
        return false;
    }

    // ==============================
    // Invite management (Phase 3 will expand)
    // ==============================

    /** Create an invite token. */
    createInvite(role, { createdBy, expiresAt = null, roleExpiresAt = null } = {}) {
        if (!this.#roles[role]) throw new Error(`Unknown role: ${role}`);
        if (role === "owner") throw new Error("Cannot create invites for owner role");

        const token = randomBytes(16).toString("hex");
        this.#invites[token] = {
            role,
            createdBy: createdBy || "system",
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt || null,
            roleExpiresAt: roleExpiresAt || null,
            usedBy: null,
        };
        this.#save();
        this.audit("INVITE_CREATE", createdBy || "system", role, { expiresAt, roleExpiresAt });
        return token;
    }

    /** Validate and consume an invite token. Returns role or null. */
    consumeInvite(token, userId) {
        const invite = this.#invites[token];
        if (!invite) return null;
        if (invite.usedBy) return null;
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return null;

        invite.usedBy = { userId, usedAt: new Date().toISOString() };
        this.#save();
        this.audit("INVITE_USE", userId, invite.role, { token: token.slice(0, 8) + "..." });
        return { role: invite.role, roleExpiresAt: invite.roleExpiresAt };
    }

    /** Get invite info (without consuming). */
    getInvite(token) {
        return this.#invites[token] || null;
    }

    // ==============================
    // Role description for prompts
    // ==============================

    /** Generate a role-aware preamble segment for the agent prompt. */
    getRoleDescription(userId) {
        userId = Number(userId);
        if (this.isOwner(userId)) return null; // owners need no restriction description

        const role = this.getRole(userId);
        if (!role) return null;

        const roleConfig = this.#roles[role];
        if (!roleConfig) return null;

        const effectiveCaps = this.getEffectiveCapabilities(role);
        const canDo = [];
        const cannotDo = [];

        // Build human-readable capability descriptions
        const capDescriptions = {
            "entity:read": "view entity states and history",
            "entity:search": "search and discover entities",
            "entity:control:safe": "control lights, climate, switches, fans, media",
            "entity:control:sensitive": "control locks, alarms, cameras, sirens",
            "automation:read": "view automations and scripts",
            "automation:write": "create/edit automations and scripts",
            "dashboard:read": "view dashboards",
            "dashboard:write": "edit dashboards",
            "si:manage:own": "manage own standing instructions (notify/evaluate only)",
            "si:manage:all": "manage all standing instructions (including wake_agent, ha_service)",
            "user:manage": "manage users and invites",
            "role:manage": "manage roles",
            "system:manage": "manage system settings, restart HA, manage add-ons",
            "dev:tools": "use developer tools (bash, file editing)",
            "agent:memory": "access agent memory files",
            "background:task": "run background tasks",
            "reminder:manage": "manage reminders",
        };

        for (const [cap, desc] of Object.entries(capDescriptions)) {
            if (effectiveCaps.has(cap)) {
                canDo.push(desc);
            } else {
                cannotDo.push(desc);
            }
        }

        const canStr = canDo.length > 0 ? `Can: ${canDo.join(", ")}.` : "";
        const cannotStr = cannotDo.length > 0 ? `Cannot: ${cannotDo.join(", ")}.` : "";
        const escalation = "If asked for something outside permissions, explain and offer to escalate to admin.";

        return `[User role: ${role} (${roleConfig.icon || ""} ${roleConfig.description || ""}) — ${canStr} ${cannotStr} ${escalation}]`;
    }

    // ==============================
    // Onboarding & delegation
    // ==============================

    /** Get all user IDs that have a specific capability. */
    getUsersWithCapability(capability) {
        const result = [];
        for (const [userId, user] of this.#users) {
            if (user.expiresAt && new Date(user.expiresAt) < new Date()) continue;
            if (this.isOwner(userId)) {
                result.push(userId);
                continue;
            }
            const caps = this.getEffectiveCapabilities(user.role);
            if (caps.has(capability)) result.push(userId);
        }
        return result;
    }

    /** Get roles that a user can grant (delegation boundary). Sorted by rank descending. */
    getGrantableRoles(grantingUserId) {
        grantingUserId = Number(grantingUserId);
        const result = [];
        for (const [name, role] of Object.entries(this.#roles)) {
            if (name === "owner") continue;
            if (this.canGrantRole(grantingUserId, name)) {
                result.push({ name, ...role });
            }
        }
        return result.sort((a, b) => b.rank - a.rank);
    }

    /** Get a welcome message for a given role. */
    getWelcomeMessage(roleName) {
        const role = this.#roles[roleName];
        if (!role) return "✅ Welcome! You can now use the bot.";

        const icon = role.icon || "👤";
        const caps = this.getEffectiveCapabilities(roleName);
        const abilities = [];

        if (caps.has("entity:read")) abilities.push("view device states");
        if (caps.has("entity:control:safe")) abilities.push("control lights, climate & switches");
        if (caps.has("entity:control:sensitive")) abilities.push("control locks & alarms");
        if (caps.has("automation:read")) abilities.push("view automations");
        if (caps.has("automation:write")) abilities.push("manage automations");
        if (caps.has("si:manage:own")) abilities.push("create standing instructions");
        if (caps.has("dev:tools")) abilities.push("use developer tools");

        const abilityStr = abilities.length > 0
            ? `\n\n🔑 You can: ${abilities.join(", ")}`
            : "";
        return `${icon} Welcome! You've been assigned the *${roleName}* role.${abilityStr}\n\nSend a message to get started!`;
    }

    /** Check for newly expired users (for notification purposes). Returns expired users not yet notified. */
    getNewlyExpiredUsers() {
        const expired = [];
        const now = new Date();
        for (const [userId, user] of this.#users) {
            if (user.expiresAt && new Date(user.expiresAt) < now && !this.#expiryNotified.has(userId)) {
                expired.push({ userId, username: user.username, displayName: user.displayName, role: user.role });
                this.#expiryNotified.add(userId);
                this.audit("ROLE_EXPIRE", "system", userId, { role: user.role });
            }
        }
        return expired;
    }

    // ==============================
    // Audit log
    // ==============================

    /** Append an event to the audit log. */
    audit(event, actor, target, details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            event,
            actor: String(actor),
            target: String(target),
            details,
        };
        try {
            appendFileSync(this.#auditPath, JSON.stringify(entry) + "\n");
        } catch (err) {
            log.error(`Audit log write failed: ${err.message}`);
        }
        // Rotate if needed (async-safe — just check size occasionally)
        this.#maybeRotateAuditLog();
    }

    /** Read audit log entries with optional filters and pagination. */
    getAuditLog({ limit = 50, offset = 0, event, actor, target } = {}) {
        if (!existsSync(this.#auditPath)) return { entries: [], total: 0 };
        try {
            const raw = readFileSync(this.#auditPath, "utf-8");
            let lines = raw.split("\n").filter(l => l.trim());
            let entries = [];
            for (const line of lines) {
                try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
            }
            // Newest first
            entries.reverse();
            // Apply filters
            if (event) entries = entries.filter(e => e.event === event);
            if (actor) entries = entries.filter(e => String(e.actor) === String(actor));
            if (target) entries = entries.filter(e => String(e.target) === String(target));
            const total = entries.length;
            return { entries: entries.slice(offset, offset + limit), total };
        } catch (err) {
            log.error(`Audit log read failed: ${err.message}`);
            return { entries: [], total: 0 };
        }
    }

    #maybeRotateAuditLog() {
        try {
            if (!existsSync(this.#auditPath)) return;
            const stat = statSync(this.#auditPath);
            // Only check if file > 500KB (rough proxy for line count)
            if (stat.size < 512 * 1024) return;
            const raw = readFileSync(this.#auditPath, "utf-8");
            const lines = raw.split("\n").filter(l => l.trim());
            if (lines.length <= AUDIT_MAX_LINES) return;
            const trimmed = lines.slice(-AUDIT_TRIM_TO).join("\n") + "\n";
            writeFileSync(this.#auditPath, trimmed);
            log.info(`Audit log rotated: ${lines.length} → ${AUDIT_TRIM_TO} entries`);
        } catch (err) {
            log.error(`Audit log rotation failed: ${err.message}`);
        }
    }

    // ==============================
    // Persistence
    // ==============================

    #load() {
        if (!existsSync(this.#persistPath)) {
            // Try migration from paired_users.json
            this.#migrateFromPairedUsers();
            return;
        }

        try {
            const data = JSON.parse(readFileSync(this.#persistPath, "utf-8"));
            if (data.version !== 2) {
                log.warn(`Unknown RBAC version: ${data.version}, starting fresh`);
                this.#seedDefaults();
                return;
            }

            // Load roles (merge with defaults to ensure builtins exist)
            this.#roles = { ...DEFAULT_ROLES };
            for (const [name, role] of Object.entries(data.roles || {})) {
                if (this.#roles[name]?.builtin) {
                    // Preserve builtin flag but allow customization
                    this.#roles[name] = { ...role, builtin: true };
                } else {
                    this.#roles[name] = role;
                }
            }

            // Load users
            for (const [id, info] of Object.entries(data.users || {})) {
                this.#users.set(Number(id), info);
            }

            // Load overrides
            this.#overrides = data.overrides || [];

            // Load invites
            this.#invites = data.invites || {};

            log.info(`Loaded RBAC: ${Object.keys(this.#roles).length} roles, ${this.#users.size} users, ${this.#overrides.length} overrides`);
        } catch (err) {
            log.error(`Failed to load ${this.#persistPath}: ${err.message}`);
            this.#seedDefaults();
        }
    }

    #migrateFromPairedUsers() {
        const legacyPath = "/data/paired_users.json";
        if (!existsSync(legacyPath)) {
            this.#seedDefaults();
            return;
        }

        try {
            const data = JSON.parse(readFileSync(legacyPath, "utf-8"));
            if (data.version !== 1) {
                log.warn(`Unknown paired_users version: ${data.version}`);
                this.#seedDefaults();
                return;
            }

            this.#seedDefaults();

            for (const [id, info] of Object.entries(data.users || {})) {
                const userId = Number(id);
                let role;

                if (info.isAdmin && this.#adminIds.has(userId)) {
                    role = "owner";
                } else if (info.isAdmin) {
                    role = "admin";
                } else {
                    role = "member";
                }

                this.#users.set(userId, {
                    username: info.username || null,
                    displayName: null,
                    role,
                    pairedAt: info.pairedAt || new Date().toISOString(),
                    pairedBy: "migrated",
                    expiresAt: null,
                });
            }

            log.info(`Migrated ${this.#users.size} users from paired_users.json`);
            this.#save();
        } catch (err) {
            log.error(`Failed to migrate from paired_users.json: ${err.message}`);
            this.#seedDefaults();
        }
    }

    #seedDefaults() {
        this.#roles = { ...DEFAULT_ROLES };
        // Deep copy capabilities arrays
        for (const [name, role] of Object.entries(this.#roles)) {
            this.#roles[name] = { ...role, capabilities: [...(role.capabilities || [])] };
        }
    }

    #save() {
        const data = {
            version: 2,
            roles: this.#roles,
            users: Object.fromEntries(this.#users),
            overrides: this.#overrides,
            invites: this.#invites,
        };
        const tmp = this.#persistPath + ".tmp";
        try {
            writeFileSync(tmp, JSON.stringify(data, null, 2));
            renameSync(tmp, this.#persistPath);
        } catch (err) {
            log.error(`Failed to save RBAC: ${err.message}`);
        }
    }

    #cleanExpiredCodes() {
        const now = Date.now();
        for (const [code, entry] of this.#pendingCodes) {
            if (now > entry.expiresAt) this.#pendingCodes.delete(code);
        }
    }

    #extractBulkEntityIds(toolArgs) {
        const ids = [];
        // Support common parameter patterns for bulk entity tools
        if (Array.isArray(toolArgs?.entity_ids)) {
            ids.push(...toolArgs.entity_ids);
        } else if (Array.isArray(toolArgs?.entities)) {
            for (const e of toolArgs.entities) {
                if (typeof e === "string") ids.push(e);
                else if (e?.entity_id) ids.push(e.entity_id);
            }
        } else if (typeof toolArgs?.entity_id === "string") {
            ids.push(toolArgs.entity_id);
        }
        return ids;
    }

    #findOverride(targetType, targetId, entityId) {
        return this.#overrides.find(o =>
            o.target_type === targetType &&
            o.target_id === targetId &&
            o.entity_id === entityId
        ) || null;
    }

    #invalidateCapabilityCache() {
        this.#capabilityCache.clear();
    }
}
