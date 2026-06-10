# Copilot Telegram Bot for Home Assistant

**Version 2.3.6**

Run a private, local-first Home Assistant operator in Telegram. This add-on connects Telegram to GitHub Copilot CLI, keeps conversations isolated by scope, adds persistent memory and standing instructions, and exposes a WebUI control plane for operators.

## What it does

- **Telegram-first control** for Home Assistant questions, investigation, and guided actions
- **ACP worker pool** for concurrent conversations instead of one global worker
- **Scoped conversations** for DMs, groups, forum topics, and WebUI chat
- **Progressive streaming** in Telegram with live tool and response updates
- **PKM memory system** with pinned core memory, search, and dream maintenance
- **Standing instructions** for schedules, state-change triggers, notifications, and agent wake-ups
- **WebUI operator console** for status, chat, access control, docs, logs, and config

## Current Telegram command surface

The bot currently registers these commands:

| Command | Purpose |
| --- | --- |
| `/start` | Welcome and quick-start entry |
| `/help` | Show the current command list |
| `/status` | Show bot, pool, and instruction status |
| `/new` | Start a fresh conversation in the current scope |
| `/stop` | Cancel the current operation in the current scope |
| `/settings` | Change the model for the current conversation scope; owners can also change add-on-wide permission policy |
| `/standing` | Manage standing instructions |
| `/memory` | Inspect memory status and agent identity files |
| `/dream` | Run deep memory maintenance |

## What changed in 2.3.x

The codebase still uses the **v7 pool architecture**, but the current release line is **2.3.x**, not `0.14.x` or `1.0.0`.

Key capabilities already live in the current line:

- pooled ACP runtime
- RBAC and invites
- PKM memory backend and `/dream`
- standing-instruction engine
- WebUI chat and control APIs
- scoped conversation management

## Important behavior notes

- **Telegram is the primary user surface.** The WebUI is the operator control plane.
- **`/start` is now a real onboarding entry.** It gives a welcome, suggested first actions, and quick links instead of only mirroring `/help`.
- **Conversation scope matters.**
  - DMs isolate by user
  - non-forum groups isolate by group + user
  - forum groups isolate by topic participation
- **`/settings` model selection is scope-local.** Changing the model starts a fresh conversation for that scope only.
- **`/stop` is a real cancel.** It stops the current run instead of steering a literal `/stop` prompt into the session.
- **Permission policy is add-on wide and owner-managed.**
- **Interactive permissions now follow the configured runtime policy.**
- **WebUI chat is scoped per authenticated Home Assistant ingress user.**
- **Privileged WebUI write actions use an explicit operator allowlist.** Set `webui_operator_ids` to the Home Assistant user IDs that may use privileged WebUI actions.
- **Text attachments are supported.** Photo handling exists, but richer media behavior should still be treated as evolving.
- **Public async/background-task behavior should be treated as experimental until a durable job model exists.**
- **Invite links now confirm success immediately.** Newly paired users get a welcome message instead of falling into a silent no-op.

## Quick start

1. Install the Home Assistant add-on from this repository.
2. Create a Telegram bot with **@BotFather**.
3. Put your Telegram user ID in `allowed_chat_ids`.
4. Start the add-on.
5. Send the bot a message in Telegram.

Minimum configuration:

```yaml
bot_token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
allowed_chat_ids:
  - "123456789"
default_model: standard
pool_size: 5
pool_pre_warm: 1
webui_operator_ids: []
```

## Operator surfaces

### Telegram

Best for:

- quick control
- natural-language questions
- follow-up investigation
- standing-instruction creation

### WebUI

Best for:

- dashboard and operational status
- RBAC and audit review
- editing agent docs
- viewing logs
- configuration management

## Documentation map

- **Add-on README:** `copilot-telegram-bot/README.md`
- **Detailed docs:** `copilot-telegram-bot/DOCS.md`
- **Changelog:** `copilot-telegram-bot/CHANGELOG.md`

## Current product direction

This project is being tightened around one main product identity:

> A local-first Home Assistant agent in Telegram that remembers your household, helps with daily control and investigation, and acts within explicit safety boundaries.

The Copilot CLI runtime also makes coding and file-system assistance possible, but that is supporting capability, not the main market identity.
