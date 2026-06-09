# Copilot Telegram Bot — v7 Documentation

Version **1.0.0** is the v7 rewrite of the Home Assistant add-on that connects **Telegram** to **GitHub Copilot CLI** through **ACP (Agent Client Protocol)**.

The big change is architectural: v7 replaces the old single-instance orchestrator with an **ACP Pool** that can run multiple Copilot CLI workers at once.

For installation and a fast onboarding flow, start with [README.md](./README.md).

## ✨ What changed in v7

- **ACP Pool** with **1-10** configurable Copilot CLI instances
- **Concurrent conversations** instead of one global worker
- **Scope isolation** by DM, group user, or forum topic
- **Steering** when a user changes direction mid-response
- **Crash recovery** that reacquires a new instance and retries automatically
- **Progressive Telegram rendering** via the new ResponseStreamer
- A much smaller Telegram command surface: **7 commands only**

## 🧱 Architecture overview

### ACP Pool

The pool is the runtime core of v7.

- Configurable size: **1-10 instances**
- Default size: **5**
- Model tiers:
  - `fast` → Claude Haiku 4.5
  - `standard` → Claude Sonnet 4.5
  - `reasoning` → Claude Opus 4.6
- MCP profiles:
  - `owner` → full Home Assistant tooling
  - `guest` → restricted tooling

When a conversation needs a worker, the pool tries this acquire path:

1. **Sticky** — reuse the instance already claimed by that scope
2. **Matching idle** — exact model tier + MCP profile match
3. **Spawn** — create a new worker if below pool limit
4. **Reconfigure** — retune an idle worker to the requested model
5. **Evict** — remove the oldest idle worker if necessary
6. **Wait queue** — hold briefly until a suitable worker becomes available

The pool also handles:

- health checks
- idle reaping
- crash supervision
- pre-warming
- per-instance isolation

### Conversations

Each active scope gets its own conversation object and, while active, its own claimed pool instance.

Conversation states are:

- `idle`
- `prompting`
- `eliciting`
- `dead`

Two important behaviors define v7:

#### Steering

If a user sends another message while the bot is still processing, the conversation cancels the old prompt and starts the new one.

#### Crash recovery

If a Copilot CLI instance dies mid-conversation, v7 automatically acquires a new instance for the same scope and retries the prompt.

### ResponseStreamer

The v8 streamer renders replies in phase-based blocks (like VSCode Copilot):

1. **Thinking phases** — tool status shown live, collapsed when done
2. **Response text** — streamed clean after tools complete
3. **Multi-message** — long responses split at paragraph boundaries (no truncation)
4. **Expandable tool summary** — collapsible block at the end with step count and timings

Rendering mode depends on chat type:

- **Private chats** use draft-style progressive rendering
- **Groups and forums** use edit-in-place rendering

### Gateway

The Gateway is the clean routing layer in front of the pool and conversations.

It includes:

- **Router** — parses Telegram updates, resolves scopes, handles the 7 commands
- **Permissions** — role gate with `owner`, `member`, and `guest`
- **PromptEnricher** — injects sender info, pinned instructions, and agent files

### Standing Instructions

Standing instructions still work the same way as before. They remain the add-on's persistent automation-style system for alerts, reminders, scheduled work, and agent wake-ups.

### WebUI

The Ingress WebUI remains available and is the main operator surface for:

- status dashboards
- web chat
- standing instruction management
- editing agent docs
- viewing logs
- editing add-on config

## 💬 Command reference

v7 intentionally keeps only these commands in Telegram:

### `/help`
Show the current command list.

### `/status`
Show bot, pool, conversation, and metrics status.

Typical status output includes:

- active / idle / booting pool counts
- current instance assignments
- active conversation count
- total prompt count
- wait queue size
- crash count (if any)

### `/new`
Start a fresh conversation in the current scope.

### `/stop`
Cancel the current operation for the current scope.

### `/settings`
Coming soon.

### `/standing`
Coming soon.

