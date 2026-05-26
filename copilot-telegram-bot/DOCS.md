# Copilot Telegram Bot

**Control your smart home with AI — right from Telegram.** Version **0.13.5**.

---

## 🏠 What Is This?

This is a Home Assistant add-on that gives you an AI assistant on Telegram. Just text your bot like you'd text a friend, and it can control your smart home, answer questions, and automate tasks — all from your phone.

No coding required. Just type what you want in plain English.

## 💬 What Can I Do With It?

Here are some things you can ask your bot:

- **"Turn off all the lights"** — it controls your devices
- **"What's the temperature in the bedroom?"** — it reads your sensors
- **"Is the front door locked?"** — it checks device states
- **"Set up an automation to turn on the porch light at sunset"** — it creates automations
- **"What's on my calendar today?"** — it reads your HA calendars
- **"Show me the status of all my devices"** — it generates reports

You can also have natural conversations — ask follow-up questions, give it context by replying to messages, and pin instructions it should always follow.

## 🚀 Getting Started

You'll need three things: a Telegram bot, a GitHub account, and your Telegram user ID.

### Step 1 — Create Your Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts to name your bot
3. BotFather gives you a **bot token** — copy it (looks like `123456789:ABC...xyz`)

### Step 2 — Get a GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Create a **fine-grained personal access token**
3. Grant it the permissions Copilot needs (repository access, etc.)

### Step 3 — Find Your User ID

1. Open Telegram and search for **@userinfobot**
2. Send it any message — it replies with your numeric ID (e.g., `123456789`)

### Step 4 — Configure the Add-on

In Home Assistant, go to the add-on configuration and fill in:

- **Bot token** — paste the token from Step 1
- **Allowed chat IDs** — paste your numeric ID from Step 3
- **GitHub token** — paste your token from Step 2

### Step 5 — Start Chatting!

Click **Start** on the add-on's Info tab, then open Telegram and send your bot a message. That's it! 🎉

## 🎯 Handy Tips for Everyday Use

- **Reply to a message** to give the AI context about what you're referring to
- **Pin a message** in the chat to set a standing instruction (e.g., "Always respond in Bahasa")
- Type `/help` to see all available commands as tappable buttons
- Type `/status` to see a dashboard of what's running
- Type `/stop` if something is taking too long

---

*The rest of this document covers commands, features, and configuration in detail.*

---

## How It Works (Technical Overview)

This add-on runs a Telegram bot that connects to GitHub Copilot CLI using the Agent Client Protocol (ACP). When you send a message, Copilot processes your request with full access to MCP tools (Home Assistant, GitHub, etc.) and streams the response back to Telegram with progressive updates.

## Commands

### Mode & Model

- `/autopilot [on|off]` — Toggle autopilot mode (Copilot works without asking permission for each step)
- `/plan [on|off]` — Toggle plan-first mode (Copilot creates a plan before acting)
- `/mode` — Interactive mode picker with inline buttons
- `/model [name]` — Switch AI model by name, or tap to pick from an interactive list
- `/allowall [on|off]` — Toggle auto-approve for all tool calls (including write actions). When off, the bot asks before running Home Assistant write operations

### Session Management

- `/session new` — Restart the Copilot session (fresh conversation)
- `/session stop` — Shut down Copilot (saves resources)
- `/new [title]` — Create a new session. In forum mode, this also creates a new topic
- `/close` — Close the current forum topic session
- `/delete` — Delete a forum topic session and its topic
- `/sessions` — List all active sessions with their status

### Information

- `/status` — Show a live status menu with model, mode, session info, and action buttons. Auto-refreshes on state changes
- `/usage` — Show token usage metrics (context window, input/output tokens, turns)
- `/skills` or `/tools` — Show all available MCP tools (grouped by type: Home Assistant, GitHub, etc.) and bot commands
- `/history [n]` — Show the last *n* messages (default: 10, max: 30)
- `/help` — Show all commands with quick-action buttons

### Control

- `/stop` — Cancel the current Copilot operation (alias: `/cancel`)
- `/retry` — Resend the last user message to Copilot
- `/compact` — Compress conversation history to free up context window

### User Management

- `/pair` — Show pairing instructions for adding new users
- `/pair list` — List all paired users (admin only)
- `/unpair <userId>` — Revoke a user's access (admin only)

## Features

### Pinned Messages as Instructions

