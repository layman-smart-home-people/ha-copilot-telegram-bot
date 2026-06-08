import { readFileSync, existsSync } from "node:fs";
import { createLogger } from "./logger.mjs";

const log = createLogger('config');

function normalizeGroupMode(value) {
    return value === "all" ? "all" : "mention";
}

function normalizeMaxGroupMembers(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 50;
    return Math.min(Math.max(Math.trunc(parsed), 1), 1000);
}

export async function loadConfig() {
    // HA add-on options are at /data/options.json
    const optionsPath = "/data/options.json";
    let options = {};
    if (existsSync(optionsPath)) {
        try {
            options = JSON.parse(readFileSync(optionsPath, "utf-8"));
        } catch (err) {
            log.error(`Failed to read options.json: ${err.message}`);
        }
    }

    // Read addon version from supervisor API, fallback to config.yaml
    let addonVersion = "unknown";
    try {
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (supervisorToken) {
            const res = await fetch("http://supervisor/addons/self/info", {
                headers: { Authorization: `Bearer ${supervisorToken}` },
            });
            const data = await res.json();
            addonVersion = data?.data?.version || "unknown";
            log.debug(`Version from supervisor API: ${addonVersion}`);
        }
    } catch (err) {
        log.warn(`Supervisor API version fetch failed: ${err.message}`);
    }
    if (addonVersion === "unknown") {
        // Fallback: read from config.yaml (copied into container by Dockerfile)
        for (const p of ["/app/config.yaml", "/config.yaml", "/data/config.yaml"]) {
            try {
                const configYaml = readFileSync(p, "utf8").toString();
                const vMatch = configYaml.match(/^version:\s*(.+)/m);
                if (vMatch) {
                    addonVersion = vMatch[1].trim();
                    log.debug(`Version from ${p}: ${addonVersion}`);
                    break;
                }
            } catch {
                // Try next path.
            }
        }
    }

    // Resolve "auto" copilot paths
    const autoDir = "/data/copilot";
    const legacyBin = "/share/copilot-tools/copilot";
    const legacyConfig = "/share/copilot-tools/.copilot";

    let copilotBinary = process.env.COPILOT_BINARY || options.copilot_binary || "auto";
    if (copilotBinary === "auto" || copilotBinary === "") {
        // Prefer auto-installed location; fall back to legacy shared path
        if (existsSync(`${autoDir}/bin/copilot`)) {
            copilotBinary = `${autoDir}/bin/copilot`;
        } else if (existsSync(legacyBin)) {
            copilotBinary = legacyBin;
            log.info(`Using legacy Copilot binary at ${legacyBin}`);
        } else {
            copilotBinary = `${autoDir}/bin/copilot`; // expected after bootstrap
        }
    }

    let copilotConfigDir = options.copilot_config_dir || "auto";
    if (copilotConfigDir === "auto" || copilotConfigDir === "") {
        if (existsSync(`${autoDir}/.copilot`)) {
            copilotConfigDir = `${autoDir}/.copilot`;
        } else if (existsSync(legacyConfig)) {
            copilotConfigDir = legacyConfig;
            log.info(`Using legacy Copilot config at ${legacyConfig}`);
        } else {
            copilotConfigDir = `${autoDir}/.copilot`;
        }
    }

    // Allow env overrides for development
    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN || options.bot_token || "",
        allowedChatIds: options.allowed_chat_ids || [],
        groupMode: normalizeGroupMode(options.group_mode),
        allowedGroups: Array.isArray(options.allowed_groups) ? options.allowed_groups.map(String) : [],
        maxGroupMembers: normalizeMaxGroupMembers(options.max_group_members),
        copilotBinary,
        copilotConfigDir,
        copilotExtraArgs: options.copilot_extra_args || "",
        githubToken: process.env.COPILOT_GITHUB_TOKEN || options.github_token || "",
        preamble: options.preamble || "Be concise, mobile-first, Telegram-friendly PLAIN TEXT only.",
        autoStart: options.auto_start !== false,
        idleTimeoutMinutes: options.idle_timeout_minutes || 0,
        model: options.model || "",
        workingDirectory: options.working_directory || "/config",
        permissionPolicy: options.permission_policy || "interactive",
        agentDir: options.agent_dir || "/config/copilot-telegram-bot",
        logLevel: options.log_level || process.env.LOG_LEVEL || "info",
        version: addonVersion,
        mcpServers: [],
        backgroundEnabled: options.background_enabled === true,
        backgroundModel: options.background_model || "",
        backgroundIdleMinutes: Number(options.background_idle_minutes) || 5,

        // ACP Pool (v7)
        poolSize: Math.min(Math.max(Number(options.pool_size) || 5, 1), 10),
        poolPreWarm: Math.min(Math.max(Number(options.pool_pre_warm) || 1, 0), 10),
        poolIdleMinutes: Number(options.pool_idle_minutes) || 5,
        poolWaitTimeoutSeconds: Number(options.pool_wait_timeout_seconds) || 30,
        defaultModel: options.default_model || "standard",
        dispatcherModel: options.dispatcher_model || "fast",
        guestModel: options.guest_model || "fast",
        siDefaultModel: options.si_default_model || "standard",

        // DM Topics (Phase 1-2)
        dmTopicsEnabled: options.dm_topics_enabled === true,
        dmTopics: Array.isArray(options.dm_topics) && options.dm_topics.length > 0
            ? options.dm_topics
            : ["🏠 Home Control", "🔍 Research", "🚨 Alerts", "📋 Briefings"],

        // Streaming transport (Phase 3): auto | draft | edit | off
        streamingTransport: ["auto", "draft", "edit", "off"].includes(options.streaming_transport)
            ? options.streaming_transport
            : "auto",
    };

    // Try to load MCP config (copilot uses mcp-config.json)
    const mcpPaths = [
        "/data/.copilot/mcp-config.json",
        `${config.copilotConfigDir}/mcp-config.json`,
        "/data/.copilot/mcp.json",
        `${config.copilotConfigDir}/mcp.json`,
    ];
    for (const p of mcpPaths) {
        if (existsSync(p)) {
            try {
                const mcpConfig = JSON.parse(readFileSync(p, "utf-8"));
                if (mcpConfig.mcpServers) {
                    config.mcpServers = Object.entries(mcpConfig.mcpServers).map(([name, server]) => ({
                        name,
                        ...server,
                    }));
                }
                log.info(`Loaded MCP config from ${p} (${config.mcpServers.length} servers)`);
                for (const s of config.mcpServers) {
                    log.info(`  MCP: ${s.name} → ${s.url ? s.url : s.command || "unknown"}`);
                }
                break;
            } catch (err) {
                log.warn(`Failed to parse MCP config ${p}: ${err.message}`);
            }
        }
    }
    if (config.mcpServers.length === 0) {
        // Auto-discover ha-mcp as a sibling Home Assistant add-on
        const discovered = await discoverHaMcpAddon();
        if (discovered) {
            config.mcpServers = [{ name: "ha-mcp", url: discovered.url }];
            log.info(`ha-mcp discovered as sibling add-on at ${discovered.url}`);
        } else {
            log.info("No MCP servers configured (ha-mcp add-on not found)");
        }
    }

    // Check HA API connectivity
    config.haConnected = false;
    config.haVersion = null;
    config.haRole = null;
    try {
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (supervisorToken) {
            const res = await fetch("http://supervisor/core/api/config", {
                headers: { Authorization: `Bearer ${supervisorToken}` },
            });
            if (res.ok) {
                const data = await res.json();
                config.haConnected = true;
                config.haVersion = data.version || null;
                log.info(`HA API OK: Home Assistant ${data.version}`);
            } else {
                log.warn(`HA API check failed: HTTP ${res.status}`);
            }
            // Check supervisor role
            const roleRes = await fetch("http://supervisor/addons/self/info", {
                headers: { Authorization: `Bearer ${supervisorToken}` },
            });
            if (roleRes.ok) {
                const roleData = await roleRes.json();
                config.haRole = roleData?.data?.hassio_role || "default";
            }
        } else {
            log.warn("No SUPERVISOR_TOKEN — HA API unavailable");
        }
    } catch (err) {
        log.warn(`HA API check error: ${err.message}`);
    }

    // Parse changelog for /status viewer
    let changelog = [];
    for (const clPath of ["/app/CHANGELOG.md", "/config/CHANGELOG.md"]) {
        if (existsSync(clPath)) {
            try {
                const raw = readFileSync(clPath, "utf-8");
                const entries = raw.split(/^## /m).slice(1); // split by ## headers, skip preamble
                for (const entry of entries) {
                    const headerEnd = entry.indexOf("\n");
                    const header = entry.slice(0, headerEnd).trim();
                    const body = entry.slice(headerEnd + 1).trim();
                    const vMatch = header.match(/\[([^\]]+)\]/);
                    changelog.push({
                        version: vMatch ? vMatch[1] : header,
                        header,
                        body,
                    });
                }
                log.debug(`Parsed changelog: ${changelog.length} entries from ${clPath}`);
            } catch (err) {
                log.warn(`Failed to parse changelog: ${err.message}`);
            }
            break;
        }
    }
    config.changelog = changelog;

    return config;
}

