# Changelog

All notable changes to the Copilot Telegram Bot add-on.

## [0.56.0] — 2026-06-07

### Added
- **RBAC engine** (`src/core/rbac.mjs`) — Full role-based access control replacing the flat PairingManager. Features:
  - **Hierarchical roles**: `viewer → user → operator → admin → owner` with capability inheritance
  - **Granular capabilities**: 16 capability types covering entity control (safe/sensitive domain split), automations, dashboards, SI management, user/role management, system admin, dev tools, agent memory, background tasks, and reminders
  - **Per-entity overrides**: Grant or deny specific capabilities per user, with domain wildcards (`light.*`) and exact entity matching
  - **Custom roles**: Create roles with selective capability inheritance from built-in roles
  - **Delegation boundaries**: Roles can only manage users at or below their own level
  - **Invite tokens**: Time-limited pairing codes with pre-assigned roles (default: 15 min TTL)
  - **Tool-to-capability mapping**: Automatic capability checks for 40+ MCP tools, plus domain-aware checks for `ha_call_service`/`ha_bulk_control`
  - **Expiry support**: User access can be time-limited with automatic expiry
  - **Backward-compatible API**: `isPaired()`, `isAdmin()`, `getAdminChatIds()`, `generateCode()` all preserved — drop-in replacement for PairingManager
  - **Migration**: Auto-migrates existing `paired_users.json` → `rbac.json` on first load (admin users → `owner` role)

## [0.55.2] — 2026-06-07

### Fixed
- **`/stop` now force-kills stuck ACP** — Previously `/stop` only sent a graceful cancel RPC. If ACP ignored it (common with long-running agent tasks), there was no escalation. Now `/stop` uses the full force-cancel flow: graceful cancel → 15s grace period → kill ACP process. Queue is preserved across the restart.

## [0.55.1] — 2026-06-07

### Removed
- **Prompt watchdog timeout** — Removed the 10-min (SI) and 30-min (user) auto-cancel watchdog. Prompts now run until completion or manual `/stop`. Heartbeat logging and stall detection remain active for observability.

## [0.54.1] — 2026-06-07

### Fixed
- **Rate limit detection broken** — `#sendDraft` and `#editMessage` used regex `/429|retry/i` to detect Telegram 429 errors, but the client throws `"Rate limited"` which doesn't match. Changed to `err.status === 429` (set reliably by the client). This caused transient rate limits to trigger permanent draft→edit fallback instead of adaptive backoff.
- **`err.retryAfter` ignored** — Edit mode retry delay was regex-parsed from the error message (also broken). Now uses `err.retryAfter` set by the client. Draft mode also respects `retryAfter` as a floor for the adaptive throttle (cap raised to 5s).

## [0.54.0] — 2026-06-07

### Added
- **Auto document migration** — On startup, the bot detects when seed default documents (IDENTITY.md, SKILLS.md) have changed between versions. If changes are found, it automatically injects a migration prompt to the agent, which intelligently merges new content into the user's existing files while preserving all customizations. Hash-based change detection ensures migration only triggers once per update.

## [0.53.1] — 2026-06-07

### Changed
- **Trimmed SKILLS.md default seed** — reduced from ~5500 to ~1100 chars. Removed duplicated SI schema, MCP tool catalog, tg-ux examples, and sub-agent verbose docs. MCP tool schemas are self-documenting; SKILLS.md now contains only behavioral rules and pointers.

## [0.53.0] — 2026-06-07

### Changed
- **Draft mode answer streaming** — In private chats, the draft typing bubble now shows the actual answer text building up with a "▊" cursor instead of a truncated 120-char preview behind "✍️ Writing response...". Text is sent as plain text (no `parse_mode`) to avoid broken HTML from incomplete markdown mid-stream. Long answers use a tail-window at ~3800 chars to stay within Telegram's 4096 limit.
- **Draft-specific render path** — New `#doDraftEdit()` method shows compact one-liner progress during thinking/tool phases ("🔧 Checking lights... ✅ 2 done (5s)") instead of the full expandable timeline used in edit mode. The full timeline still appears in the final collapsed details.
- **Draft turn persistence** — `commitTurn()` now preserves streamed text across turn boundaries in draft mode via `#draftDisplayText`, preventing the draft bubble from going blank when the agent starts a new turn mid-conversation.
- **Draft throttle reduced to 750ms** — Draft updates now fire at 750ms intervals (down from 1500ms), with adaptive backoff to 3000ms on rate limits. Edit mode (groups) retains the existing 1.5s–3s throttle.
- **Draft failure fallback** — After 3 consecutive `sendMessageDraft` failures, the composer automatically switches to edit mode by sending a real placeholder message. This prevents silent failure if the draft API becomes unavailable mid-conversation.

## [0.52.0] — 2026-06-07

### Added
- **`sendMessageDraft` streaming** — In private chats, the bot now uses Telegram's ephemeral draft ("typing bubble") for progress display instead of sending a real placeholder message and editing it. Drafts auto-expire after 30s, so no orphaned "🤔 Thinking..." messages if the bot crashes. Falls back to the existing edit-based approach for groups or if the API isn't available.
- **Pairing code in admin notification** — When a new user requests pairing, the admin now receives the pairing code directly in Telegram instead of being told to check add-on logs. The code is still also logged to stdout.

### Changed
- `/pair` help text updated to reflect that codes are now sent via Telegram.
- `TelegramClient` gains `sendMessageDraft()` convenience method.

