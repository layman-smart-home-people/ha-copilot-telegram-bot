# 🤖 Copilot Telegram Bot — Home Assistant Add-on

Talk to [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) directly from Telegram. This Home Assistant add-on provides an **always-on Telegram bot** that spawns Copilot on demand, keeping you connected even when no CLI session is active.

---

## ✨ What Does It Do?

Send a message to your private Telegram bot → it wakes up Copilot CLI → Copilot processes your request (reading files, running commands, searching code) → you get the response right in Telegram.

**Think of it as your personal AI coding assistant, available 24/7 on your phone.**

### Key Features

- 🔄 **Always-on** — Bot stays alive even when Copilot isn't running
- ⚡ **On-demand** — Copilot starts automatically when you message the bot
- 🔒 **Private** — Only your approved Telegram accounts can use it
- 💬 **Rich messages** — Code blocks, formatting, images, file attachments
- 🔧 **Live status** — See what Copilot is doing in real-time
- 📱 **Slash commands** — `/autopilot`, `/model`, `/cancel`, `/compact`, and more
- 🛡️ **Auto-recovery** — Restarts Copilot automatically if it crashes
- ⏸️ **Resource-friendly** — Optional idle timeout stops Copilot when not in use

---

## 🚀 Quick Start (5 minutes)

### Prerequisites

1. **Home Assistant OS** (or Supervised) installation
2. **Copilot CLI** installed and logged in (typically via the VS Code Server add-on)
3. A **Telegram account**

### Step 1: Create Your Telegram Bot

1. Open Telegram and find **@BotFather** (the official bot-making bot)
2. Send `/newbot`
3. Give your bot a name (e.g., "My Copilot")
4. Give it a username (e.g., `my_copilot_bot`)
5. **Copy the token** — it looks like: `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`

### Step 2: Get Your Chat ID

1. Open Telegram and find **@userinfobot**
2. Send any message to it
3. It replies with your **chat ID** (a number like `123456789`)
4. Write this down — you'll need it in the next step

### Step 3: Install the Add-on

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Click the **⋮** menu (top right) → **Repositories**
3. Add this URL:
   ```
   https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
   ```
4. Find **"Copilot Telegram Bot"** in the store and click **Install**

### Step 4: Configure

1. Go to the add-on's **Configuration** tab
2. Set:
   - **bot_token**: Paste your BotFather token
   - **allowed_chat_ids**: Add your chat ID (from Step 2)
3. Click **Save**

### Step 5: Start

1. Go to the **Info** tab
2. Click **Start**
3. Send a message to your bot on Telegram — it should reply! 🎉

---

## 💬 Using the Bot

### Regular Messages

Just type naturally — anything you send becomes a prompt to Copilot:

```
You: What files are in /config?
Bot: [lists your HA config files]

You: Can you check my automations for errors?
Bot: [analyzes your automations.yaml]
```

### Slash Commands

| Command | What it does |
|---------|-------------|
| `/autopilot on` | Let Copilot work autonomously |
| `/autopilot off` | Back to interactive mode |
| `/plan on/off` | Toggle plan mode |
| `/model claude-sonnet-4-5` | Switch AI model |
| `/compact` | Free up context window |
| `/cancel` | Stop current operation |
| `/usage` | Show token usage |
| `/status` | Check bot & Copilot health |
| `/session new` | Start fresh session |
| `/session stop` | Kill Copilot process |
| `/help` | List commands |

### Sending Files

- **Photos**: Send a photo with a caption like "What's in this screenshot?"
- **Documents**: Attach text files, code, configs for Copilot to read

---

## ⚙️ Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `bot_token` | *(required)* | Your Telegram bot token from BotFather |
| `allowed_chat_ids` | `[]` | List of Telegram chat IDs that can use the bot |
| `copilot_binary` | `/share/copilot-tools/copilot` | Path to the Copilot CLI binary |
| `copilot_config_dir` | `/share/copilot-tools/.copilot` | Path to Copilot auth & config |
| `copilot_extra_args` | `""` | Extra CLI flags (e.g., `--model opus`) |
| `preamble` | *(Telegram formatting rules)* | System prompt sent at session start |
| `auto_start` | `true` | Start Copilot when the add-on boots |
| `idle_timeout_minutes` | `0` | Auto-stop Copilot after N min (0 = never) |
| `model` | `""` | Default model (blank = auto) |
| `working_directory` | `/config` | Copilot's working directory |

---

## 🔧 Troubleshooting

### Bot doesn't respond

1. Check the add-on **Log** tab for errors
2. Verify your `bot_token` is correct (try `/start` in Telegram)
3. Make sure your chat ID is in `allowed_chat_ids`
4. Check that Copilot CLI is installed: look for `/share/copilot-tools/copilot`

