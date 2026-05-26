# 🤖 Copilot Telegram Bot — Home Assistant Add-on

**Version 0.13.5**

Talk to [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli/) directly from Telegram. This Home Assistant add-on gives you an always-on Telegram bot that starts Copilot on demand, streams progress back to chat, and lets you work from your phone without opening a terminal.

---

## ✨ What Does It Do?

Send a message to your private Telegram bot → it wakes up Copilot CLI → Copilot reads files, runs commands, uses Home Assistant and GitHub tools, and replies right in Telegram.

**Think of it as your personal AI assistant for Home Assistant and coding tasks, available 24/7 on your phone.**

### Key Features

- 🔄 **Always-on bot, on-demand Copilot** — the bot stays online even when Copilot is idle
- 👤 **Multi-user isolation** — each user gets their own independent Copilot session
- 👥 **Group chat support** — add the bot to groups; responds to @mentions or all messages
- 📌 **Pinned instructions** — pin a message like "Always answer in German" and it is included in future prompts
- ↩️ **Reply-chain context** — replying to a message includes up to 5 linked messages as context
- 🔐 **Per-user permissions** — interactive approval prompts scoped per user and conversation
- 🧵 **Forum mode** — in Telegram forums, each topic becomes its own Copilot session
- 👥 **User pairing** — add extra users with 6-character pairing codes that expire after 15 minutes
- 📊 **Live status menu** — singleton dashboard with auto-refresh, action buttons, and 5-minute TTL
- 💬 **Progressive responses** — thinking, tool activity, and answer text stream into Telegram as work happens
- 🧠 **Collapsible reasoning** — full AI reasoning shown in a tap-to-expand blockquote below the answer
- ⚡ **Emoji reactions** — messages show ⚡ (processing), ⏳ (queued), ✅ (done), or ⚠️ (errors)
- ✏️ **Edit support** — edit a message to cancel and resubmit with corrected text
- 📎 **File attachments** — send text files and they're read into the prompt as context
- 🛑 **Recovery controls** — `/stop`, `/retry`, `/history`, `/sessions`, `/new`, `/close`, `/delete`, and more
- 🔔 **Graceful shutdown notices** — users are told if the add-on stops mid-response
- ⏸️ **Resource-friendly** — optional idle timeout, LRU eviction, rate limiting, owner scope protection

---

## 🚀 Quick Start (5 minutes)

### Prerequisites

1. **Home Assistant OS** (or Supervised)
2. **GitHub Copilot CLI** installed and logged in (commonly via the VS Code Server add-on)
3. A **Telegram account**
4. A **GitHub fine-grained personal access token** for GitHub-backed Copilot features

### Step 1: Create Your Telegram Bot

1. Open Telegram and find **@BotFather**
2. Send `/newbot`
3. Give your bot a name and username
4. Copy the bot token — it looks like `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`

### Step 2: Get Your Chat ID

1. Open Telegram and find **@userinfobot**
2. Send any message
3. Copy your numeric **chat ID** (for example `123456789`)

### Step 3: Create a GitHub Token

1. Go to <https://github.com/settings/tokens>
2. Create a **fine-grained personal access token**
3. Grant the access your Copilot setup requires
4. Copy the token for the add-on config

### Step 4: Install the Add-on

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Open the **⋮** menu → **Repositories**
3. Add:
   ```
   https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
   ```
4. Install **Copilot Telegram Bot**

### Step 5: Configure

In the add-on's **Configuration** tab, set at minimum:

- **bot_token** — your BotFather token
- **allowed_chat_ids** — your Telegram chat ID
- **github_token** — your GitHub token

Optional but useful:

- **permission_policy** — `interactive` (recommended) or `allow_all`
- **model** — leave as `auto` or pin a preferred Copilot model

### Step 6: Start

1. Open the add-on **Info** tab
2. Click **Start**
3. Send your bot a message in Telegram — it should reply 🎉

---

## 💬 Using the Bot

### Regular Messages

Just type naturally. Anything you send becomes a Copilot prompt.

```text
You: What files are in /config?
Bot: [lists your Home Assistant config files]

You: Can you check my automations for errors?
Bot: [reviews automations.yaml and explains what it found]
```