Pin a message in the chat to add persistent instructions that are included as context in every prompt. For example, pin "Always respond in Spanish" or "My house has 3 floors." The bot confirms with 📌 when it picks up the pinned message. Each chat can have its own pinned instruction.

### Reply Context & Chains

Reply to any message to include it as context for Copilot. If you reply to a message that itself was a reply, the bot walks the chain (up to 5 messages) and includes the full thread as context. This works for both user and bot messages.

### Permission System

The bot has two permission modes:

- **Interactive** (default): Read-only Home Assistant tools and standard Copilot tools are auto-approved. Write actions (turning on lights, calling services, etc.) prompt you with Allow/Deny/Allow-for-session buttons
- **Allow-all**: All tool calls are auto-approved without prompts. Toggle with `/allowall on` or via the status menu

Permissions are granted **per user, per scope** — allowing a tool in your DM won't affect group permissions, and vice versa. The `permission_policy` config option sets the default on startup.

### Multi-User Session Isolation

Each conversation gets its own independent Copilot session:

- **DM**: every user gets their own private session (`dm:{userId}`)
- **Group**: each group chat shares one session for all participants (`group:{chatId}`)
- **Forum**: each topic in a forum supergroup gets its own session (`forum:{chatId}:{threadId}`)

Sessions are automatically created on first message. The bot handles session switching transparently — you never need to manage this manually. Use `/sessions` to see all active scopes.

Resource limits: 30 DM slots + 20 group/forum slots. Least-recently-used sessions are evicted when limits are reached. The server owner (first `allowed_chat_ids` entry) is never evicted.

### Group Chat Support

Add the bot to a Telegram group for shared AI access:

- **@mention mode** (default): bot only responds when @mentioned, replied to, or receiving `/command@botname`
- **All mode**: bot responds to every message (set `group_mode: all` in config)
- Messages in groups are automatically attributed to the sender
- Only authorized (paired) users can interact — others are prompted to DM for pairing
- Responses are visible to all group members

**Group safety**: set `allowed_groups` to whitelist specific groups. Set `max_group_members` to prevent the bot from operating in large groups. The bot auto-leaves groups that don't meet these criteria.

### Rate Limiting

Each user is limited to 10 messages per minute across all conversations. This prevents any single user from overwhelming the bot. A warning message is shown when the limit is reached.

### Forum Mode (Topic-per-Session)

If you add the bot to a Telegram supergroup with Topics enabled, each topic becomes an independent Copilot session:

- The **General** topic becomes a management topic (commands only, no chat)
- Use `/new [title]` to create a new topic with its own session
- Each topic has isolated conversation history
- Use `/sessions` to see all topics and their status
- `/close` closes a topic session; `/delete` removes it entirely
- The bot auto-detects forum groups and creates sessions when you message in a topic

### User Pairing

New users can be granted access without editing the config:

1. An unknown user messages the bot
2. A 6-character pairing code is generated and logged to the HA add-on logs
3. An admin finds the code in the logs and shares it with the user
4. The user sends the code to the bot to complete pairing
5. Codes expire after 15 minutes

Users listed in `allowed_chat_ids` are automatically admins. Admins can manage users with `/pair list` and `/unpair`.

### Status Menu

The `/status` command shows a live dashboard with:

- Copilot state (Ready / Starting / Stopped)
- Current model and mode
- Session ID, available models count
- Permission mode, paired users, active sessions
- Quick-action buttons (Model, Mode, Usage, Compact, Restart, Stop, Allow-all toggle)

The status menu is a singleton — only one exists at a time. It auto-refreshes when state changes and can be dismissed.

### Progressive Response Display

Responses stream progressively into a single Telegram message:

- 🤔 **Thinking** indicator while Copilot reasons
- 🧠 **Live reasoning** line shown after 3 seconds (avoids flicker on fast responses)
- 🔧 **Tool steps** shown as they execute
- ✍️ **Answer preview** streams as Copilot generates text

On completion, the placeholder becomes the final answer. If reasoning or tool steps were involved, they appear in a **collapsible blockquote** below the answer — tap to expand.

### Emoji Reactions

Messages get automatic emoji reactions showing status:

- ⚡ Processing — your message is being handled
- ⏳ Queued — another conversation is active, you're next
- ✅ Done — response delivered successfully
- ⚠️ Errors — response delivered but some tool calls failed
- ✏️ Edited — you edited a message and it's being reprocessed

### Message Editing

You can edit messages after sending:

