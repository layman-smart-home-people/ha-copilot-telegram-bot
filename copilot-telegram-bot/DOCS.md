# Copilot Telegram Bot

**Control your smart home with AI — right from Telegram.** Version **0.28.0**.

---

## 🏠 What Is This?

This Home Assistant add-on gives you an always-on AI assistant in Telegram, with a built-in web dashboard, persistent agent memory, and a standing instruction system for alerts, reminders, and scheduled tasks.

You can use it like a chat assistant, a smart-home operator, or a proactive helper that watches for events and acts on them.

No coding is required to get started.

## 💬 What Can I Do With It?

Here are some things you can ask your bot:

- **"Turn off all the lights"** — control Home Assistant devices
- **"What's the temperature upstairs?"** — read sensors and entity state
- **"Is the front door locked?"** — check status before you sleep
- **"Remind me at 8 PM to take my medicine"** — create a timed reminder
- **"If the washer finishes, alert me"** — create a standing instruction
- **"Show me today's calendar"** — read HA calendars
- **"Summarize all active alerts and battery issues"** — generate reports
- **"Open the docs and change your default tone"** — customize agent behavior

You can also reply to earlier messages for context, pin chat-specific instructions, work from Telegram or the WebUI, and keep long-term memory between sessions.

## 🚀 Getting Started

You'll need three things:

- a Telegram bot
- a GitHub account with Copilot access
- your Telegram user ID

### Step 1 — Create Your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** BotFather gives you

It looks something like:

```text
123456789:ABC...xyz
```

### Step 2 — Find Your Telegram User ID

1. Open Telegram and search for **@userinfobot**
2. Send it any message
3. Copy your numeric ID

### Step 3 — Configure the Add-on

In Home Assistant, open the add-on configuration and fill in:

- **`bot_token`** — your Telegram bot token
- **`allowed_chat_ids`** — your Telegram user ID

Optional but useful:

- **`github_token`** — for GitHub-backed Copilot features
- **`agent_dir`** — where the bot stores identity, memory, skills, and tasks

### Step 4 — Start the Add-on

Start the add-on from Home Assistant.

Then:

- send your bot a message in Telegram, or
- open the add-on's **WebUI** through Home Assistant Ingress

### Step 5 — Try a Few Commands

Good first commands:

- `/help` — show the main command menu
- `/status` — live bot status
- `/model` — choose an AI model
- `/standing` — inspect standing instructions

## 🎯 Handy Tips for Everyday Use

- **Reply to a message** to give Copilot more context
- **Pin a message** to add chat-specific guidance like "Always answer in Bahasa"
- Use `/help` if you prefer buttons over typing commands
- Use `/status` for a live control panel
- Use `/standing` for reminders, alerts, and scheduled actions
- Use the **WebUI** for longer editing tasks, docs, logs, and configuration
- Use `/stop` or `/cancel` if something is taking too long

---

*The rest of this document covers commands, features, and configuration in more detail.*

---

## How It Works (Technical Overview)

This add-on runs a Telegram bot connected to GitHub Copilot CLI via ACP (Agent Client Protocol).

When a session starts, the bot injects multiple layers of context:

- the **preamble** — channel-specific instructions such as Telegram formatting and API hints
- the agent's persistent files from **`agent_dir`** — especially `IDENTITY.md`, `MEMORY.md`, `SKILLS.md`, and `TASKS.md`
- chat-specific context such as pinned messages and reply chains

The result is an assistant that can:

- answer questions and perform actions through Home Assistant tools
- remember durable facts across sessions
- manage ongoing tasks
- react automatically through standing instructions
- be administered through Telegram or the WebUI

## Commands

### Everyday Commands

- `/help` — show help with quick-action buttons
- `/status` — open the live status menu
- `/history [n]` — show recent messages
- `/retry` — resend your last message
- `/stop` — cancel the current operation
- `/cancel` — alias for `/stop`
- `/compact` — compress conversation history
- `/usage` — show token usage and session stats
- `/context` — same usage/context-window view as `/usage`

### Mode & Model Commands

- `/autopilot [on|off]` — let the agent execute without pausing for each step
- `/plan [on|off]` — prefer plan-first behavior
- `/fleet` — parallel agent mode
- `/mode` — interactive mode switcher
- `/model [name]` — choose a model by name or from a picker
- `/allowall [on|off]` — auto-approve tool calls for the current conversation

### Session & Topic Commands

