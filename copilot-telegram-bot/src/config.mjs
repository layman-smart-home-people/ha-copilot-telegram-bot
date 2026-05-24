import { readFileSync, existsSync } from "node:fs";

function normalizeGroupMode(value) {
    return value === "all" ? "all" : "mention";
}

function normalizeMaxGroupMembers(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 50;
    return Math.min(Math.max(Math.trunc(parsed), 1), 1000);
}

export async function loadConfig(log = () => {}) {
    // HA add-on options are at /data/options.json
    const optionsPath = "/data/options.json";
    let options = {};
    if (existsSync(optionsPath)) {
        try {
            options = JSON.parse(readFileSync(optionsPath, "utf-8"));
        } catch (err) {
            log(`Failed to read options.json: ${err.message}`);
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
            log(`Version from supervisor API: ${addonVersion}`);
        }
    } catch (err) {
        log(`Supervisor API version fetch failed: ${err.message}`);
    }
    if (addonVersion === "unknown") {
        // Fallback: read from config.yaml (copied into container by Dockerfile)
        for (const p of ["/app/config.yaml", "/config.yaml", "/data/config.yaml"]) {
            try {
                const configYaml = readFileSync(p, "utf8").toString();
                const vMatch = configYaml.match(/^version:\s*(.+)/m);
                if (vMatch) {
                    addonVersion = vMatch[1].trim();
                    log(`Version from ${p}: ${addonVersion}`);
                    break;
                }
            } catch {
                // Try next path.
            }
        }
    }

    // Allow env overrides for development
    const config = {
        botToken: process.env.TELEGRAM_BOT_TOKEN || options.bot_token || "",
        allowedChatIds: options.allowed_chat_ids || [],
        groupMode: normalizeGroupMode(options.group_mode),
        allowedGroups: Array.isArray(options.allowed_groups) ? options.allowed_groups.map(String) : [],
        maxGroupMembers: normalizeMaxGroupMembers(options.max_group_members),
        copilotBinary: process.env.COPILOT_BINARY || options.copilot_binary || "/share/copilot-tools/copilot",
        copilotConfigDir: options.copilot_config_dir || "/share/copilot-tools/.copilot",
        copilotExtraArgs: options.copilot_extra_args || "",
        githubToken: process.env.COPILOT_GITHUB_TOKEN || options.github_token || "",
        preamble: options.preamble || "Be concise, mobile-first, Telegram-friendly PLAIN TEXT only.",
        autoStart: options.auto_start !== false,
        idleTimeoutMinutes: options.idle_timeout_minutes || 0,
        model: options.model || "",
        workingDirectory: options.working_directory || "/config",
        permissionPolicy: options.permission_policy || "interactive",
        version: addonVersion,
        mcpServers: [],
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
                log(`Loaded MCP config from ${p} (${config.mcpServers.length} servers)`);
                for (const s of config.mcpServers) {
                    log(`  MCP: ${s.name} → ${s.url ? s.url : s.command || "unknown"}`);
                }
                break;
            } catch (err) {
                log(`WARNING: Failed to parse MCP config ${p}: ${err.message}`);
            }
        }
    }
    if (config.mcpServers.length === 0) {
        log("No MCP servers configured — ha-mcp will not be available");
    }

    return config;
}
