# Changelog

All notable changes to the Copilot Telegram Bot add-on.

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
- Prompt queue capped at 10 (drops oldest on overflow)
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