## [0.51.4] — 2026-06-07

### Fixed
- **Comprehensive Telegram thread resilience** — Moved thread-not-found recovery from individual callers to the `TelegramClient` API layer (`call()` and `callForm()`). When Telegram returns 400 "message thread not found" (e.g., switching a chat between forum/non-forum mode), the client auto-retries the request without `message_thread_id`. This protects ALL outbound API calls — sends, edits, photos, documents, chat actions — with zero caller changes needed.
- **Global crash guard** — Added `process.on('unhandledRejection')` handler to prevent any unhandled promise rejection from killing the bot process. Errors are logged but the bot stays alive.
- **Simplified composer placeholder** — Reverted the placeholder retry to the original simple form since the client layer now handles thread recovery transparently.

## [0.51.3] — 2026-06-07

### Fixed
- **Crash: "message thread not found" kills process** — When Telegram sends a `message_thread_id` in private chat messages, the bot passed it through to API calls which Telegram then rejected with 400. The unhandled rejection propagated through the send queue and crashed the process. Fixed with 3 layers:
  - `makeRef()` now strips `threadId` for private chats (root cause prevention)
  - `#sendFormatted()` catches "thread not found" errors and retries without `threadId` (resilience for stale group threads too)
  - `#flushMessageBuffer()` and `#relayToolImages()` enqueue calls now have `.catch()` guards (no-crash safety net)
- **Composer placeholder fails silently on bad thread** — Placeholder now retries without `threadId` on "thread not found" instead of giving up, so progress messages still appear.
- **Adapter callback ref missing chatType** — Generic callback query handler now passes `chatType` to `makeRef()`, enabling the private-chat threadId guard.

## [0.51.2] — 2026-06-07

### Fixed
- **Grouped timeline rendering** — Intermediate messages (💬) now render outside blockquotes with consecutive tool steps grouped inside blockquotes, creating proper visual separation during live progress. Previously all items were stuffed into a single blockquote.

## [0.51.1] — 2026-06-07

### Fixed
- **Classic PAT warning sent to Telegram** — When a classic PAT (`ghp_`) is configured, the bot now sends a prominent 🚨 warning to the owner's Telegram chat on startup instead of silently logging to the add-on console. Includes actionable guidance to switch to a fine-grained PAT or device login.

## [0.51.0] — 2026-06-07

### Added
- **Copilot CLI auto-bootstrap** — On first start, the add-on automatically downloads the Copilot CLI binary from GitHub releases if not present. Supports aarch64 and x86_64 architectures with SHA256 checksum verification. Binary is installed to `/data/copilot/bin/copilot` and persists across add-on updates.
- **Standing instructions file seeding** — Creates an empty `standing_instructions.json` on fresh installs so the file watcher doesn't fail with ENOENT.
- **Timeline windowing in final details** — Long timelines (16+ items) in the collapsed details block are now windowed: first 3 + last 10 items with "…N more" separator, preventing Telegram's 4096 char limit from being exceeded.

### Fixed
- **Empty timeline guard in progress message** — When all timeline entries resolve to null (orphaned references), the progress message now falls through to summary counts instead of rendering an empty blockquote.
- **ENOENT error message** — Copilot spawn failures now show actionable guidance ("check internet connectivity", "restart the add-on") instead of the cryptic "spawn ... ENOENT" message.
- **Config directory creation** — The `run` script now creates the copilot config directory before symlinking, preventing broken symlinks on fresh installs.

## [0.50.0] — 2026-06-07

### Added
- **Interleaved progress timeline** — Live progress messages and final collapsed details now show intermediate agent messages and tool steps in chronological order instead of grouping all intermediates before all steps. The display accurately reflects the actual flow: think → tools → think → tools.
- **User notification on SI prompt failure** — When a standing instruction's `wake_agent` action triggers but the agent fails to process it, the user now receives a notification instead of silent failure.

### Fixed
- **`/standing` action type display** — Fixed bug where the `/standing` list showed "undefined" for every instruction's action type because `action` is always normalized to an array.
- **Timeline reset on composer reuse** — `#progressTimeline` is now properly reset in `start()` alongside other state.
- **`popLastIntermediate()` timeline corruption** — Popping an intermediate now removes the corresponding timeline entry to prevent stale index references.

## [0.49.1] — 2026-06-07

### Fixed
- **Multi-turn intermediates not working** — Copilot ACP v1.0.60 does not send `agent_message_start`/`agent_message_end` events, so `commitTurn()` was never called. Turn boundaries are now inferred from the `_toolJustEnded` flag: when text resumes after tool completion, the previous turn's text is committed as an intermediate message.

## [0.49.0] — 2026-06-07

### Added
- **Multi-turn composer** — Agent intermediate messages (reasoning between tool calls) are now shown as inline italic quotes in the progress message instead of being lost. The composer stays alive across all ACP turns and only finalizes when the prompt completes.
- **Adaptive edit throttling** — Edit interval increases from 1.5s to 3s after 30s of prompt runtime, reducing Telegram API pressure during long-running tasks.
- **`commitTurn()` / `popLastIntermediate()`** — New composer methods for multi-turn lifecycle management.
- **Intermediate messages in trailing details** — The collapsible reasoning/steps message now includes intermediate agent messages (💬 N messages).