### Everyday Tips

- **Reply to a message** to give Copilot targeted context
- **Pin a message** to set a standing instruction for that chat
- **Send photos or documents** to let Copilot inspect screenshots, YAML, logs, or code
- Use **`/status`** for a live control panel
- Use **`/stop`** if a request is taking too long
- Use **`/retry`** to resend your last non-command message

### Slash Commands

| Command | What it does |
|---------|--------------|
| `/help` | Show the command list with quick-action buttons |
| `/status` | Open the live status menu with model, mode, session, permissions, and action buttons |
| `/usage` | Show usage metrics such as context usage, turns, and token counts |
| `/history [n]` | Show the last *n* messages (default 10, max 30) |
| `/skills` | Show available Copilot commands, discovered MCP tools, and bot commands |
| `/tools` | Alias for `/skills` |
| `/model [name]` | Switch model directly or open the interactive model picker |
| `/autopilot [on\|off]` | Toggle autopilot mode |
| `/plan [on\|off]` | Toggle plan-first mode |
| `/mode` | Open the interactive mode picker |
| `/allowall [on\|off]` | Toggle allow-all permission mode |
| `/compact` | Compact conversation history to free context window space |
| `/stop` | Cancel the current operation (`/cancel` is an alias) |
| `/retry` | Resend the last user message to Copilot |
| `/session new` / `/session stop` | Restart the current Copilot session or stop Copilot entirely |
| `/new [title]` | Create a new session; in forum mode, this also creates a new topic |
| `/close` | Close the current forum-topic session |
| `/delete` | Delete the current forum-topic session and its Telegram topic |
| `/sessions` | List active sessions or forum topics and their status |
| `/pair` | Show pairing help; admins can use `/pair list` to list paired users |
| `/unpair <userId>` | Revoke a paired user's access (admin only) |

---

## 🌟 User-Facing Features

### Pinned Messages as Instructions

Pin a message in a chat to make it a persistent instruction for future prompts in that chat. For example:

- `Always answer in concise bullet points`
- `Assume my house has 3 floors`
- `Prefer Home Assistant YAML examples`

The bot acknowledges the pinned instruction and includes it automatically in later requests.

### Reply Chain Context

When you reply to a message, the bot follows the reply chain and includes up to **5 messages** of context. This works with both user messages and bot messages, which makes follow-up questions much more natural.

### Permission System

The add-on supports two permission modes:

- **Interactive** (default): safe-by-default behavior. Read-only access is auto-approved, while Home Assistant write actions prompt with inline **Allow**, **Deny**, and **Allow for session** buttons.
- **Allow-all**: all tool calls are auto-approved.

You can set the startup default with `permission_policy` and change it later with `/allowall` or the status menu.

### Forum Mode (Topic-per-Session)

In Telegram supergroups with Topics enabled:

- each topic gets its own Copilot session
- the **General** topic becomes a management area for commands
- `/new [title]` creates a new topic and session
- `/close`, `/delete`, and `/sessions` manage topic sessions cleanly

### User Pairing

You can add users without editing configuration files:

1. The new user messages the bot
2. The add-on generates a **6-character pairing code** in the Home Assistant add-on logs
3. An admin shares that code with the user
4. The user sends the code to the bot
5. The code expires after **15 minutes**

Users from `allowed_chat_ids` are treated as admins automatically.

### Live Status Menu

`/status` opens a singleton status dashboard that shows:

- Copilot state
- current model and mode
- permission mode
- active session info
- paired-user and session counts
- quick buttons for common actions

The status message auto-refreshes when state changes and expires after **5 minutes**.

### Progressive Response Display

Responses are streamed into Telegram progressively:

- 🤔 thinking indicator while Copilot reasons
- 🧠 live reasoning line displayed after 3 seconds
- 🔧 tool-step updates as tools run
- ✍️ answer text preview during streaming
- ✅ final answer replaces the placeholder; reasoning + steps collapse into a tappable blockquote below

Emoji reactions track status: ⚡ (processing) → ✅ (done) or ⚠️ (errors). Queued messages show ⏳.

### Message Editing

Edit a message to correct a typo or change your request:

