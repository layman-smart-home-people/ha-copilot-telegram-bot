# Changelog

All notable changes to the Copilot Telegram Bot add-on.

## [0.23.0] — 2026-06-05

### Added
- **Standing Instructions Orchestrator** — event-driven agent wake-up system:
  - HA WebSocket event listener subscribes to `state_changed` events
  - Persistent instruction store at `/data/standing_instructions.json`
  - `state_change`, `cron`, and `timer` trigger types
  - `wake_agent` (inject prompt) and `notify` (send message) action types
  - Cooldown enforcement across all trigger types
  - One-shot instructions (auto-disable after first trigger)
  - Numeric threshold triggers (`above`/`below`) for temperature, humidity, power sensors
  - Global pause/resume and timed mute (`/standing pause|resume|mute 2h`)
  - Immediate notification before agent wake-up ("🔔 ... ⏳ Processing...")
  - Separate scope key for standing instruction prompts (no queue merge with user messages)
- **Agent Persistent Memory** — OpenClaw-style identity & memory system:
  - `/config/.agent/IDENTITY.md` — agent personality, responsibilities, rules
  - `/config/.agent/MEMORY.md` — curated long-term memory (agent self-maintained)
  - `/config/.agent/TASKS.md` — active/interrupted/pending task tracking
  - `/config/.agent/SKILLS.md` — schema docs for standing instructions
  - `/config/.agent/memory/YYYY-MM-DD.md` — daily logs (today + yesterday loaded)
  - Injected into preamble on first message of each session
- **`/standing` slash command** — manage standing instructions from Telegram:
  - List all with status, trigger info, last fired time, uptime
  - Enable/disable/delete individual instructions
  - Pause/resume/mute globally
  - Orchestrator status in `/status` menu with inline button
- **`Bridge.injectSystemPrompt()`** — public method to wake agent with system prompts
- **Deploy script** — `/config/scripts/update-copilot-bot.sh` for one-command updates

### Fixed
- Event listener leak on start/stop cycles (bound handler cleanup)
- Cooldown enforcement for cron and timer triggers (was only state_change)
- Markdown syntax in plain-text replies (reply() has no parseMode)
- `formatUptime()` guard against non-numeric input

## [0.21.0] — 2026-05-28

### Added
- **Question queue** — MCP `ask_user` calls are now queued FIFO instead of rejected:
  - Multiple concurrent questions are shown one at a time
  - Queue prefix shown: "❓ (1/3) What color?" when multiple are pending
  - 500ms delay between questions for smooth UX
  - Max 10 queued questions (overflow rejected gracefully)
  - Queue cancelled on /stop, ACP exit, or bot shutdown
- **UDS diagnostic logging** — both bot and MCP server now log UDS connection lifecycle
- **MCP server stderr logging** — `tg-mcp-server.mjs` logs to stderr for visibility in addon logs

### Changed
- `#handleMcpAskUser` refactored into queue + `#doAskUser` (extracted question display logic)
- `#finalizeComposer`, `#flushMessageBuffer`, `#sendFormatted` now accept optional scope/ref params
- `#showToolNotification`, `#relayToolImages` accept optional getter params for multi-ACP prep
- Event handlers in `#wireACPEvents` fully parametrized (scope/ref/switching via getters)
- UDS handler wraps `conn.end()` in try/catch for robustness

### Fixed
- Concurrent `ask_user` calls no longer fail with "Another question is already pending"
- UDS connection errors now logged instead of silently swallowed

## [0.20.0] — 2026-05-27

### Added
- **MCP ask_user tool** — model can now ask interactive questions via Telegram:
  - With options → inline keyboard buttons (❓ prefix, one per row + Cancel)
  - Without options → free-text reply prompt
  - Replaces broken built-in `ask_user` (disabled via `--no-ask-user`)
- **tg-ux MCP server** — minimal stdio MCP sidecar (zero deps, ~140 LOC)
  - Registered via `--additional-mcp-config` at CLI spawn
  - Communicates with bot via Unix domain socket IPC
- **Unified interaction state** — composer shows "Awaiting your input…" for all interactive prompts

### Changed
- `setPermissionPending()` → `setInteractionPending(type)` for generic interaction tracking

### Removed
- Dead `awaitingInput` code (field was never set, only nulled)