The standing instruction engine itself is already available; this command surface is just not finished yet.

### `/memory`
Coming soon.

The memory system itself is already available; this command surface is just not finished yet.

## 🧭 Scope model: DMs, groups, and forums

Understanding scopes is the most important behavior change in v7.

### Scope keys

v7 uses these scope keys internally:

- `dm:{userId}`
- `group:{chatId}:{userId}`
- `forum:{chatId}:{threadId}`

### Direct messages

In DMs, each user gets one conversation:

- one user
- one DM scope
- one claimed pool instance while active

### Groups (non-forum)

In standard groups and supergroups **without topics**, the bot isolates conversations **per user within the group**.

That means:

- two different people in the same group do **not** share one conversation state
- each user gets their own scope inside that group
- this prevents accidental context bleed between participants

### Forum groups (topics enabled)

In Telegram forum groups, the bot isolates by **topic thread**.

That means:

- each topic gets its own conversation
- messages inside one topic do not affect another topic
- the bot simply follows Telegram's thread model automatically

There is **no special user notification** about thread mode. It just works based on where the message arrives.

### Summary

- **DM:** per user
- **Group (non-forum):** per user within the group
- **Forum:** per topic thread

## 👥 Permissions and roles

v7 uses a simple 3-role system:

- **owner** — full access
- **member** — allowed user with owner MCP profile and normal default model routing
- **guest** — allowed user with restricted MCP profile and guest model routing

Sources of authority:

- `allowed_chat_ids` seed the initial **owner** accounts
- optional RBAC data can add members and guests

Role behavior:

- owners and members use `default_model`
- guests use `guest_model`
- standing instructions use `si_default_model`

## 🧠 Prompt enrichment and persistent context

On the first message of a conversation, v7 injects:

- the configured `preamble`
- agent files from the agent directory
- sender identity metadata
- any pinned chat instructions
- reply context when the user replies to a bot message

This makes each new conversation start with the right operating context without the user repeating setup information.

## 📌 Pinned messages

Pinned messages are still supported and still useful.

Use a pinned message for durable chat context such as:

- response style preferences
- naming conventions
- room aliases
- household rules

Examples:

- “Always answer in Bahasa.”
- “Call the upstairs AC Jasmine AC.”
- “Keep replies under 5 bullets.”

Pinned messages are **not** the same as standing instructions:

- pinned messages shape conversational behavior
- standing instructions trigger automation-like behavior over time

## ↩️ Reply context

If a user replies to a bot message, the router preserves that reply context and includes a short reference in the prompt.

This helps follow-up questions stay coherent without rebuilding the full prior conversation manually.

## ⚙️ Configuration reference

Below is the v7 add-on configuration surface.

```yaml
bot_token: ""
allowed_chat_ids: []
github_token: ""
copilot_binary: auto
copilot_config_dir: auto
copilot_extra_args: ""
preamble: >-
  This message arrived via Telegram. Be concise and mobile-friendly.
  Use markdown (bold, lists, code blocks) — it's auto-converted to Telegram HTML.
  Never use tables. For complex data, save an HTML report to /config/www/ and share the URL.
  You have direct HA access: curl -s http://supervisor/core/api/... -H "Authorization: Bearer $SUPERVISOR_TOKEN".
  If ha-mcp MCP tools are available, prefer those for dashboards.
auto_start: true
idle_timeout_minutes: 0
model: auto
working_directory: /config
permission_policy: interactive
group_mode: mention
allowed_groups: []
max_group_members: 50
agent_dir: /config/.agent
log_level: info
pool_size: 5
pool_pre_warm: 1
pool_idle_minutes: 5
pool_wait_timeout_seconds: 30
default_model: standard
guest_model: fast
si_default_model: standard
```

### Required settings

#### `bot_token`
Telegram bot token from **@BotFather**.

#### `allowed_chat_ids`
List of Telegram user IDs that are allowed to use the bot immediately. These users become the initial **owners**.

### Authentication and Copilot settings