- **While queued** — the queue entry is silently updated
- **While processing** — the current operation is cancelled and resubmitted with your corrected text
- **After completion** — a correction prompt is sent so Copilot adjusts without re-executing actions

### File Attachments

Send text files (`.yaml`, `.json`, `.py`, `.log`, `.txt`, etc.) and they're read as UTF-8 and injected into the prompt as a fenced code block. Files up to 50 KB are supported. Photos and images are sent to Copilot directly.

### Unsupported Media

The bot handles unsupported media gracefully:

- **Voice/audio** — suggests using keyboard speech-to-text instead
- **Video/GIF** — suggests sending a photo or screenshot
- **Stickers** — extracts the emoji and sends it as context
- **Locations** — sends coordinates (useful for Home Assistant location context)
- **Contacts** — friendly rejection

---

## ⚙️ Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `bot_token` | *(required)* | Telegram bot token from BotFather |
| `allowed_chat_ids` | `[]` | Pre-approved Telegram user/chat IDs; these users are also admins for pairing |
| `github_token` | `""` | GitHub token used for GitHub-backed Copilot features |
| `copilot_binary` | `/share/copilot-tools/copilot` | Path to the Copilot CLI binary |
| `copilot_config_dir` | `/share/copilot-tools/.copilot` | Path to Copilot authentication and config data |
| `copilot_extra_args` | `""` | Extra CLI flags passed to Copilot |
| `preamble` | built-in Telegram-friendly prompt | System prompt injected at session start |
| `auto_start` | `true` | Start Copilot when the add-on boots |
| `idle_timeout_minutes` | `0` | Stop Copilot after N idle minutes (`0` = never) |
| `model` | `auto` | Default Copilot model |
| `working_directory` | `/config` | Copilot working directory |
| `permission_policy` | `interactive` | Startup permission mode: `interactive` or `allow_all` |
| `group_mode` | `mention` | How the bot responds in groups: `mention` (only @mentions) or `all` |
| `allowed_groups` | `[]` | Whitelist of group chat IDs the bot may join (empty = any group) |
| `max_group_members` | `50` | Maximum group size for the bot to operate in (1–1000) |

---

## 🔧 Troubleshooting

### Bot doesn't respond

1. Check the add-on **Log** tab for errors
2. Verify `bot_token`
3. Make sure your ID is in `allowed_chat_ids` or you completed pairing
4. Confirm Copilot CLI exists at the configured `copilot_binary`

### "Copilot binary not found"

Set `copilot_binary` to the real location of the Copilot CLI binary. The default expects it on a shared volume:

1. Update `copilot_binary`
2. Make sure the path is accessible from the add-on container

### "ACP test failed"

Copilot usually needs to be authenticated:

1. Open a terminal through VS Code Server or SSH
2. Run `/share/copilot-tools/copilot login`
3. Complete the GitHub login flow
4. Restart the add-on

### "Another process is polling"

Telegram allows only one polling client per bot token:

1. Stop any other test scripts or duplicate add-on instances
2. Wait about 30 seconds
3. Restart the add-on

### Messages seem slow

Complex Copilot tasks can take time. Watch the progressive status updates, then:

- use `/stop` to cancel
- use `/retry` to try again
- use `/session new` for a fresh session
- use `/compact` if context is getting large

### Permission prompts do not appear

Check whether allow-all mode is active:

- run `/status` or `/allowall off`
- confirm `permission_policy` is `interactive` if you want prompts on startup

---

## 🏗️ Architecture (Technical)

### Overview

```text
┌─────────────┐         ┌─────────────────────────┐         ┌─────────────┐
│  Telegram   │◄───────►│  Node.js daemon         │◄───────►│ Copilot CLI │
│  clients    │  HTTPS  │  (HA add-on container)  │  ACP    │ (--acp)     │
└─────────────┘         └─────────────────────────┘         └─────────────┘
                               │
                               │ reads /data/options.json
                               │ uses /share/ for Copilot binary + auth
                               ▼
                        ┌─────────────────┐
                        │ Home Assistant  │
                        │ + MCP tools     │
                        └─────────────────┘
```

### Source Components