## [0.19.0] — 2026-05-28

### Added
- **Plan display** — agent plan entries now show in the composer with ⏳/🔄/✅ status emoji, updated in real-time
- **Plan approval buttons** — when agent finishes planning and asks for approval (`switch_mode`), dynamic option buttons appear (e.g., "🚀 Auto-accept all", "✅ Manual accept", "❌ Stay in architect")
- **Elicitation support** — agent questions presented as Telegram inline buttons:
  - Enum/oneOf → inline keyboard with dynamic labels
  - Boolean → Yes/No buttons
  - Text/number → force_reply with text intercept + Skip button
  - Multi-field forms → sequential prompts
- **No timeout on decisions** — plan approval and elicitation buttons persist until tapped or session ends
- **Mode update handler** — `current_mode_update` notifications update scope mode in real-time
- **Elicitation capability** — declared `elicitation: { form: {} }` in ACP initialize for future compatibility
- `respondElicitation()` method in ACP client for structured responses

## [0.18.0] — 2026-05-27

### Fixed
- **Mode/model changes via RPC** — `/autopilot`, `/plan`, `/fleet`, `/mode`, `/model` now use proper `session/set_config_option` RPC instead of prompt-based workaround. Instant switching, zero token cost.
- **Prefix pollution** — slash commands (`/compact`, `/usage`) no longer get `[Via Telegram]` prepended, which caused timeouts
- **`loadSession` spec compliance** — now sends required `cwd` and `mcpServers` params
- **`/plan off` semantics** — now correctly reverts to agent mode instead of sending `/autopilot off`
- **Help button** — fixed `/plan on` callback to `/plan`

### Added
- **`/clear` command** — alias for `/session new`, familiar to CLI users
- **Instant feedback** — mode/model changes show confirmation immediately (✅ Mode → Plan)
- **`session/set_config_option`** — proper ACP RPC for config changes with prompt fallback
- **`session/set_mode`** — legacy mode RPC as secondary fallback
- **`fullModeUri()` helper** — converts short mode IDs to full ACP URIs required by RPCs

## [0.17.0] — 2026-05-27

### Fixed
- **Stale session crash on restart** — after ACP restart, all scope sessionIds are cleared so commands don't try to load non-existent sessions
- **Session recovery** — `loadSession` failures now fall back to creating a new session instead of aborting with an error
- **All ACP commands work again** — `/plan`, `/autopilot`, `/model`, `/compact`, `/fleet`, `/mode` now survive bot restarts

## [0.16.1] — 2026-05-27

### Fixed
- **Mode URI leak in status** — full ACP mode URI no longer displayed; normalized on scope load from disk
- **Link previews disabled** — all bot messages now suppress Telegram link previews

## [0.16.0] — 2026-05-26

### Fixed
- **`/plan`, `/autopilot`, `/fleet`, `/model`, `/mode` commands** — bypassed broken `session/set_config_option` RPC and route mode/model changes as ACP slash commands through the bridge queue, fixing `-32602 Invalid params` errors
- **Mode ID normalization** — ACP's full URI mode IDs (e.g. `...#agent`) now normalized to short names (`agent`, `plan`, `autopilot`) across all scope tracking and status display
- **Removed dead code** — cleaned up unused `setMode()`/`setModel()` methods from acp.mjs

## [0.15.5] — 2026-05-26

### Fixed
- **Duplicated streamed thinking text** — reasoning/thought chunks now merge by overlap to handle both delta and cumulative chunk formats without repeated phrases

## [0.15.3] — 2026-05-26

### Fixed
- **Missing line breaks in reasoning** — thought chunks between tool calls now separated by newlines (same fix as v0.15.2 but for the reasoning/thinking buffer)

## [0.15.2] — 2026-05-26

### Fixed
- **Missing line breaks in responses** — text chunks after tool calls now separated by newlines, preventing sentences from running together (e.g. "entity.Found it" → "entity.\nFound it")

## [0.15.1] — 2026-05-26

### Fixed
- **Changelog Back button** — now edits message in-place instead of deleting and recreating
- **`/usage` and `/compact`** — route through bridge queue for proper response compositing (was bypassing composer, causing misrouted text chunks)
- **Scope sync on session load** — mode/model now sync after `loadSession()` preventing stale values on scope switch
- **Status auto-refresh** — status message refreshes when Copilot changes mode or model
- **Scope cleanup on exit** — mode/model cleared when Copilot stops, preventing stale status display
- **BotFather registration** — `/fleet` now appears in Telegram autocomplete