### Changed
- **`message_end` no longer finalizes** — Finalization is deferred to the `finally` block in `#handlePrompt()`, enabling multi-turn support. Single-turn responses behave identically.
- **Stall detection threshold** — Increased from 120s to 300s to reduce false-positive warnings during extended Opus reasoning.

### Fixed
- **Overflow truncation header extraction** — Simplified to always use first line, preventing intermediate messages from being duplicated in the overflow rendering path.

## [0.48.2] — 2026-06-07

### Fixed
- **`si_create` MCP schema missing `id` field** — Added optional `id` property to the `si_create` tool's JSON schema. The backend already supported custom IDs (since v0.48.1), but the MCP tool definition didn't advertise it, so agents couldn't discover the parameter.

## [0.48.1] — 2026-06-07

### Fixed
- **`evaluate` action validation** — Added `evaluate` to `VALID_ACTION_TYPES` and `#normalizeSingleAction()` in standing instructions. The executor already handled it, but the API validator rejected creation attempts.
- **Timer + failed condition infinite loop** — Timers with conditions that fail are now consumed (`markTriggered`) regardless of condition outcome. Sends a skip notification (⏭️) to the user. Also handles condition evaluation errors. Cron and state-change triggers are unaffected.

### Added
- **Custom SI IDs** — `si_create` now accepts an optional `id` field. If provided, the custom ID is used instead of auto-generated UUID. Collision check prevents duplicates. Enables creating chained SIs in any order.

## [0.48.0] — 2026-06-07

### Added
- **Background queue in `/status`** — Status menu now shows background task queue state (idle/running, queue count) via `getBackgroundStatus` callback.
- **`task(background)` detection** — tool_start event handler detects when agent uses built-in `task(mode: "background")` and logs a warning about lost results.
- **Final implementation report** — Comprehensive HTML report at `/local/background-agents-final-report.html` summarizing all 6 phases.

## [0.47.0] — 2026-06-07

### Added
- **`background_task` MCP tool** — New MCP tool exposed to the primary ACP agent, enabling it to dispatch fire-and-forget tasks to the overflow ACP. The agent calls `background_task(prompt, description)` and gets an immediate response with a task ID; the actual work runs on the background pipeline with results delivered via Telegram when complete. Features:
  - Full tool definition in tg-ux MCP sidecar (`mcp-server.mjs`) with input validation
  - Method-based UDS routing in `interactive-flows.mjs` — UDS handler now dispatches by `req.method` (`ask_user` | `background_task`) instead of hardcoding ask_user
  - Wired to orchestrator's `injectBackgroundPrompt()` via `onBackgroundTask` callback
  - MCP tool-generated `taskId` propagated through to orchestrator for end-to-end tracking
  - Only available on primary ACP (overflow ACP has no tg-ux MCP — prevents recursive spawning)
- Updated agent docs: `background_task` tool usage documented in SKILLS and identity rules

## [0.46.0] — 2026-06-07

### Added
- **Background prompt pipeline** — Dedicated background task queue and processing loop for the overflow ACP. SI `wake_agent` now routes through `injectBackgroundPrompt()` which runs tasks on a separate ACP process, leaving the primary interactive pipeline free for user conversations. Features:
  - Priority-based queue (SI=high, agent=normal), max 5 tasks
  - 5-minute watchdog per task with auto-kill and user notification
  - Fresh ACP session per task for isolation
  - Background-specific preamble (no user interaction, report directly)
  - Falls back to primary queue if overflow is disabled or unavailable
  - Results delivered as single formatted Telegram message on completion

## [0.45.0] — 2026-06-07

### Added
- **ACPManager wiring** — Replaced direct ACPClient instantiation with ACPManager for multi-ACP support. Primary ACP behavior unchanged; overflow ACP infrastructure now fully wired with restricted config (si-tools only MCP, `--allow-tool=mcp(*) --deny-tool=shell`).
- **`stdioMcpServers` ACPClient option** — MCP sidecar config is now configurable per-instance instead of hardcoded, enabling overflow to use si-tools only (no tg-ux).
- **Background config options** — `background_enabled`, `background_model`, `background_idle_minutes` addon config for controlling overflow ACP behavior.
- **Overflow event handler wiring** — ACPManager notifies orchestrator via `onOverflowSpawned` callback to wire event handlers when overflow spawns.

## [0.44.1] — 2026-06-06

### Added
- **`evaluate` SI action type** — New action that evaluates a Jinja2 template via HA REST API, optionally checks a condition, and sends a notification. Zero ACP overhead — no agent tokens consumed. Use `{{ result }}` in condition and message to reference template output. Ideal for simple sensor checks that don't need agent reasoning.

## [0.44.0] — 2026-06-06

### Added
- **Sub-agent usage guidance in agent preamble** — Agent is now instructed to always use `task(mode: "sync")` and never `task(mode: "background")` (results are silently lost due to ACP lifecycle). Documents `background_task` MCP tool as the future alternative for fire-and-forget work. Added to both IDENTITY rules and SKILLS reference.

## [0.43.1] — 2026-06-06

### Added
- **Skills section in WebUI Docs tab** — Skills files (`skills/*.md`) now appear in the Docs sidebar under a "Skills" section with 🔧 icon, viewable and editable alongside agent config and daily logs.

## [0.43.0] — 2026-06-06