- `/new [title]` — start a new session; in forum mode this creates a new topic
- `/close` — close the current forum topic
- `/delete` — delete the current forum topic
- `/sessions` — list active sessions/scopes
- `/clear` — reset the current conversation/session
- `/session new` — start a fresh session in the current scope
- `/session stop` — stop Copilot for the current scope
- `/session kill` — hard-stop the current scope session

### Pairing & Access Commands

- `/pair` — pairing help for adding users
- `/pair list` — list paired users (admin)
- `/unpair <userId>` — remove a user's access

### Discovery Commands

- `/skills` — list available MCP tools and bot capabilities
- `/tools` — alias for `/skills`

### Standing Instruction Commands

- `/standing` — show the standing instruction summary
- `/standing list` — list instructions
- `/standing inspect <id>` — inspect a specific instruction
- `/standing enable <id|all>` — enable one or more instructions
- `/standing disable <id|all>` — disable one or more instructions
- `/standing delete <id|all>` — delete one or more instructions
- `/standing pause` — pause all standing instructions temporarily
- `/standing resume` — resume paused instructions
- `/standing mute <duration>` — suppress triggers for a while (for example `30m` or `2h`)

## Features

### Standing Instructions

**Standing Instructions** are the add-on's built-in system for automated alerts, reminders, and scheduled tasks.

They persist across restarts and can be created or edited by:

- asking the agent in plain language
- using `/standing`
- using the WebUI **Instructions** tab
- editing the JSON file directly

### Storage & Reloading

- Stored at **`/data/standing_instructions.json`**
- Changes are **hot-reloaded immediately** when the file changes
- No add-on restart is required after saving the file

### Trigger Types

Each instruction has one trigger. Supported trigger types are:

- **`state_change`** — watch one or more Home Assistant entities for changes
- **`cron`** — run on a recurring 5-field cron schedule
- **`timer`** — run once at a specific timestamp

### Action Types

Each instruction has one action. Supported action types are:

- **`wake_agent`** — wake Copilot with a prompt for reasoning-heavy work
- **`notify`** — send a Telegram notification directly
- **`ha_service`** — call a Home Assistant service directly without waking the agent

`ha_service` is new in **0.28.0** and is ideal for fast, lightweight actions such as toggling helpers, scenes, lights, or scripts.

### Lifecycle Controls

Standing instructions can be made temporary or self-limiting:

- **`one_shot`** — disable after the first trigger
- **`max_triggers`** — disable after firing a set number of times
- **`expires_at`** — disable after a specific date/time

### Chaining & Context

Standing instructions can work together:

- **`chain_enable`** — enable another instruction after this one fires
- **`notes`** — store free-form context for the agent between linked instructions

This lets you build small workflows, such as:

1. one instruction watches for arrival
2. it enables a second instruction for a departure event
3. the second instruction handles the follow-up action

### Example

```json
{
  "version": 1,
  "instructions": [
    {
      "description": "Remind me to water the plants tomorrow morning",
      "enabled": true,
      "trigger": {
        "type": "timer",
        "fire_at": "2025-01-15T01:00:00.000Z"
      },
      "action": {
        "type": "notify",
        "message": "🪴 Time to water the plants"
      },
      "one_shot": true,
      "notes": "Kitchen and balcony plants"
    }
  ]
}
```

### Agent Memory System

The add-on now has a persistent **agent memory system** so the assistant can keep a stable identity and remember important facts across sessions.

By default, the memory directory is:

```text
/config/copilot-telegram-bot
```

You can change this with the **`agent_dir`** config option.

### Files in `agent_dir`

- **`IDENTITY.md`** — the agent's personality, role, and operating rules
- **`MEMORY.md`** — long-term learned facts and durable knowledge
- **`SKILLS.md`** — skills/capabilities reference loaded into session context
- **`TASKS.md`** — active task tracking and resume notes
- **`memory/YYYY-MM-DD.md`** — daily logs for recent observations and work

### How It Works

On a fresh install, the add-on automatically creates and seeds these files with defaults.

On each new session, it loads:

- identity
- memory
- skills
- tasks
- recent daily logs

This gives the assistant continuity without you having to repeat everything every time.

### Preamble vs `IDENTITY.md`

These two are related, but they do different jobs.

### The Preamble

The **`preamble`** config option is for channel-specific instructions such as:

- how to format Telegram replies
- reminders like "don't use tables"
- API access hints
- environment notes

### `IDENTITY.md`

**`IDENTITY.md`** is where the assistant's personality and behavior live, for example:

- tone and style
- what it should prioritize
- how proactive it should be
- household-specific rules and preferences