#### `github_token`
Optional GitHub token. If omitted, you can authenticate Copilot later through its normal auth flow.

#### `copilot_binary`
Path to the Copilot CLI binary, or `auto`.

#### `copilot_config_dir`
Path to the Copilot auth/config directory, or `auto`.

#### `copilot_extra_args`
Additional arguments passed to the Copilot CLI process.

#### `preamble`
Channel-specific system guidance injected at conversation start.

Use this for:

- formatting instructions
- environment hints
- output preferences
- operational reminders

### Runtime behavior

#### `auto_start`
If `true`, start the bot automatically with the add-on.

#### `idle_timeout_minutes`
Legacy top-level idle timeout. Still exposed for compatibility.

#### `model`
Legacy compatibility option from earlier versions. In v7, prefer `default_model`, `guest_model`, and `si_default_model`.

#### `working_directory`
Default working directory for Copilot CLI workers. Default: `/config`.

#### `permission_policy`
Default permission policy. Supported values:

- `interactive`
- `allow_all`

#### `log_level`
Logging verbosity:

- `debug`
- `info`
- `warn`
- `error`

### Group behavior

#### `group_mode`
How the bot reacts in groups:

- `mention` — react when mentioned, replied to, or addressed via command
- `all` — react to every message in the group

#### `allowed_groups`
Optional allow-list of Telegram group IDs.

#### `max_group_members`
Reject or avoid overly large groups.

### Agent files and memory

#### `agent_dir`
Directory containing agent files such as:

- `IDENTITY.md`
- `MEMORY.md`
- `SKILLS.md`
- `TASKS.md`
- `memory/YYYY-MM-DD.md`

For v7 documentation and seeded agent files, use:

```text
/config/.agent
```

If you are upgrading from older installs, you may still see legacy layouts. Keep your WebUI docs editor, runtime config, and operational files aligned to one directory.

### Pool settings (new in 1.0.0)

#### `pool_size`
Number of ACP workers to keep available.

- Range: `1-10`
- Default: `5`

#### `pool_pre_warm`
How many workers to boot eagerly at startup.

- Range: `0-10`
- Default: `1`

#### `pool_idle_minutes`
How long an idle worker may live before being reaped.

- Range: `1-60`
- Default: `5`

#### `pool_wait_timeout_seconds`
How long a request waits in the pool queue before timing out.

- Range: `5-120`
- Default: `30`

#### `default_model`
Model tier for owners and members.

- `fast`
- `standard`
- `reasoning`

Default: `standard`

#### `guest_model`
Model tier for guests.

Default: `fast`

#### `si_default_model`
Model tier used by standing instructions when they wake an agent.

Default: `standard`

## 🔁 Standing Instructions

Standing instructions are still a first-class part of the add-on in v7.

### Storage and lifecycle

- Stored at: `/data/standing_instructions.json`
- Persist across restarts
- Hot-reloaded when the file changes
- Manageable through the WebUI

### Trigger types

- `state_change`
- `cron`
- `timer`

### Action types

- `wake_agent`
- `notify`
- `ha_service`

### Useful control fields

- `enabled`
- `cooldown_seconds`
- `one_shot`
- `expires_at`
- `max_triggers`
- `notes`
- `chain_enable`

### Typical uses

- temperature or battery alerts
- timed reminders
- calendar-like nudges
- wake-the-agent investigation workflows
- direct Home Assistant service calls without waking the agent

### Example

```json
{
  "version": 1,
  "instructions": [
    {
      "description": "Turn off the porch light at midnight",
      "enabled": true,
      "trigger": {
        "type": "cron",
        "expression": "0 0 * * *"
      },
      "action": {
        "type": "ha_service",
        "domain": "light",
        "service": "turn_off",
        "data": {
          "entity_id": "light.porch"
        }
      }
    }
  ]
}
```

## 🗂️ Agent Memory System

The memory system uses a unified SQLite-backed PKM (Personal Knowledge Management) database with three tiers:

### Core Memory (always in context)