### Fixed
- **Security: Path traversal in docs API** — `startsWith(dir)` check was vulnerable to sibling-prefix attacks (e.g. `../copilot-telegram-bot-evil/`). Fixed by appending `"/"` to prefix check. (`webui/server.mjs`)
- **ACP zombie on init failure** — If the `initialize` RPC failed after process spawn, the process was left alive but unusable. Now wrapped in try/catch with `this.stop()` on failure. (`ai/copilot/acp-client.mjs`)
- **Elicitation answer swallows next message** — `scope.pendingElicitation` was not cleared after resolve, causing the next user message to be silently consumed. Fixed by nulling after resolve. (`core/orchestrator.mjs`)
- **Thinking timer never auto-updates** — `#scheduleElapsedUpdate()` was called before `#messageId` was set, so the guard returned immediately and the "Thinking... (Ns)" counter never ticked. Moved call to after message send. (`transport/telegram/response-composer.mjs`)
- **Undo button missing for `deactivate`** — `UNDO_REVERSE_MAP` had `activate→deactivate` but not the reverse. Added `deactivate→activate`. (`core/tool-notifications.mjs`)
- **SI one-shot can fire twice on rapid triggers** — Two rapid state changes could both enter `#gateAndExecute()` concurrently, bypassing one-shot/cooldown guards. Added per-instruction gating lock (`Set`) to prevent concurrent gate evaluations. (`ha/orchestrator.mjs`)
- **"No changelog" popup never shown** — Generic `answerCallbackQuery` was called unconditionally before the "No changelog" `show_alert` handler, silently blocking it. Restructured to let custom answers fire first. (`transport/telegram/adapter.mjs`)

## [0.42.0] — 2026-06-06

### Changed
- **Phase 6 refactor**: Cleaned up commands.mjs — moved to `src/core/commands.mjs`.
  - Defined `CommandHost` JSDoc interface — commands now receive a focused `host` object instead of the raw orchestrator instance. Host exposes only 9 methods/properties commands actually use.
  - Removed unused `currentModel` and `currentMode` from command context (were destructured but never read).
  - Consolidated lifecycle methods (`startCopilot`/`stopCopilot`/`restartCopilot`) onto the host interface.
  - Updated import paths in orchestrator.mjs and adapter.mjs.

## [0.41.0] — 2026-06-06

### Changed
- **Phase 5 refactor (steps 2–5)**: Renamed `src/bridge.mjs` → `src/core/orchestrator.mjs`, class `Bridge` → `Orchestrator`. All import paths updated. bridge.mjs is now deleted — the refactor's symbolic milestone. 🎉
  - Logger module name changed from `bridge` to `orchestrator` for consistency.
  - Local variable names (`bridge`) in index.mjs, commands.mjs, ha/orchestrator.mjs, webui/server.mjs remain unchanged (they hold Orchestrator instances via injection, no import-level coupling).
  - Historical "Extracted from bridge.mjs" comments in extracted modules preserved as documentation.

## [0.40.0] — 2026-06-06

### Changed
- **Phase 5 refactor (steps 1–3)**: Extracted Telegram-specific code from `bridge.mjs` into `transport/telegram/adapter.mjs` (new, 458 lines). Bridge reduced from 2,401 → 2,051 lines (−350).
  - Moved: `#handleCallbackQuery` (callback routing, changelog viewer, status:back, dismiss, slash command dispatch), `#handleMembershipChange` (group join/leave, forum detection, welcome messages), `#handleFileAttachment` (photo/document download, text extraction), `#extractReplyContext` (reply chain context building), `#checkRateLimit` (per-user rate limiting), `#notifyAdminPairingRequest/Pairing` (pairing notifications), static file type constants.
  - Bridge retains thin delegation wrappers to maintain the same internal API for `#processUpdate` (not yet extracted).
  - `buildCommandContext` made public for adapter access.

## [0.39.0] — 2026-06-06

### Added
- **Structured event log** (`src/core/event-log.mjs`) — Append-only JSONL file at `/data/acp-events.jsonl` recording 12 lifecycle events: `bot.started/stopped`, `acp.started/stopped/crashed`, `prompt.started/completed/error/timeout/cancelled`, `session.exhausted`, `acp.stall_detected`. Rotates at 5 MB with 1 backup. Fire-and-forget writes — never blocks the prompt pipeline.
- **Cumulative metrics** (`src/core/metrics.mjs`) — In-memory counters (acp_starts, acp_crashes, prompts_total, prompt_errors, tool_calls_total, stall_warnings, etc.), gauges (prompt_active, queue_depth, queue_depth_max), and prompt duration histogram (last 100, with min/avg/max/p95). Persisted to `/data/acp-metrics.json` every 60s — survives restarts.
- **`GET /api/metrics`** — JSON endpoint exposing all counters, gauges, and duration stats
- **`POST /api/metrics/reset`** — Manual metrics reset (for investigation without restarting)
- **Passive ACP liveness detection** — Enhanced heartbeat checks PID alive (`process.kill(pid, 0)` — no stdio interaction) and monitors `lastMessageAt` + `lastStderrAt` staleness. If both are silent for >120s during an active prompt, sends a one-shot stall warning to both logs and Telegram.
- **Crash post-mortem** — On unexpected ACP exit, captures exit code, signal, ACP uptime, last 5 stderr lines, active prompt scope/duration, and queue state. Sends enriched `💥 ACP crashed` notification with full context.
- **ACP stderr buffer** — `acp-client.mjs` now maintains a 20-line circular stderr buffer + `lastStderrAt` timestamp, exposed via `stderrTail` and `lastStderrAt` getters. Powers crash post-mortem and passive stall detection.