- **While queued**: the queue entry is silently updated with your corrected text
- **While processing**: the current operation is cancelled and resubmitted with the corrected text
- **After completion**: a correction prompt is sent so Copilot adjusts its answer without re-executing actions

### File Attachments

Send text files (`.yaml`, `.json`, `.py`, `.log`, `.txt`, `.csv`, `.xml`, `.md`, and more) and they're read as UTF-8 and injected into the prompt as context. Maximum file size: 50 KB. Photos and images are sent to Copilot directly for visual analysis.

### Unsupported Media

The bot handles unsupported message types gracefully with helpful suggestions:

- 🎤 **Voice/audio** — suggests keyboard speech-to-text
- 🎬 **Video/GIF** — suggests sending a screenshot instead
- 🎭 **Stickers** — emoji is extracted and sent as context
- 📍 **Locations** — coordinates are forwarded (useful for Home Assistant)
- 👤 **Contacts** — friendly rejection

### Graceful Shutdown

When the add-on stops while a response is in progress, a notification is sent so users know the operation was interrupted. If a status menu is open, it's updated to show "Stopped."

## Configuration Options

### Required

**bot_token**
Your Telegram bot token from @BotFather.

**allowed_chat_ids**
List of Telegram user/chat IDs allowed to use the bot. Get yours from @userinfobot. These users are automatically admins for pairing purposes.

### Authentication

**github_token**
A GitHub fine-grained personal access token (PAT). Used by Copilot for GitHub API access.

### Copilot Settings

**model**
Default AI model. Set to `auto` (default) for automatic selection, or specify a model name like `claude-sonnet-4-5`.

**preamble**
System prompt prefix sent to Copilot at the start of each session. The default instructs Copilot to be concise and Telegram-friendly. Changing this resets on next session start.

**permission_policy**
Default permission mode on startup. Options:
- `interactive` (default) — prompts for write actions
- `allow_all` — auto-approves all tool calls

**copilot_binary**
Path to the Copilot CLI binary. Default: `/share/copilot-tools/copilot`

**copilot_config_dir**
Where Copilot's login credentials live. Default: `/share/copilot-tools/.copilot`

**copilot_extra_args**
Additional command-line flags passed to Copilot CLI.

### Behavior

**auto_start**
If `true` (default), Copilot starts when the add-on boots. If `false`, it starts on demand when you send your first message.

**idle_timeout_minutes**
Automatically stop Copilot after this many minutes of inactivity. Set to `0` (default) to keep it running indefinitely. Maximum: 1440 (24 hours).

**working_directory**
The directory Copilot works in. Default: `/config` (your Home Assistant configuration directory).

### Group Settings

**group_mode**
How the bot responds in groups. Options:
- `mention` (default) — only responds to @mentions, replies, and `/command@botname`
- `all` — responds to every message in the group

**allowed_groups**
List of group chat IDs the bot is allowed to join. Leave empty to allow all groups. The bot auto-leaves groups not on this list.

**max_group_members**
Maximum number of members a group can have for the bot to operate. Default: 50. Range: 1–1000. The bot leaves groups that exceed this limit.

## Troubleshooting

**Bot doesn't respond at all**
→ Check the Log tab. Most likely: wrong bot token or your chat ID isn't in the allowed list.

**"Copilot binary not found"**
→ Copilot CLI isn't installed. Install it via the VS Code Server add-on or manually to `/share/copilot-tools/copilot`.

**"ACP test failed"**
→ Copilot isn't logged in. Open a terminal and run: `/share/copilot-tools/copilot login`

**"Another process is polling"**
→ Another bot instance is running with the same token. Wait 30 seconds, then restart this add-on.

**Responses are slow**
→ Complex tasks take time. Watch for typing indicators. Use `/stop` if stuck.

**Permission prompts not appearing**
→ Check that `permission_policy` is set to `interactive`. If `/allowall on` was used, it overrides until the session restarts.

**Forum topics not working**
→ The bot must be added to a supergroup with Topics enabled. Make sure it has admin permissions to create/manage topics.

## Prerequisites

- Copilot CLI must be installed and authenticated (usually via the VS Code Server add-on)
- The binary must be on a shared volume accessible to this add-on (default: `/share/copilot-tools/copilot`)
- A GitHub fine-grained PAT for full functionality

## More Info

Source code: https://github.com/layman-smart-home-people/ha-copilot-telegram-bot

This software is provided as-is, without warranty of any kind.