## [0.15.0] — 2026-05-26

### Added
- **Direct HA API access** — Copilot can query entities, call services, and manage add-ons without ha-mcp
- **Supervisor `manager` role** — enables add-on management (start/stop/restart), system diagnostics
- **HA API status in /status menu** — shows HA version and connectivity
- **Startup HA API validation** — logs HA version and API access level on boot

### Changed
- `copilot-instructions.md` rewritten with REST API endpoint reference (ha-mcp now optional)
- Default preamble includes HA API access hint for Copilot
- MCP servers shown in /status menu when configured

### Fixed
- Removed custom AppArmor profile that caused startup failure (v0.14.2–0.14.4)
- Reverted to v0.13.5 rootfs structure (removed init-copilot oneshot service)

## [0.14.4] — 2026-05-26

### Fixed
- Removed custom AppArmor profile that was blocking /init execution (v0.13.5 had none)

## [0.14.3] — 2026-05-26

### Fixed
- Force rebuild to pick up rootfs changes (buildx cache was stale)

## [0.14.2] — 2026-05-26

### Fixed
- Reverted to v0.13.5 rootfs structure — removed init-copilot oneshot service that caused startup failure
- Restored telegram-bot/run with config symlink and binary validation
- Restored simple finish script (no container halt on error)
- Removed bundled ha-mcp server from Docker image (external ha-mcp add-on still supported)
- Cleaned up Dockerfile (removed CACHE_BUST workarounds)

## [0.14.1] — 2026-05-26

### Added
- **Changelog viewer**: tap "📋 Changelog" in the status menu to browse version history with pagination
- **`/fleet` command**: enables autopilot and hints Copilot to use parallel multi-agent execution
- **Mode icons**: status menu shows emoji-coded mode indicator (🟢 Autopilot, 📝 Plan, 💬 Interactive)

### Changed
- Mode button in status menu now shows current mode name instead of generic "Mode" label
- Changelog button replaces standalone dismiss row — now paired with dismiss for space efficiency

## [0.14.0] — 2026-05-26

### Added
- **All-in-one bootstrapping**: Copilot CLI is automatically downloaded on first start — no manual installation required
- **Auto-configuration**: MCP config, Copilot settings, and trusted folders are generated automatically
- New `init-copilot` s6 oneshot bootstrap service runs before the bot to ensure everything is ready

### Changed
- Default `copilot_binary` changed from `/share/copilot-tools/copilot` to `auto` (auto-download and manage)
- Default `copilot_config_dir` changed from `/share/copilot-tools/.copilot` to `auto` (auto-manage)
- Simplified startup: `telegram-bot/run` script delegates setup to bootstrap service
- `github_token` is now optional — users can authenticate via Telegram device flow instead
- Prerequisites reduced: only a Telegram account and GitHub account with Copilot access needed

### Backwards Compatible
- Existing users with custom paths in their configuration are unaffected
- The `auto` resolver checks `/share/copilot-tools/` as a fallback before downloading

## [0.13.5] — 2026-05-26

### Changed
- **Answer-first finalize layout**: the placeholder message is now edited into the answer itself, with reasoning and tool steps sent as a collapsible trailing message below
- Combined reasoning + tool steps into a single `<blockquote expandable>` — tap to expand
- Collapsed header shows "🧠 Reasoning · 🔧 N steps"
- No trailing message when there are no reasoning or tools (simple answers stay clean)

## [0.13.4] — 2026-05-26

### Fixed
- **Edit→cancel resubmit**: edited messages now include `triggerMessageId` and `firstName` so re-edits during reprocessing match correctly
- **Cancel-as-error suppressed**: intentional edit cancellations no longer increment error counters or show error messages to the user
- **`/new` command guarded**: `/new` now checks `promptActive` before calling ACP, preventing crashes when Copilot is busy
- **HTML entity safety**: `escapeHtml` is now applied before truncation in thought display, preventing broken entities
- **Steps header accuracy**: finalized steps header shows "(N failed)" when some steps failed instead of always saying "completed"
- **Reaction ordering**: already-processed edit reactions (✏️) are now set before queueing to prevent immediate overwrite by ✅