## [0.38.1] — 2026-06-06

### Fixed
- **One-shot SI consumed on condition failure** — `markTriggered()` was called before conditions were evaluated, so a one-shot SI would get disabled even when its conditions failed and no action ran. Now marks triggered only after conditions pass, immediately before action execution. Affects all trigger types (state_change, cron, timer).
- **Rate-limit retry overwrites final answer** — when Telegram returned 429 during a progress edit, the delayed retry could fire after `finalize()` and overwrite the final answer with stale progress HTML. Added edit generation counter; retries are discarded if the composer has been finalized or aborted since scheduling.

## [0.38.0] — 2026-06-06

### Fixed
- **Unhandled async rejection in Telegram update handler** — `#processUpdate()` now wrapped in `.catch()` to prevent unhandled promise rejections from crashing the process
- **Permission handler hangs on error** — `.catch()` now calls `respondPermission(cancel)` so ACP doesn't hang waiting for a response that never comes
- **Elicitation handler hangs on error** — `.catch()` now calls `respondElicitation(cancel)` with proper error handling
- **Empty response auto-recovery** — detects 0.0s responses with no tool calls/text (session context exhaustion), automatically creates a new session and retries the prompt once. Falls back gracefully with user notification if retry also fails
- **Watchdog restart when queue empty** — ACP now auto-restarts after watchdog kill even when no prompts are queued, preventing zombie state where ACP stays dead until next user message
- **`/stop` bypasses question queue cleanup** — now routes through `cancelActivePromptForScope` for proper scope-aware cancellation including clearing pending interactive questions
- **InteractiveFlows wrong ACP instance** — `#elicitSingleField` now receives the correct ACP instance as parameter instead of always using the primary ACP (fixes elicitation from overflow sessions)
- **WebUI auto-init crash loop** — added failure counter (max 3) with backoff to prevent infinite ACP spawn/crash cycles when chat initialization repeatedly fails

## [0.37.0] — 2026-06-06

### Added
- **Prompt watchdog timer** — auto-cancels hung prompts after 10 minutes (SI-triggered) or 30 minutes (user-interactive). When the watchdog fires:
  1. Attempts graceful `session/cancel` RPC
  2. Waits 15s grace period for ACP to respond
  3. Force-kills ACP process if still stuck
  4. Auto-restarts ACP and processes any preserved queue items
  5. Notifies admin about the timeout with diagnostics
- **Prompt heartbeat logging** — logs ACP liveness every 60s during active prompts: elapsed time, time since last ACP message, active tools, pending RPCs, queue depth
- **ACP liveness tracking** — `lastMessageAt`, `lastMessageType`, `pendingCount`, `pid` getters on ACPClient for diagnostics
- **Queue preservation on intentional kills** — when the watchdog or force-cancel kills ACP, queued messages are preserved (not dropped) and reprocessed after restart. Unexpected crashes still drop the queue.
- **Status context enriched** — `/status` now shows prompt elapsed time, ACP last message age/type, queue depth

### Changed
- **`cancelActivePromptForScope`** now accepts `force: true` option to cancel regardless of scope
- **ACP exit handler** distinguishes intentional kills (preserve queue) from crashes (drop queue) via `#intentionalKill` flag
- **Prompt generation counter** prevents stale watchdog force-cancel from killing a subsequent innocent prompt

## [0.36.1] — 2026-06-06

### Fixed
- **`/stop` and `/cancel` now work during SI-triggered prompts** — previously, scope mismatch between `standing:chatId` and `dm:chatId` caused "No active request" even when the agent was busy processing a standing instruction wake_agent
- **`injectSystemPrompt` unhandled promise rejection** — the `#queuePrompt` call was fire-and-forget without a `.catch()`, causing unhandled rejections when SI prompts failed

## [0.36.0] — 2026-06-06

### Added
- **Multi-action support** — `action` field now accepts an array of action objects for sequential or parallel execution
  - New `action_mode` field: `"sequential"` (default) or `"parallel"`
  - New `continue_on_error` field: continue executing remaining actions when one fails (default: false)
  - Single action objects still accepted (backward compatible — auto-wrapped in array)
- **Conditions** — optional `conditions` array evaluated between trigger match and action execution
  - `state` — exact entity state match (e.g. `person.sam` is `home`)
  - `numeric_state` — threshold check with `above`/`below`
  - `time` — time range with `after`/`before` (HH:MM format, supports midnight-crossing ranges)
  - `and`/`or`/`not` — nested combinators for complex logic
  - Top level is implicit AND; fail-closed on evaluation errors
- Updated MCP tool schemas (`si_create`, `si_update`) with new fields and condition schema
- Updated agent docs with multi-action examples and condition reference

### Changed
- `ha_service` actions are now awaited (previously fire-and-forget) to support sequential ordering in multi-action
- `ha_service` success notifications now only sent when `message` is explicitly set (previously sent `✅ description` fallback)
- Blocked `ha_service` domains now throw errors (consistent with HTTP failures for `continue_on_error` behavior)

## [0.35.0] — 2026-06-06