// ── ha-mcp sibling add-on discovery ────────────────────────────
// Discovers the ha-mcp Home Assistant add-on via the Supervisor API
// and returns its SSE URL (hostname + port + secret_path).

async function discoverHaMcpAddon() {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) return null;

    try {
        // List all add-ons and find one whose slug ends with _ha_mcp
        const listRes = await fetch("http://supervisor/addons", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!listRes.ok) return null;

        const listData = await listRes.json();
        const addons = listData?.data?.addons || [];
        const hamcp = addons.find(a => a.slug?.endsWith("_ha_mcp"));
        if (!hamcp) {
            log.debug("ha-mcp add-on not installed");
            return null;
        }
        if (hamcp.state !== "started") {
            log.warn(`ha-mcp add-on found (${hamcp.slug}) but not running (state: ${hamcp.state})`);
            return null;
        }

        // Get add-on details for secret_path, network, and ip_address
        const infoRes = await fetch(`http://supervisor/addons/${hamcp.slug}/info`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!infoRes.ok) return null;

        const info = (await infoRes.json())?.data;
        if (!info) return null;

        const secretPath = info.options?.secret_path;
        if (!secretPath) {
            log.warn("ha-mcp add-on has no secret_path configured");
            return null;
        }

        // Resolve port from network config (e.g. { "9583/tcp": 9583 })
        const networkPorts = info.network || {};
        const port = Object.values(networkPorts)[0];
        if (!port) {
            log.warn("ha-mcp add-on has no exposed port");
            return null;
        }

        const host = info.ip_address || info.hostname;
        const url = `http://${host}:${port}${secretPath}`;

        log.debug(`ha-mcp discovered: ${hamcp.slug} at ${url}`);
        return { slug: hamcp.slug, url };
    } catch (err) {
        log.warn(`ha-mcp discovery failed: ${err.message}`);
        return null;
    }
}