## [0.13.3] — 2026-05-26

### Added
- **Edit cancels active prompt**: editing a message that's currently being processed cancels the ACP turn and resubmits the corrected text
- Composer shows "✏️ Message edited — reprocessing..." on cancel
- Corrected text pushed to front of queue for immediate processing
- Correction prompt for already-completed messages includes explicit "do not re-execute" instruction

### Changed
- Header + answer combined into a single message when they fit (< 4096 chars)
- Thinking display suppressed for first 3 seconds to avoid flicker on fast responses

## [0.13.2] — 2026-05-26

### Added
- **Collapsible reasoning**: full reasoning displayed in `<blockquote expandable>` on finalize (tap to expand)
- Anti-flicker: live reasoning only shown after 3 seconds of processing

## [0.13.1] — 2026-05-26

### Fixed
- Thinking step display shows only the last meaningful line (max 200 chars) instead of raw multi-line content that ran together

## [0.13.0] — 2026-05-26

### Added
- **Emoji reactions lifecycle**: messages get ⚡ (processing) → ✅ (success) / ⚠️ (errors); queued messages get ⏳ first
- **Thinking tokens streaming**: ACP `agent_thought_chunk` events are now captured and displayed live during reasoning
- **File attachment support**: text files (< 50KB) are read as UTF-8 and injected into the prompt as fenced code blocks
- **Message type handlers**: stickers (emoji extracted), locations (coordinates sent), voice/video/GIF/contact (friendly rejection with suggestions)
- **Edited message support**: edits to queued messages update the queue entry; edits to already-processed messages send a correction prompt
- **Permission timeout loop prevention**: after 2 consecutive permission timeouts within 2 minutes, auto-denies silently and suggests `/allowall`
- Bot no longer self-reacts (👍/👎 on own messages removed)

### Changed
- **Queue overflow**: rejects new messages when queue is full instead of dropping the oldest (punished users who waited longest)
- Unknown ACP session update types are now logged for debugging

## [0.12.7] — 2026-05-26

### Added
- **Owner scope protection**: the first `allowed_chat_id` (server owner) is never evicted from LRU scope cache

## [0.12.6] — 2026-05-26

### Fixed
- **Graceful busy handling**: all ACP-interacting commands (`/usage`, `/model`, `/autopilot`, `/compact`, `/mode`, `/plan`, `/session new`) now check `promptActive` and reply "⏳ Copilot is busy" instead of crashing with "Invalid params"

## [0.12.5] — 2026-05-26

### Added
- **Queue feedback**: users now see "⏳ Queued (#N) — another conversation is in progress" when their message is queued behind another scope

## [0.12.0] — 2025-07-18

### Added
- **Multi-user session isolation**: each user/group/forum topic gets its own independent Copilot session
- **Conversation scopes**: `dm:{userId}`, `group:{chatId}`, `forum:{chatId}:{threadId}` keys for state isolation
- **Group chat support**: bot responds to @mentions, replies-to-bot, and `/command@botname` in groups
- **Group onboarding**: welcome message when bot is added to a group; auto-leave if not in allowed_groups or group too large
- **Per-user permissions**: tool grants are scoped to `userId:toolName` within each scope
- **Per-user rate limiting**: 10 messages/minute per user across all scopes
- **User attribution**: group prompts prefixed with sender's name for context
- **Queue fairness**: per-scope deduplication with follow-up appending; scope affinity for queue drain
- **Scope-aware commands**: `/model`, `/mode`, `/allowall`, `/cancel`, `/status`, `/sessions` all operate per-scope
- **Scope persistence**: dirty-flag + 30s periodic flush to `/data/scopes.json` (SD card friendly)
- **LRU eviction**: 30 DM slots, 20 group/forum slots with least-recently-used eviction
- New config options: `group_mode` (mention/all), `allowed_groups`, `max_group_members`
- New files: `src/scope-state.mjs`, `src/scope-manager.mjs`, `src/config.mjs`

### Security
- Scope-aware `/cancel` and `/stop` — only cancels prompts belonging to the requesting scope
- Admin-only pinned instructions in groups (requires Telegram admin or pairing admin)
- Per-user-per-scope tool grants prevent cross-user permission leakage