### Changed
- **Phase 4 refactor: Extract interactive flows from bridge.mjs** — three more modules extracted with zero behavior changes:
  - `ai/copilot/permissions.mjs` — `PermissionHandler` class for permission requests and plan approval, plus exported utility functions (`encodeCallbackUserId`, `extractCallbackTargetUserId`, `unwrapPermissionSelection`)
  - `ai/copilot/interactive-flows.mjs` — `InteractiveFlows` class manages elicitation UI, UDS server for MCP sidecar IPC, and question queue (ask_user)
  - `core/tool-notifications.mjs` — `ToolNotifications` class handles HA write tool notifications with undo buttons
- bridge.mjs reduced from 2,874 → 2,059 lines (−815 lines, cumulative −1,237 from original)

## [0.34.0] — 2026-06-06

### Changed
- **Phase 3 refactor: Extract clean cuts from bridge.mjs** — three modules extracted with zero behavior changes:
  - `ai/copilot/prompt-builder.mjs` — `PromptBuilder` class handles preamble injection, agent memory context, sender identity, and pinned instruction sanitization
  - `ai/copilot/lifecycle.mjs` — `CopilotLifecycle` class manages ACP start/stop/restart and device login flow
  - `core/status.mjs` — `StatusMenu` class manages the singleton status menu with auto-refresh
- bridge.mjs reduced from 3,296 → 2,874 lines (−422 lines)

## [0.33.0] — 2026-06-06

### Added
- **HA WebSocket auth timeout** — if `auth_ok` isn't received within 30s of connecting, force close and retry. Fixes zombie connections during HA core restarts where the Supervisor proxy accepts TCP but HA isn't ready.
- **Client-side heartbeat** — pings HA every 60s, force-closes if no pong within 30s. Detects silently dead connections.
- **Manual reconnect** — `/standing reconnect` command, `POST /api/standing/reconnect` endpoint, and `si_reconnect` MCP tool for forcing WS reconnection.
- **`reconnect()` method** on HAEventListener and `reconnectHA()` on orchestrator for programmatic reconnection.

## [0.32.0] — 2026-06-06

### Added
- **Standing Instructions MCP tools** (`si_create`, `si_list`, `si_get`, `si_update`, `si_delete`, `si_toggle`) — new MCP server that wraps the bot's REST API for standing instruction management. Agent now uses validated API calls instead of direct JSON file editing, preventing silent validation failures.

### Fixed
- **Broken MCP server path** — `tg-mcp-server.mjs` was moved to `ai/copilot/mcp-server.mjs` in Phase 2 refactor but the path reference in `acp-client.mjs` was not updated. Fixed to use correct path.

### Changed
- **Agent docs updated** — IDENTITY_DEFAULT and SKILLS_DEFAULT now document `si_*` tools and explicitly prohibit direct file editing of standing instructions.

## [0.31.0] — 2026-06-06

### Changed
- **Phase 2: Modular directory structure** — moved 18 standalone modules from flat `src/` into domain directories:
  - `src/core/` — errors, history, scope-state, scope-manager, sessions, pairing, agent-memory
  - `src/transport/telegram/` — client (was telegram.mjs), formatter, buttons, transport-ref (was transport.mjs), response-composer
  - `src/ai/copilot/` — acp-client (was acp.mjs), acp-manager, mcp-server (was tg-mcp-server.mjs)
  - `src/ha/` — events (was ha-events.mjs), standing-instructions, orchestrator (was standing-instruction-orchestrator.mjs)
- All import paths updated across 14 files. No logic changes — pure structural reorganization.

## [0.30.4] — 2026-06-06

### Changed
- **Slimmed SKILLS_DEFAULT to hybrid tool index** — replaced full 82-tool listing with top ~12 most-used tools + category map + `tool_search_tool_regex` discovery guidance. MCP already injects all tool schemas into context; docs now focus on behavioral nudging rather than redundant cataloging.

## [0.30.3] — 2026-06-06

### Changed
- **Optimized default agent docs for MCP tool discovery** — restructured IDENTITY_DEFAULT and SKILLS_DEFAULT templates. SKILLS.md now includes a categorized MCP tool quick reference (82+ tools), tg-ux-ask_user guide, and condensed standing instructions schema. Agents will naturally prefer ha-mcp tools over raw curl/REST API calls.
- **Reduced default context size** — SKILLS_DEFAULT reduced from ~11KB (standing instructions only) to ~4.5KB while covering all capabilities. Total agent context injection reduced by ~29%.
- **Added tool preference hierarchy** — IDENTITY_DEFAULT now explicitly states "use ha-mcp tools for all HA interactions — curl is a last resort only"

## [0.30.2] — 2026-06-06

### Added
- **Automatic escape hatch on elicitation buttons** — every `ask_user` option list now auto-appends a "✏️ Something else" button. When tapped, the user gets a free-text prompt and can type any answer. Handled entirely within the single tool call — the agent doesn't need to know about the two-step flow.

### Changed
- **Extracted `#doAskUserFreeText`** — refactored the free-text elicitation flow into a reusable method, called by both the direct free-text path and the escape hatch path.

## [0.30.1] — 2026-06-06

### Added
- **Sender identity in agent prompts** — every message now includes `[Sender: name=..., username=@..., userId=..., chatId=...]` so the agent knows who is talking. Enables multi-user awareness (e.g. distinguishing Sam from Jas) and targeted notification routing.
- **Username on regular messages** — `ref.username` was only set for edited messages; now set for all incoming messages.

## [0.30.0] — 2026-06-06

