# Copilot Telegram Bot

Talk to GitHub Copilot CLI from your phone via Telegram.

## How It Works

This add-on runs a Telegram bot that connects to Copilot CLI using the Agent Client Protocol (ACP). When you send a message, Copilot wakes up, processes your request, and sends the response back to Telegram.

## Setup

### 1. Create a Telegram Bot

1. Open Telegram → search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABC...xyz`)

### 2. Find Your Chat ID

1. Open Telegram → search for **@userinfobot**
2. Send it any message
3. It replies with your numeric chat ID

### 3. Configure This Add-on

- **bot_token**: Paste your token from BotFather
- **allowed_chat_ids**: Add your chat ID number

### 4. Start the Add-on

Click Start on the Info tab, then send a message to your bot!

## Commands

- `/autopilot on` — Let Copilot work without asking permission
- `/autopilot off` — Ask before each action
- `/plan on/off` — Toggle plan-first mode
- `/model <name>` — Switch AI model (e.g., `claude-sonnet-4-5`)
- `/compact` — Free up conversation memory
- `/cancel` — Stop what Copilot is currently doing
- `/usage` — See how many tokens you've used
- `/status` — Check if everything is running
- `/session new` — Start a fresh conversation
- `/session stop` — Shut down Copilot (saves resources)
- `/help` — Show all commands

## Configuration Options

**bot_token** *(required)*
Your Telegram bot token from @BotFather.

**allowed_chat_ids** *(required)*
List of Telegram user IDs allowed to use the bot. Get yours from @userinfobot.

**copilot_binary**
Path to the Copilot CLI binary. Default: `/share/copilot-tools/copilot`

**copilot_config_dir**
Where Copilot's login credentials live. Default: `/share/copilot-tools/.copilot`

**copilot_extra_args**
Additional flags passed to Copilot (e.g., `--model opus`).

**preamble**
Instructions sent to Copilot at the start of each session. The default tells Copilot to be concise and Telegram-friendly.

**auto_start**
If `true`, Copilot starts when the add-on boots. If `false`, it starts when you send your first message.

**idle_timeout_minutes**
Automatically stop Copilot after this many minutes of inactivity. Set to `0` to keep it running forever.

**model**
Default AI model. Leave blank for auto-selection.

**working_directory**
The directory Copilot works in. Default: `/config` (your HA config directory).

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
→ Complex tasks take time. Watch for typing indicators. Use `/cancel` if stuck.

## Prerequisites

- Copilot CLI must be installed and authenticated (usually via VS Code Server add-on)
- The binary must be on a shared volume accessible to this add-on (default: `/share/copilot-tools/copilot`)

## More Info

Full documentation and source code:
https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