### "Copilot binary not found"

The Copilot CLI binary needs to be accessible at the configured path. If you installed it elsewhere:
1. Update `copilot_binary` in the add-on config
2. Make sure it's on a **shared** volume (e.g., `/share/`)

### "ACP test failed"

Copilot needs to be authenticated:
1. Open a terminal (via VS Code Server or SSH add-on)
2. Run: `/share/copilot-tools/copilot login`
3. Follow the GitHub authentication flow
4. Restart the add-on

### Bot says "another process is polling"

Only one process can poll a Telegram bot at a time. If you see this:
1. Check if you have another instance running (e.g., a test script)
2. Wait 30 seconds for the old connection to timeout
3. Restart the add-on

### Messages seem slow

Copilot may take 10-60+ seconds for complex tasks. The bot shows typing indicators and live tool-call status so you know it's working. If it seems stuck:
- Use `/cancel` to abort the current operation
- Use `/session new` to start fresh

---

## 🏗️ Architecture (Technical)

For developers and those who want to understand how it works.

### Overview

```
┌─────────────┐         ┌─────────────────────────┐         ┌─────────────┐
│  Telegram    │◄───────►│  Node.js Daemon          │◄───────►│ Copilot CLI │
│  (your phone)│  HTTPS  │  (HA Add-on container)   │  stdio  │ (--acp)     │
└─────────────┘         └─────────────────────────┘         └─────────────┘
                               │
                               │ reads /data/options.json
                               │ accesses /share/ (copilot binary + auth)
                               ▼
                        ┌─────────────────┐
                        │ Home Assistant   │
                        │ Supervisor       │
                        └─────────────────┘
```

### Components

| File | Role |
|------|------|
| `src/index.mjs` | Main entry — config loading, validation, startup, shutdown |
| `src/acp.mjs` | ACP protocol client — spawns Copilot, JSON-RPC 2.0 over stdio |
| `src/telegram.mjs` | Telegram Bot API client — polling, send queue, rate limiting |
| `src/bridge.mjs` | Orchestrator — routes messages, typing, tool bubbles, files |
| `src/commands.mjs` | Slash command parser and handler |
| `src/formatter.mjs` | Markdown → Telegram HTML converter, message chunking |

### ACP Protocol

The **Agent Client Protocol** (ACP) is how this add-on talks to Copilot CLI programmatically:

1. **Transport**: Newline-delimited JSON (NDJSON) over stdin/stdout
2. **Protocol**: JSON-RPC 2.0
3. **Lifecycle**:
   - `initialize` → handshake
   - `session/new` → create a session
   - `session/prompt` → send user messages
   - `session/update` → receive streamed responses (notifications)
   - `requestPermission` → Copilot asks to run tools (auto-approved)

### Message Flow

1. User sends Telegram message
2. Bot validates user is in `allowed_chat_ids`
3. If Copilot not running → spawn it and create session
4. Inject preamble (first message only) + user text → `session/prompt`
5. Copilot streams `agent_message_chunk` notifications
6. Chunks accumulate → flush as complete message on `message_end`
7. Tool calls show as live status bubbles (auto-deleted on completion)
8. Final response sent back to Telegram as formatted HTML

### Container Structure

```
/
├── data/options.json          # HA add-on configuration
├── share/copilot-tools/
│   ├── copilot                # Copilot CLI binary
│   └── .copilot/              # Auth & config (shared)
└── app/
    ├── package.json
    └── src/                   # Bot source code
```

### Service Management

The add-on uses **s6-overlay** (standard for HA add-ons):
- `rootfs/etc/s6-overlay/s6-rc.d/telegram-bot/run` — starts the bot
- `rootfs/etc/s6-overlay/s6-rc.d/telegram-bot/finish` — cleanup on stop
- Automatic restart on crash (s6 restarts the service)

---

## 🔐 Security

- **No secrets in code** — Bot token is stored in HA's encrypted add-on config
- **Chat ID allowlist** — Only approved users can interact
- **Copilot --allow-all** — Currently auto-approves all tool permissions. This is intentional for a personal assistant use case. In shared environments, consider restricting access.
- **No external services** — The bot only talks to Telegram's API and local Copilot

---

## 📋 Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Home Assistant OS | 12+ | Or Supervised installation |
| Copilot CLI | 1.0.0+ | Must be pre-installed and authenticated |
| Node.js | 20+ | Bundled in the Docker image |
| Architecture | aarch64, amd64 | ARM64 (RPi 4+) or x86_64 |

---

## 🤝 Contributing

Issues and PRs welcome at:
https://github.com/layman-smart-home-people/ha-copilot-telegram-bot

---

## 📄 License

MIT
