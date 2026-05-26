# Changelog

All notable changes to the Copilot Telegram Bot add-on.

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