### Added
- **Structured logging system** (`src/logger.mjs`) — zero-dependency, ANSI-colored, levelled logger with module tags. Output format: `HH:MM:SS.mmm LEVEL [module] message`
- **`log_level` config option** — set to `debug`, `info` (default), `warn`, or `error` to control verbosity. Also configurable via `LOG_LEVEL` env var.
- **Prompt completion timing** — new info log shows scope, elapsed time, tool call count, and error count for each completed prompt
- **Queue depth tracking** — debug log on every queue push

### Changed
- **Migrated all 14 source files** from ad-hoc `log` function (DI'd via constructors) to `createLogger('module')` with proper levels:
  - `debug` — internal routing, trace, ACP event details, scope resolution
  - `info` — state transitions, connections, user actions, permissions
  - `warn` — degraded conditions, retries, rate limits, non-fatal errors
  - `error` — failures, crashes, unrecoverable issues
- **Removed `log` parameter** from all constructors — modules import their own logger
- **Privacy improvements** — incoming message and edited message logs no longer include message text (only length); reply chain logs omit quoted text; tool result summaries truncated to 100 chars
- **Reduced noise** — group filter log now shows entity count instead of full JSON dump; permission request log shows tool name instead of full JSON

## [0.29.0] — 2026-06-06

### Changed
- **Phase 0 refactor: in-place bridge.mjs decomposition** — extracted 5 named private methods from monolithic handlers to make code boundaries visible for upcoming modularization:
  - `#handlePermissionRequest` / `#handlePlanApproval` — from 190-line `permission_request` event handler
  - `#handleACPExit` — from 70-line `exit` event handler
  - `#handleElicitationRequest` — from 70-line `elicitation_request` event handler
  - `#handleEditedMessage` — from 95-line `edited_message` branch in `#processUpdate`
  - `#ensureScopeSession` — from 70-line session switching block in `#queuePrompt`
- **Formalized ScopeState** — 4 runtime-mutated properties (`pendingElicitation`, `_toolJustEnded`, `_toolJustEndedThought`, `activeRef`) now declared in constructor with proper defaults and cleaned up in `reset()`
- **Removed dead code** — unused `required` Set in multi-field elicitation path

## [0.28.2] — 2026-06-06

### Fixed
- **WebUI chat always disconnected** — chat ACP was lazily initialized only on message send, but the textarea was disabled when disconnected, creating a deadlock. Now auto-initializes the chat ACP when the SSE stream connects, and allows typing while disconnected.

## [0.28.1] — 2026-06-05

### Fixed
- **WebUI chat tab crash** — `handleChatEvent` was referenced before its `const` declaration (temporal dead zone), causing a silent ReferenceError that prevented the chat tab from rendering. Moved the `useCallback` declaration above the ref assignment.

### Added
- **SKILLS.md loaded into agent context** — AgentMemory now loads SKILLS.md alongside IDENTITY.md, MEMORY.md, and TASKS.md, so the agent natively knows its standing instruction capabilities.
- **Default file seeding** — new instances get auto-generated IDENTITY.md, MEMORY.md, SKILLS.md, and TASKS.md with sensible defaults.
- **ha_service domain allowlist** — restricts direct HA service calls to safe domains (light, switch, fan, cover, etc.). Blocks dangerous domains like homeassistant, shell_command with a Telegram error notification.
- **ha_service request timeout** — 15-second AbortSignal timeout prevents hung fetch calls.
- **`/clear` registered** — added to BotFather command menu.

### Changed
- **DOCS.md** — complete rewrite for v0.28.0 feature set (standing instructions, agent memory, WebUI, all commands, configuration).

## [0.28.0] — 2026-06-05

### Added
- **`ha_service` action type** — standing instructions can now call HA services directly (e.g., toggle lights) without waking the agent. Includes Telegram notification on success/failure. Domain and service names are validated against strict HA identifier patterns to prevent path traversal.
- **`chain_enable` field** — instructions can specify an array of instruction IDs to auto-enable when they fire, enabling event-driven chains (e.g., "turn on" enables the disabled "turn off" instruction).
- **`notes` field** — free-form string for agent context, decisions, or state passing between chained instructions.
- **Instant hot-reload** — `fs.watch` on the instructions file triggers immediate reload instead of waiting for the next cron/timer cycle. Re-establishes the watcher after atomic renames.
- **Reload on every evaluation** — `reloadIfChanged()` now runs on state change events and timer checks, not just cron cycles.

## [0.27.4] — 2026-06-05

### Added
- **Standing instructions hot-reload** — the bot now detects external changes to `standing_instructions.json` (e.g. written by the Copilot agent) and reloads them automatically within 60 seconds, without requiring a restart

## [0.27.3] — 2026-06-05

### Fixed
- **WebUI API calls broken via Ingress** — frontend `api()` used absolute paths (`/api/...`) which, through HA Ingress, hit the HA Core API instead of the add-on's server, causing 404 errors on all API endpoints (`/system`, `/status`, `/docs`, `/config/options`). Changed to relative paths (`./api/...`) matching how SSE connections already worked correctly.

## [0.27.2] — 2026-06-05

### Fixed
- **WebUI startup errors** — API responses with invalid JSON (e.g. from Ingress during startup) are now handled gracefully instead of crashing the parser
- **Retry on initial load** — Dashboard and SystemInfo use `apiWithRetry` to silently retry during the brief window after bot restart when the server may not be fully ready

## [0.27.1] — 2026-06-05

### Added
- **Error Collector** — floating debug panel for frontend error visibility
  - Captures API errors, unhandled JS errors, and promise rejections
  - Floating badge shows error count; click to expand full error list
  - Copy-to-clipboard for easy sharing when reporting issues

## [0.27.0] — 2025-07-17

### Added
- **Copilot Web Chat (Phase 3)** — full chat interface in the Web UI
  - Dedicated ACP process with auto-approve permissions
  - SSE streaming for text chunks, tool calls, and thinking indicators
  - Message bubbles with markdown rendering, tool call cards, copy button
  - New session / stop generation controls
  - Agent memory context injected as preamble

### Fixed
- Stale closure in ChatPanel SSE handler (used ref pattern)
- Race condition in `#ensureChatAcp` — concurrent calls no longer spawn duplicate ACP processes
- Error handling in ACP init — partial failures now clean up properly instead of leaving stuck state

## [0.26.0] — 2026-06-05

### Added
- **Log Viewer** — live-tail logs via Server-Sent Events (SSE) with level filtering (ERROR/WARNING/ACP/STANDING), text search, auto-scroll, and clear
- **Config Editor** — view and edit add-on options with form UI, password redaction, restart button
- **System Info** — host details (board, OS version, kernel) and disk usage with progress bar on dashboard
- **Entity Autocomplete** — search HA entities by ID or friendly name in standing instruction forms

### Changed
- Dashboard now includes System section below module status
- Added Logs and Config tabs to navigation

## [0.25.0] — 2026-06-05

### Added
- **Web UI Dashboard (Phase 1)** — HA Ingress-based dashboard accessible from the sidebar
  - **Status dashboard** — bot uptime, Copilot/HA connection status, module health, scope counts
  - **Standing Instructions manager** — full CRUD: create, edit, delete, enable/disable toggle
  - **Agent Docs editor** — view/edit IDENTITY.md, MEMORY.md, TASKS.md, SKILLS.md, and daily logs
  - Dark theme, responsive, mobile-friendly, zero npm dependencies
  - Auto-refreshing status cards (15s interval)

## [0.24.5] — 2026-06-05

### Fixed
- **`getNextTimer` missing expiry/exhaustion checks** — expired or exhausted timer instructions could occupy the "next timer" slot, blocking valid timers behind them

## [0.24.4] — 2026-06-05

### Fixed
- **Git pre-installed in Docker image** — added `git` to Dockerfile apt packages so the agent can commit/push without manual installation each session

## [0.24.3] — 2026-06-05

### Added
- **Occurrence-based expiry (`max_triggers`)** — instructions can auto-disable after N firings (e.g., "alert up to 5 times"). Combines with `expires_at` for "whichever comes first" semantics.
- **Trigger count tracking (`trigger_count`)** — each instruction now tracks how many times it has fired, displayed in `/standing` list
- Exhausted instructions (reached `max_triggers`) are auto-disabled during routine checks

### Changed
- `/standing` list now shows fire count and max (e.g., `Fired: 3/5`) when applicable

## [0.24.2] — 2026-06-05

### Changed
- **`/standing` list ID as copyable code** — instruction IDs now render as inline `<code>` in Telegram, making them tap-to-copy on mobile
- Standing list output now uses HTML parse mode for proper formatting

## [0.24.1] — 2026-06-05

### Fixed
- **Standing instruction notify crash** — `sendMessage` received object `{ parse_mode: "Markdown" }` instead of string, causing Telegram API 400 error that crashed the bot process
- **Unhandled promise rejections in orchestrator** — all `enqueue()` calls in standing instruction actions now have `.catch()` handlers, preventing bot crashes on send failures
- **Standing `wake_agent` notification when busy** — shows "⏳ Queued" instead of "⏳ Processing..." when the agent is already handling another task
- **`/standing` partial ID matching** — enable/disable/delete commands now match by ID prefix (e.g., first 8 chars) instead of requiring the full UUID
- **`/standing` full IDs in list** — instruction list now shows full UUIDs for easy copy-paste
- **`/standing` notify formatting** — removed Markdown formatting from notify messages to avoid parse failures with special characters in descriptions

### Added
- **`/standing disable all`** — bulk disable all standing instructions
- **`/standing enable all`** — bulk enable all standing instructions
- **`/standing delete all`** — bulk delete all standing instructions

## [0.24.0] — 2026-06-05

### Added
- **Configurable agent directory** — `agent_dir` addon option (default: `/config/copilot-telegram-bot`):
  - Follows HA convention (like `zigbee2mqtt/`, `esphome/`)
  - Supports multi-instance setups with different directories
  - Auto-migrates from legacy `/config/.agent/` on first boot
  - All LLM prompt paths are dynamically templated from config
- **Smart tool step windowing** — progressive message display for long sessions:
  - Shows first 3 + last 12 tool steps with "…and N more" summary
  - 80-character step description cap with word-boundary truncation
  - Budget-aware HTML truncation replaces unsafe `html.slice()` that broke tags
  - Progressive tail reduction (10→8→6→4→3) when message exceeds 4096 chars
  - Last-resort summary shows accurate done/running/failed counts
  - Preserves correct header state (permission/thinking/reasoning) during truncation

### Fixed
- Tool step display no longer causes Telegram parse errors on long sessions
- Step count summary now accurately distinguishes "done" vs "running" vs "failed"

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