### Changed
- Bridge constructor accepts `sessionMgr` and `scopeMgr`
- All ACP event handlers guard against session switching (`#switching` flag)
- Prompt queue uses scope keys for deduplication and affinity

## [0.11.1] — 2025-07-18

### Security
- Shell injection fix: login flow no longer uses `sh -c` with config-supplied binary path
- Callback button scoping: permission and undo buttons restricted to intended recipient in group chats
- Undo prompt injection: domain/service/entity_id validated against strict allowlists
- Pinned instruction framing: reframed as user context instead of `[SYSTEM:]`, injection patterns stripped

### Changed
- README.md comprehensively updated for v0.11.0 features
- Removed duplicate root CHANGELOG.md (HA reads the one next to config.yaml)

## [0.11.0] — 2025-07-18

### Security
- Pinned message handler now requires authentication (was bypassing auth check)
- Pinned instructions capped at 2000 chars per chat, 20 chats max

### Fixed
- Status menu auto-refresh broken by class name typo (`CopilotBridge` → `Bridge`)
- Double history push on legacy message path
- Unhandled promise rejection in queue drain
- `#awaitingInput` promise hanging forever on ACP crash
- Timer leak in ResponseComposer when placeholder message fails
- Hardcoded Asia/Singapore timezone in `/new` command — now uses system TZ
- Stale `/restart` and `/login` references in error messages → `/session new`
- `#preambleSent` was global — now per-chat so forum topics each get their preamble

### Added
- Prompt queue capped at 10 (drops oldest on overflow; changed to reject-new in v0.13.0)
- Safety timeout (60s) for status refresh pause flag
- Timeout/abort signal on Telegram file uploads (`callForm`)

### Removed
- Dead code: `#tmpDir`, unused imports (`basename`, `writeFileSync`, `mkdirSync`, `existsSync`)

## [0.10.7] — 2025-07-18

### Added
- Graceful shutdown notification — warns users if an operation was interrupted
- Status menu updated to "Stopped" on add-on shutdown

## [0.10.6] — 2025-07-18

### Fixed
- Status menu now reliably refreshes on restart/stop (explicit refresh, not fire-and-forget)
- Eliminated duplicate "Restarting" messages (status menu + broadcast)
- Added `#statusRefreshPaused` to prevent "Stopped" flash during restart

## [0.10.5] — 2025-07-18

### Fixed
- Status menu shows transitional state ("⏳ Restarting..." / "⏳ Stopping...") immediately on button click

## [0.10.4] — 2025-07-18

### Added
- Status menu lifecycle: singleton pattern, auto-refresh on state changes, 5-min TTL expiry
- Centralized `#buildStatusContent()` in bridge (eliminates duplication)
- "🔄 Refresh" button on status menu while Copilot is starting

## [0.10.3] — 2025-07-18

### Added
- "✕ Dismiss" button on `/status` and `/help` menus
- Generic dismiss callback handler (deletes the message)

## [0.10.2] — 2025-07-18

### Changed
- Preamble simplified from 4 lines to 1 sentence (saves tokens)
- Copilot instructions now encourage markdown formatting instead of plain text
- Added Telegram Formatting Guide to copilot-instructions.md

## [0.10.1] — 2025-07-18

### Added
- `/stop` command (alias for `/cancel`)
- `/retry` command — resends last user message
- Error messages now suggest `/retry` for recoverable errors

### Fixed
- Suppressed startup noise ("🟢 Copilot Telegram Bot online" messages)

## [0.10.0] — 2025-07-18

### Fixed
- Multi-chunk reply tracking: overflow chunks now have proper alias history entries
- Double history push in fallback path

## [0.9.9] — 2025-07-18

### Added
- Text preview during streaming (first 120 chars in blockquote)
- Permission awaiting state ("🔐 Awaiting permission...")
- Elapsed timer ("(Xs)") updating every 5s in composer

### Fixed
- Permission pending state not cleared on exception (try-finally)

## [0.9.8] — 2025-07-18

### Added
- Markdown list rendering (unordered with nesting depth, ordered with ▸)
- Code-fence-aware message chunking
- `stripHtmlKeepStructure()` for smarter HTML fallback

## [0.9.7] — 2025-07-18

### Added
- Silent notifications on thinking/tool messages
- Retry cap on tool reactions

### Removed
- Dead code from bubble system
