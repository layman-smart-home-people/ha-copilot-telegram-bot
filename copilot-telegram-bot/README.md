# Copilot Telegram Bot

**Telegram + Home Assistant + GitHub Copilot CLI, powered by an ACP Pool.**

Version **1.0.0** is the v7 rewrite: the bot now runs multiple Copilot CLI instances in parallel, keeps one conversation per scope, supports mid-conversation steering, and renders responses progressively in Telegram.

## ✨ What this add-on does

- Connects **Telegram** to **GitHub Copilot CLI** through **ACP (Agent Client Protocol)**
- Gives Home Assistant a mobile-first AI operator with direct HA tooling
- Runs an **N-instance ACP Pool** for concurrent conversations
- Supports **DMs, groups, and forum topics** with isolated scope handling
- Includes **standing instructions**, persistent agent files, and an **Ingress WebUI**

## 🚀 Installation

### One-click add repository

[![Open your Home Assistant instance and show the add add-on repository dialog](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Flayman-smart-home-people%2Fha-copilot-telegram-bot)

### Manual repository setup

1. Open **Home Assistant → Settings → Add-ons → Add-on Store**
2. Open the **⋮ menu → Repositories**
3. Add:
   ```text
   https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
   ```
4. Install **Copilot Telegram Bot** (`copilot-telegram-bot`)

## 🛠️ Initial setup

### 1) Create a Telegram bot

1. Open Telegram and chat with **@BotFather**
2. Run `/newbot`
3. Copy the bot token

Example:

```text
123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
```

### 2) Get your Telegram user ID

1. Chat with **@userinfobot** (or any equivalent Telegram ID bot)
2. Send any message
3. Copy your numeric user ID

### 3) Configure the add-on

Open the add-on configuration and set at least:

```yaml
bot_token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
allowed_chat_ids:
  - "123456789"
default_model: standard
pool_size: 5
pool_pre_warm: 1
```

Recommended notes:

- `allowed_chat_ids` are the initial **owner** accounts
- `github_token` is optional; if omitted, complete Copilot authentication when prompted
- `default_model`, `guest_model`, and `si_default_model` choose between `fast`, `standard`, and `reasoning`

### 4) Start the add-on

1. Start the add-on
2. Open the logs once to confirm startup
3. Send your bot a message in Telegram
4. Optionally open the **WebUI** via Home Assistant Ingress

## 🌟 Core features

### ACP Pool

- Configurable **1-10** Copilot CLI instances
- Default pool size: **5**
- 6-step acquire path: **sticky → matching idle → spawn → reconfigure → evict → wait queue**
- Health checks, idle reaping, and crash supervision

### Conversation scopes

- **DM:** one conversation per user
- **Group (non-forum):** one conversation per user within the group
- **Forum groups:** one conversation per topic thread

This means the bot works in both threaded and non-threaded groups without any special setup.

### Steering

If a user sends a new message while a response is still running, v7 cancels the old prompt and redirects the conversation to the new request.

### Progressive streaming

- **Private chats:** draft-style progressive rendering
- **Groups/forums:** edit-in-place rendering
- Tool activity labels, code blocks, expandable details, and inline buttons

### Standing Instructions

Persistent automation-style behaviors that can:

- react to Home Assistant state changes
- run on cron schedules
- fire once at a future time
- wake the agent, notify in Telegram, or call HA services directly

### WebUI

Ingress WebUI includes:

- Dashboard
- Chat
- Standing Instructions manager
- Docs editor for agent files
- Logs viewer
- Config editor

## 💬 Quick start commands

v7 intentionally keeps a small command surface:

- `/help` — show available commands
- `/status` — show pool, conversations, and metrics
- `/new` — start a fresh conversation in the current scope
- `/stop` — cancel the current operation
- `/settings` — coming soon
- `/standing` — coming soon
- `/memory` — coming soon

## ⚙️ Configuration reference

### Required

- `bot_token` — Telegram bot token from @BotFather
- `allowed_chat_ids` — list of Telegram user IDs that start as **owners**

### Authentication and Copilot

- `github_token` — optional GitHub token for Copilot/GitHub features
- `copilot_binary` — path to Copilot CLI binary, or `auto`
- `copilot_config_dir` — path to Copilot auth/config, or `auto`
- `copilot_extra_args` — extra CLI arguments passed to Copilot
- `preamble` — channel-specific system guidance injected on first message
- `working_directory` — default Copilot working directory (default `/config`)

### General behavior

- `auto_start` — start automatically with the add-on
- `idle_timeout_minutes` — legacy top-level idle timeout
- `model` — legacy compatibility option
- `permission_policy` — `interactive` or `allow_all`
- `log_level` — `debug`, `info`, `warn`, or `error`
- `agent_dir` — agent files directory (v7 deployments commonly use `/config/.agent`)

### Group behavior

- `group_mode` — `mention` or `all`
- `allowed_groups` — optional allow-list of Telegram group IDs
- `max_group_members` — reject very large groups

### Pool options (new in 1.0.0)

- `pool_size` — number of ACP instances, **1-10** (default `5`)
- `pool_pre_warm` — how many instances to boot eagerly, **0-10** (default `1`)
- `pool_idle_minutes` — idle reap timeout, **1-60** (default `5`)
- `pool_wait_timeout_seconds` — how long to wait when the pool is full, **5-120** (default `30`)
- `default_model` — model tier for owners/members: `fast`, `standard`, `reasoning` (default `standard`)
- `guest_model` — model tier for guests (default `fast`)
- `si_default_model` — model tier for standing instructions (default `standard`)

## 🧠 Architecture overview

v7 is organized into a few clear layers:

- **Gateway** — parses Telegram updates, resolves scope keys, applies permissions, enriches prompts
- **Conversation layer** — one active conversation per scope, with steering and crash recovery
- **ACP Pool** — reusable Copilot CLI workers with model/profile routing
- **ResponseStreamer** — progressive Telegram output for private chats and groups
- **Standing Instructions + WebUI** — automation and operator surfaces

## 🔧 Troubleshooting

### Bot does not reply

- Confirm `bot_token` is valid
- Confirm your Telegram ID is in `allowed_chat_ids` or RBAC grants access
- Check add-on logs for Copilot auth or Telegram polling errors

### `/status` shows a busy pool

- Increase `pool_size`
- Lower `pool_pre_warm` if startup is heavy
- Use `fast` for guests or lighter workloads
- Wait for the queue to clear if `pool_wait_timeout_seconds` is being hit

### Group behavior seems different in forums

That is expected:

- non-forum groups isolate by **user within the group**
- forum groups isolate by **topic thread**

### Agent file edits are not reflected

Start a **new conversation** with `/new` after updating `IDENTITY.md`, `SKILLS.md`, or `TASKS.md`.

### Standing instructions are not firing

- Verify the instruction is enabled
- Check `/data/standing_instructions.json` for valid JSON
- Use the WebUI **Instructions** tab and logs for diagnostics

## 📚 Links

- **Full documentation:** [DOCS.md](./DOCS.md)
- **Repository:** https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
- **Issues:** https://github.com/layman-smart-home-people/ha-copilot-telegram-bot/issues
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

---

Built for Home Assistant users who want a Telegram-native Copilot operator with real concurrency, smart scope isolation, and clean operational tooling.