| File | Role |
|------|------|
| `src/index.mjs` | Entry point: config loading, validation, startup, shutdown, service wiring |
| `src/acp.mjs` | Copilot ACP client: process management, JSON-RPC, sessions, models, modes, thinking events |
| `src/telegram.mjs` | Telegram Bot API client: polling, queueing, retries, rate limiting, reactions |
| `src/bridge.mjs` | Main orchestrator: auth, prompt flow, permissions, status menu, streaming, edit handling, file attachments, message types, queue management |
| `src/commands.mjs` | Slash command parsing and command handlers |
| `src/formatter.mjs` | Markdown/HTML conversion, escaping, chunking, Telegram-safe formatting |
| `src/response-composer.mjs` | Progressive single-message display for thinking, tools, and answer with collapsible finalize |
| `src/transport.mjs` | Conversation routing layer for chats/topics, message edits, files, and topic management |
| `src/pairing.mjs` | User pairing, admin tracking, persistence, and expiring 6-character pairing codes |
| `src/sessions.mjs` | Forum-topic to Copilot-session mapping, active session tracking, persistence |
| `src/history.mjs` | Recent-message buffer, reply-chain lookup, `/history`, and `/retry` support |
| `src/buttons.mjs` | Inline button menus, interactive pickers, permission prompts, timeout cleanup |
| `src/errors.mjs` | Human-friendly ACP and runtime error formatting with retry hints |
| `src/scope-manager.mjs` | Session scope resolution, LRU eviction with owner protection, persistence |
| `src/scope-state.mjs` | Per-scope state (history, permissions, tool tracking, composer) |
| `src/config.mjs` | Configuration loading and validation from HA options.json |

### Message Flow

1. A user sends a DM, group message, or forum-topic message
2. The bot checks allowlist/pairing access
3. Pinned instructions and reply-chain context are collected
4. The correct Copilot session is created or selected
5. If a write action needs approval in interactive mode, Telegram buttons are shown
6. Copilot streams thinking, tool updates, and text back through the response composer
7. The final response is sent and the status menu refreshes if needed

### ACP Protocol

The add-on talks to Copilot CLI through the **Agent Client Protocol (ACP)**:

1. **Transport**: newline-delimited JSON over stdin/stdout
2. **Protocol**: JSON-RPC 2.0
3. **Lifecycle**:
   - `initialize` for handshake
   - `session/new` to create a session
   - `session/prompt` to send user input
   - `session/update` notifications for streamed progress
   - `requestPermission` when Copilot asks to use tools

### Container Structure

```text
/
├── data/options.json          # Home Assistant add-on configuration
├── share/copilot-tools/
│   ├── copilot                # Copilot CLI binary
│   └── .copilot/              # Shared Copilot auth/config
└── app/
    ├── package.json
    └── src/                   # Add-on source code
```

### Service Management

The add-on uses **s6-overlay**:

- `rootfs/etc/s6-overlay/s6-rc.d/telegram-bot/run` starts the bot
- `rootfs/etc/s6-overlay/s6-rc.d/telegram-bot/finish` handles cleanup on stop
- s6 restarts the service automatically if it crashes

---

## 🔐 Security

- **Access control** — only users from `allowed_chat_ids` or successfully paired users can use the bot
- **Admin model** — users in `allowed_chat_ids` are admins and can manage paired users
- **Interactive permissions by default** — write actions are confirmed with Telegram approval buttons instead of being auto-approved blindly
- **Optional allow-all mode** — trusted single-user setups can switch to allow-all with `permission_policy` or `/allowall`
- **Scoped secrets** — bot and GitHub tokens live in Home Assistant add-on config, not hardcoded in source
- **Minimal external surface** — the add-on talks to Telegram, GitHub/Copilot, and your local Home Assistant environment

---

## 📋 Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Home Assistant OS | 12+ | Or a supported Supervised installation |
| Copilot CLI | Current ACP-capable release | Must be installed and authenticated |
| Node.js | 20+ | Bundled in the add-on image |
| Architecture | `aarch64`, `amd64` | ARM64 and x86_64 builds |

---

Source code: <https://github.com/layman-smart-home-people/ha-copilot-telegram-bot>

This software is provided as-is, without warranty of any kind.