Pinned memories are injected into every conversation's first message. They define the agent's identity, knowledge, and behavior. The agent can pin/unpin memories to manage what's always available.

- Created automatically on first use by bootstrapping from legacy .md files
- Agent maintains via `remember(content, {pinned: true})` and `memory_admin({action: "pin"})`
- Capped at ~4000 chars to fit context budget
- Sorted by importance — most critical facts always included

### Working Memory (injected when relevant)

Smart prefetch scans every incoming message for entities (people, places, orgs) and keywords. Matching memories are automatically injected into the prompt.

- Uses compromise.js NER for entity detection (sub-millisecond on ARM)
- No LLM cost — purely algorithmic

### Archival Memory (searched on demand)

All other memories. Searched via `recall(query)` with entity-aware FTS5 search, multi-hop entity linking, and activation-weighted ranking.

- Background extraction from conversations (15-min maintenance cycle)
- RAKE keyword extraction + hypernym expansion for discoverability
- ACT-R activation/decay model for organic ranking

### Legacy files

- `IDENTITY.md` — still loaded as fallback if PKM is unavailable
- `MEMORY.md`, `SKILLS.md`, `TASKS.md` — bootstrapped into pinned PKM notes on first use, no longer loaded directly

## 🖥️ WebUI

The WebUI remains available via Home Assistant Ingress.

### Main areas

#### Dashboard

Operational overview of bot state, scopes, and activity.

#### Chat

A web-based Copilot chat surface separate from Telegram.

#### Instructions

Standing instructions manager.

#### Docs

Edit agent files such as:

- `IDENTITY.md`
- `MEMORY.md`
- `SKILLS.md`
- `TASKS.md`
- daily logs

#### Logs

Live add-on log viewer.

#### Config

Edit add-on configuration through the UI.

## 📎 File attachments

Attachment support is still a **planned/expanding area** in v7.

Current guidance:

- treat the Telegram bot as **text-first**
- do not rely on rich attachment workflows as a documented stable surface yet
- keep text attachments and richer media support marked as planned unless your deployment has explicitly validated them

## 🔧 Troubleshooting

### The bot does not respond

Check, in order:

1. `bot_token` is valid
2. your user ID is in `allowed_chat_ids` or RBAC grants you access
3. add-on logs show successful Telegram polling and Copilot startup

### `/status` shows all workers busy

You are saturating the pool.

Options:

- increase `pool_size`
- shorten heavy tasks
- use `fast` for guests or lighter traffic
- increase `pool_wait_timeout_seconds` if short bursts are normal

### Responses change direction unexpectedly

That is usually **steering**, not a bug. In v7, a new user message while the bot is still processing cancels the previous prompt and redirects the conversation.

### Group and forum behavior seems inconsistent

It is probably scope handling working as designed:

- non-forum groups isolate per user
- forum groups isolate per topic thread

### Standing instructions are not firing

Check:

- the instruction is enabled
- trigger conditions actually match
- `/data/standing_instructions.json` is valid JSON
- HA connectivity is healthy
- WebUI logs show no standing-instruction reconnect issues

### Agent doc edits are not taking effect

Start a new conversation with `/new` after editing `IDENTITY.md`, `SKILLS.md`, or `TASKS.md`.

### WebUI is blank or stale

Try:

- hard refresh
- reopening through Home Assistant Ingress
- restarting the add-on if frontend assets failed to load

### Copilot authentication errors

Complete GitHub Copilot authentication and verify the configured auth directory/binary paths if you overrode them.

### Forum topics are not isolated correctly

Make sure the Telegram chat is actually a **forum-enabled supergroup**. In a normal group, the bot will use per-user group scopes instead of topic scopes.

## 🔗 Links

- Repository: https://github.com/layman-smart-home-people/ha-copilot-telegram-bot
- Add-on slug: `copilot-telegram-bot`
- README: [README.md](./README.md)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Issues: https://github.com/layman-smart-home-people/ha-copilot-telegram-bot/issues

---

This add-on is provided as-is, without warranty of any kind.