### Important Behavior

Both the **preamble** and **`IDENTITY.md`** are injected at session start.

Use them like this:

- customize **`preamble`** for **format and channel behavior**
- customize **`IDENTITY.md`** for **personality, role, and rules**

### WebUI

The add-on includes a built-in **WebUI** available through Home Assistant Ingress.

Open it from the add-on page or sidebar panel.

### Tabs

- **Dashboard** — status overview, system details, and activity summary
- **Chat** — web-based Copilot chat separate from Telegram
- **Instructions** — visual standing instruction manager
- **Docs** — edit agent docs like `IDENTITY.md`, `MEMORY.md`, `SKILLS.md`, `TASKS.md`, and daily logs
- **Logs** — view live bot logs
- **Config** — edit add-on configuration

The WebUI is especially useful for desktop use, longer edits, and reviewing logs without leaving Home Assistant.

### Pinned Messages as Persistent Chat Context

Pinned messages still work, but they are **not** the same thing as standing instructions.

Use a **pinned message** for chat context such as:

- "Always answer in Bahasa"
- "Call the upstairs AC 'Jasmine AC'"
- "Keep responses under 5 bullet points"

Use a **standing instruction** for automation-like behavior such as:

- "If freezer temperature rises above -10°C, alert me"
- "Remind me at 9 PM to lock the gate"

Each chat can have its own pinned context.

### Reply Context & Chains

Reply to any message to include it as context. If that message was itself a reply, the bot walks the recent reply chain so follow-up questions stay coherent.

This works for both user messages and bot messages.

### Permission System

The bot has two permission modes:

- **Interactive** (default) — safe/default mode; write actions ask for approval
- **Allow-all** — auto-approve tool calls for that conversation

Use `/allowall` to switch modes quickly.

Permissions are scoped per conversation, so changing behavior in one chat does not silently change another.

### Multi-User Session Isolation

Each conversation gets its own Copilot session:

- **DM** — one private session per user
- **Group** — one shared session per group
- **Forum topic** — one session per topic

Sessions are created automatically on first use.

Use `/sessions` to inspect active scopes.

### Group Chat Support

The bot works in Telegram groups and forum supergroups.

### Group Modes

- **`mention`** (default) — reply only when mentioned, replied to, or called with `/command@botname`
- **`all`** — reply to every message in the group

### Safety Controls

- **`allowed_groups`** — whitelist permitted groups
- **`max_group_members`** — keep the bot out of very large groups

Unauthorized users in groups are guided through pairing instead of being allowed in automatically.

### Rate Limiting

The bot rate-limits incoming messages to keep one user from overwhelming the service.

If you hit the limit, wait a moment and use `/retry` if needed.

### Forum Mode (Topic-per-Session)

In Telegram forum supergroups, each topic becomes its own independent AI session.

- the **General** topic is reserved for management/commands
- `/new [title]` creates a topic with its own session
- `/close` closes the current topic session
- `/delete` deletes the topic and its session

This is useful for organizing projects, households, or issue threads.

### User Pairing

You can add users without editing the add-on config every time.

Typical flow:

1. an unknown user messages the bot
2. a pairing code is generated
3. the code appears in add-on logs
4. an admin shares the code with the user
5. the user sends the code to the bot

Users in **`allowed_chat_ids`** are admins automatically.

### Status Menu

`/status` opens a live status menu with quick controls and current state, including things like:

- whether Copilot is running
- current model and mode
- usage/session information
- permission mode
- active sessions
- shortcut buttons for common actions

### Progressive Response Display

Replies stream progressively into Telegram:

- thinking indicator
- tool activity
- partial answer preview
- final response in place

If the answer involved reasoning or tools, the bot can include a collapsible details block under the final message.

### Emoji Reactions

The bot uses emoji reactions to show status, such as:

- ⚡ processing
- ⏳ queued
- ✅ finished
- ⚠️ finished with issues
- ✏️ edited/reprocessed

### Message Editing

Editing a message after sending is supported:

- while queued — the queued request is updated
- while running — the current operation is cancelled and resubmitted
- after completion — the correction is sent back as follow-up context

### File Attachments

The bot can read common text files and pass them to the agent as context.

Examples include:

- `.yaml`
- `.json`
- `.py`
- `.log`
- `.txt`
- `.csv`
- `.xml`
- `.md`

Text attachments are read as UTF-8 and limited to about **50 KB**. Images are passed through for visual analysis.

### Unsupported Media

Unsupported media is handled gracefully.

Examples:

- voice/audio — suggests text or speech-to-text
- video/GIF — suggests a screenshot
- stickers — sends sticker emoji as context when possible
- locations — forwards coordinates
- contacts — politely rejected

### Graceful Shutdown

If the add-on stops while a request is running, the bot notifies the affected user so the interruption is visible instead of silent.

## Configuration Options

All existing options remain available in **0.28.0**.

### Required

**`bot_token`**
Your Telegram bot token from @BotFather.

**`allowed_chat_ids`**
Telegram user/chat IDs allowed to use the bot. These users are also treated as admins for pairing.

### Authentication

**`github_token`**
Optional GitHub token for Copilot/GitHub-backed features. If omitted, you can authenticate later through the device flow.

### Copilot Settings

**`model`**
Default model. Use `auto` for automatic selection, or set a specific model name.

**`preamble`**
Channel-specific prompt prefix injected at session start. Best used for formatting, delivery style, and environment hints.

**`permission_policy`**
Default permission behavior on startup:

- `interactive`
- `allow_all`

**`copilot_binary`**
Path to the Copilot CLI binary. `auto` lets the add-on manage it automatically.

**`copilot_config_dir`**
Directory for Copilot authentication/config. `auto` lets the add-on manage it automatically.

**`copilot_extra_args`**
Additional CLI arguments passed to Copilot.

### Behavior

**`auto_start`**
If `true`, Copilot starts with the add-on. If `false`, it starts on first use.

**`idle_timeout_minutes`**
Stop Copilot after inactivity. `0` means never auto-stop.

**`working_directory`**
The default working directory for Copilot. Default: `/config`.

**`agent_dir`**
Directory for the agent memory system. Default:

```text
/config/copilot-telegram-bot
```

This directory stores `IDENTITY.md`, `MEMORY.md`, `SKILLS.md`, `TASKS.md`, and daily logs.

### Group Settings

**`group_mode`**
How the bot behaves in groups:

- `mention`
- `all`

**`allowed_groups`**
Optional list of group IDs the bot is allowed to join.

**`max_group_members`**
Maximum allowed group size before the bot leaves or refuses the group.

## Troubleshooting

**Bot doesn't respond at all**
→ Check the add-on logs first. Common causes are a wrong bot token or your chat ID missing from `allowed_chat_ids`.

**The WebUI does not load**
→ Refresh the page, then restart the add-on if needed. If Ingress works but the UI stays blank, check add-on logs for WebUI startup errors.

**Standing instructions are not firing**
→ Check `/standing` or the WebUI Instructions tab. Confirm the instruction is enabled, not expired, and that the trigger condition actually matches. If you edited `/data/standing_instructions.json`, verify the JSON is valid.

**Changes to `standing_instructions.json` are ignored**
→ Save the file fully and check logs for validation errors. The file is hot-reloaded, so a restart should not be necessary.

**Agent personality changes are not taking effect**
→ Edit `IDENTITY.md` in `agent_dir`, then start a **new session** so the updated context is injected.

**"Copilot binary not found"**
→ On first start, the add-on auto-downloads the Copilot CLI from GitHub. If this fails, check internet connectivity and restart the add-on. To force a re-download, delete `/data/copilot/bin/copilot` inside the add-on container. If you set a custom `copilot_binary` path, make sure that binary exists and is executable.

**"ACP test failed" or authentication errors**
→ Copilot still needs GitHub authentication. Complete the device flow when prompted.

**"Another process is polling"**
→ Another Telegram bot instance is already using the same token. Stop the duplicate instance, wait a moment, then restart this add-on.

**Responses are slow**
→ Complex tasks can take time. Watch the live progress indicators and use `/stop` if needed.

**Permission prompts are not appearing**
→ Check `permission_policy`. If `/allowall on` was enabled for that conversation, prompts are bypassed until you turn it off or reset the session.

**Forum topics are not working**
→ Make sure the bot is in a Telegram supergroup with Topics enabled and has permission to manage topics.

## Prerequisites

- a GitHub account with Copilot access
- a Telegram bot token from @BotFather
- Home Assistant with this add-on installed
- Internet access on first start (to auto-download the Copilot CLI binary)

The add-on automatically downloads and manages the Copilot CLI on first start. The binary is stored in `/data/copilot/bin/` and persists across add-on updates. To force a re-download (e.g. to update the CLI), delete the binary and restart the add-on.

## More Info

Source code: https://github.com/layman-smart-home-people/ha-copilot-telegram-bot

This software is provided as-is, without warranty of any kind.
