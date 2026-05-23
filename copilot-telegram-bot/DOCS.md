# Copilot Telegram Bot

An always-on Telegram bot that connects to GitHub Copilot CLI via the Agent Client Protocol (ACP).

## Features

- 🤖 **Always-on** — The Telegram bot runs continuously, even when no Copilot CLI session is active
- ⚡ **On-demand Copilot** — Copilot CLI starts automatically when you send a message
- 💬 **Rich messaging** — Markdown formatting, code blocks, images, file attachments
- 🔧 **Tool status** — See what Copilot is doing in real-time (tool call bubbles)
- 📱 **Slash commands** — `/autopilot`, `/model`, `/mode`, `/compact`, `/usage`, `/status`, `/help`
- 🔄 **Auto-reconnect** — Automatically restarts Copilot if it crashes
- ⏸️ **Idle timeout** — Optionally stop Copilot after inactivity to save resources

## Prerequisites

1. **GitHub Copilot CLI** must be installed and authenticated (e.g., via the VS Code Server add-on)
2. The Copilot binary must be accessible at `/share/copilot-tools/copilot`
3. A **Telegram Bot** token from [@BotFather](https://t.me/BotFather)

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `bot_token` | Telegram bot token from BotFather | (required) |
| `allowed_chat_ids` | List of Telegram chat IDs allowed to use the bot | `[]` |
| `copilot_binary` | Path to the Copilot CLI binary | `/share/copilot-tools/copilot` |
| `copilot_config_dir` | Path to Copilot config (auth, etc.) | `/share/copilot-tools/.copilot` |
| `copilot_extra_args` | Extra CLI arguments for Copilot | `""` |
| `preamble` | System instructions for Telegram formatting | (see default) |
| `auto_start` | Start Copilot session on boot | `true` |
| `idle_timeout_minutes` | Stop Copilot after N minutes idle (0 = never) | `0` |
| `model` | Default AI model to use | `""` (auto) |
| `working_directory` | Copilot working directory | `/config` |

## Getting Your Chat ID

1. Send a message to [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your chat ID
3. Add this number to `allowed_chat_ids` in the add-on config

## Slash Commands

- `/autopilot [on|off]` — Toggle autopilot mode
- `/plan [on|off]` — Toggle plan mode
- `/mode` — Show current mode
- `/model [name]` — Show or switch model
- `/compact` — Compact conversation history
- `/usage` — Show token usage metrics
- `/status` — Show bot and Copilot status
- `/session [new|stop]` — Manage Copilot session
- `/help` — Show available commands

## Architecture

The add-on consists of:

1. **Telegram Client** — Always-on long polling for incoming messages
2. **ACP Client** — Spawns Copilot CLI as a child process using `copilot --acp --stdio`
3. **Bridge** — Routes messages between Telegram and Copilot, handles formatting, typing indicators, tool call bubbles, and file attachments

The ACP (Agent Client Protocol) is a JSON-RPC 2.0 protocol over stdio that provides programmatic access to Copilot CLI sessions.
