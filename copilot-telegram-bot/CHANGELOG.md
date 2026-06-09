# Changelog

All notable changes to the Copilot Telegram Bot add-on.

## [2.3.2] — 2026-06-09

### Fixed — Dream Mode + MCP Server
- **`log.error` crash in MCP server** — `log` was a plain function, calling `log.error()` threw `TypeError` and broke the catch block. Any tool error caused a silent double-fault (⚠️ in streamer). Added `.error/.warn/.info/.debug` methods.
- **Debug logging for tool failures** — `err()` helper now emits `log.debug` with the error reason; catch block includes stack trace.

### Added — `/dream` Command
- **`/dream` command** — runs dream mode directly (no LLM conversation, no streamer). Bypasses thinking bubbles and tool progress noise entirely. Runs user dream then agent dream sequentially, edits a single status message with compact results.
- **🌙 Dream button** in `/memory` menu — triggers the same silent dream flow.
- **Agent memory curation** — `/dream` now curates the agent's own memories (identity, skills, etc.) alongside user memories.

## [2.3.1] — 2026-06-09

### Fixed — Onboarding + Schema Migration
- **v2→v3 schema migration** — existing databases now get `pinned` column, `dream_synthesize` setting, and `household_invites` table. Fixed v1→v2 migration stamping version as "3" and permanently skipping v3.
- **Unauthorized users get a reply** — was silent drop, now sends "🔒 You're not authorized" (rate-limited: once per user per 10 min to prevent spam).
- **PKM auto-enabled for owner** — owner's first message auto-enables PKM. No more chicken-and-egg where `remember()` fails because PKM isn't enabled.
- **Default IDENTITY.md** — created on startup if missing, using bot's display name from `getMe()`.
- **`allowed_groups` enforced** — groups not in the allowlist are now blocked. Empty list = all groups allowed (backward compatible).

## [2.3.0] — 2026-06-09

### Changed — Core Memory + Dream Mode
- **Pinned memories replace .md files** — IDENTITY.md, MEMORY.md, SKILLS.md, copilot-instructions.md bootstrapped into pinned PKM notes on first use. Pinned notes always injected into agent context (~4K char budget).
- **Memory as identity** — system prompt frames pinned memories as the agent's self: "Your pinned memories define who you are. Maintaining your memory maintains your identity."
- **`remember(content, {pinned: true})`** — agent can pin memories to core. `memory_admin({action: "pin/unpin"})` for existing notes.
- **Bot self-awareness** — `getMe()` result injected into first-message context: @username, display name, bot ID, group/inline capabilities.
- **`/memory` menu updated** — removed "View Key Facts" (MEMORY.md). Shows core memory char count.

### Added — Dream Mode (9 phases)
- **`memory_admin({action: "dream"})`** — comprehensive memory maintenance:
  1. **Harvest**: close all open sessions, extract memories via LLM
  2. **Curate**: LLM reviews all memories, suggests pin/unpin/archive
  3. **Contradictions**: find conflicting facts, archive the outdated one
  4. **Merge**: consolidate 3+ similar memories into single richer notes
  5. **Synthesize+Infer** (optional `dream_synthesize` setting): pattern recognition + logical deduction. Confidence-tiered: axiomatic inferences stored directly, uncertain ones tagged `needs_confirmation` for agent to verify organically
  6. **Staleness**: flag memories >6 months old that may be outdated (addresses, jobs, preferences)
  7. **Entity relationships**: deduce and store relationships between entities (wife_of, works_at, etc.)
  8. **Proactive suggestions**: surface upcoming dates, incomplete goals, actionable patterns
  9. **Compact**: decay activations, purge old sessions, clean audit logs

## [2.2.4] — 2026-06-09

### Fixed
- **Draft blocks typing on finalize** — draft is now cleared BEFORE sending the real message (was: send draft with full HTML → send real message → clear draft, leaving input blocked). Uses empty string to clear instead of null (null was a no-op). Clear is now awaited, not fire-and-forget.

## [2.2.3] — 2026-06-09

### Changed
- **Multi-bubble streaming** — each thinking round (reasoning + tools) sends as a separate Telegram message. No more single growing bubble. Each bubble has its own collapsed tool summary.
- **Current phase only in draft** — draft/edit shows only the active phase, not accumulated history. Previous phases already committed as separate messages.
- **Flush on new round** — when a new tool call starts after response text, the completed phase is automatically flushed as a committed message before the new round begins.

## [2.2.2] — 2026-06-09

### Changed — Streaming UX Overhaul
- **Phase-based rendering** — streamer now tracks thinking/tool/response phases like VSCode Copilot. During tool use: shows compact tool status. After tools complete: streams clean response text. Reasoning text no longer pollutes the draft.
- **Collapsed thinking blocks** — completed tool phases render as expandable `<blockquote>` during streaming and in final message. Tap to expand.
- **No more "poof"** — draft only contains current status or response text, not a growing wall of reasoning. Finalized message matches what user was reading.
- **Multi-message splitting** — long responses (>4096 chars) split at paragraph boundaries into follow-up messages instead of truncating. Tool summary appended to last page.
- **Multi-phase support** — agent can think → tools → write → think → tools → write. Each cycle gets its own collapsed block.

## [2.2.1] — 2026-06-09

### Fixed
- **Stale tool references** — updated streamer status labels, RBAC permission groups, router MCP docs, `/memory` menu hint, and MEMORY.md seed to reference `remember`/`recall`/`memory_admin` (old names kept for backward compat).
- **package.json version** — synced to match config.yaml.

## [2.2.0] — 2026-06-09

### Changed — PKM Simplification
- **Tools collapsed from 5 to 3** — `remember(content)`, `recall(query)`, `memory_admin(action)`. Agent no longer needs to choose between pkm_memory, pkm_search, pkm_navigate, pkm_collection, pkm_manage.
- **Auto-enrichment on write** — server auto-generates title, type, tags, search keywords, topics, entities, importance, and durability from plain text content. Agent just calls `remember("Alice prefers window seats")` — no 8-parameter form to fill.
- **Entity-aware recall** — `recall` scans query for entities (people, places, orgs), finds linked notes via entity_notes table, merges with FTS5 results. Multi-hop: "Alice's preferences" finds both Alice entity and all notes linked to her.
- **Smart prefetch** — every message scanned for entities/keywords (sub-millisecond), matching memories auto-injected into prompt. Replaces old narrow recall-pattern-only prefetch.
- **Leaner system hint** — removed verbose keyword strategy instructions. Now just: "Use remember to save. Use recall to search. Proactively save preferences."
- **Maintenance timer** — background pipeline interval increased from 5 to 15 minutes. ~3x fewer wake-ups, zero functional impact (windows need 30 min idle before closing anyway).

### Added
- **compromise.js NER** — rule-based named entity recognition (people, places, organizations). Runs on ARM without ML models, ~250KB. Dramatically better entity extraction than regex proper-noun detection.
- **RAKE keyword extraction** — Rapid Automatic Keyword Extraction algorithm built in. Scores candidate phrases by word co-occurrence, producing multi-word key phrases ("blood pressure medication" not just "blood").
- **Hypernym expansion** — auto-generated keywords include category chains (grouper→fish→seafood→protein→dining). Enables future recall by broader terms.
- **Memory awareness hints** — when entities found in message match stored memories, agent gets hint: "Alice: 3 memories" before even calling recall.
- **Backward-compatible tool routing** — old tool names (pkm_memory, pkm_search, etc.) still work via automatic forwarding.
- **Household invites** — joining a household now requires an invite token created by owner/admin. Prevents unauthorized self-join by household UUID.

### Security — Cross-User Memory Isolation Audit
Three independent Opus 4.6 agents audited all PKM data paths. Five issues found and fixed:
- **Recall entity-linked notes** — `getNote()` now checks `user_id` ownership before including entity-linked results.
- **Topic filter query** — added `user_id` filter to topic note queries in search engine (was returning cross-user note IDs into filter set).
- **Entity-notes query** — added JOIN to notes table with `user_id` filter (was unscoped on the linking table).
- **Note link creation** — now validates both source and target notes belong to calling user before creating links.
- **`getNotesForEntity()`** — `userId` parameter now mandatory, throws if missing.

## [2.1.0] — 2026-06-09

### Fixed
- **Deterministic thread routing** — closed 6 threadId drop paths across `background_task`, `telegram_call`, `dispatch_to_agent`, `tryResolveText`, Telegram client retry, and menu close. Responses no longer silently fall back to the main thread.
- **Thread handling consolidated** — extracted `withThread()` utility replacing 16 ad-hoc `if (threadId)` patterns across 7 files. Thread context now injected into agent prompts.
- **Elicitation blocks typing** — draft mode (sendMessageDraft) now clears before elicitation buttons are sent, unblocking the user's Telegram input field.
- **Steering delay reduced** — `acp.cancel()` timeout cut from 10s to 3s. Added 150ms elicitation grace period so user replies during elicitation resolve instantly instead of triggering slow cancel→re-prompt.
- **Dispatcher tries too hard** — rewrote triage instructions: default action is DISPATCH. Only handles single-sentence, zero-tool-call responses directly.
- **Pool reconfigure MCP loss** — shared `#buildMcpServers()` used in both spawn and reconfigure paths (DRY fix from rebase).

### Added
- **Forum topic concurrency** — scope key now `forum:{chatId}:{threadId}:{userId}`, enabling concurrent requests from different users in the same topic.
- **Cross-chat messaging** — new `send_to_user` MCP tool resolves targets by display name, @username, or numeric chat ID via RBAC. Enables "send this report to User B".
- **WebUI Chats tab** — new 📨 Chats tab lists all reachable users (from RBAC) and groups (with title, member count, admin list from Telegram API).
- **Agent operational guidelines** — embedded security and file-sharing rules (public `/config/www/` handling, dynamic URL resolution, `send_file` best practices) injected into every first-message context.

## [2.0.0] — 2026-06-09

### Added — PKM Memory Palace (Live)
- **Conversation tracking** — user messages automatically tracked in PKM conversation windows, enabling buffer search on recent conversations without LLM extraction
- **Dynamic system hint** — agent receives memory count, proactive storage instructions, and keyword strategy guidance on every first message. Agent now knows to store preferences/facts immediately ("Noted ✓")
- **Memory prefetch** — when user asks recall-type questions ("what fish did I love?"), relevant memories are pre-loaded into the prompt from FTS5 search
- **Activation tracking** — every search result triggers `trackAccess()`, powering the ACT-R activation/decay model. Frequently recalled memories rank higher organically
- **Housekeeping timer** — window closing, data purging, and activation decay run every 5 minutes unconditionally (no LLM required)
- **Keyword strategy** — system hint coaches agent to include 10+ search keywords with synonyms, hypernyms (grouper→fish→seafood), and context terms

### How it works now
1. User: "I loved the grouper at Jumbo Seafood" → agent calls `pkm_memory(write)` with rich keywords → stored in FTS5
2. Later: "what fish did I love?" → prefetch finds the memory → agent synthesizes answer
3. Activation model ensures frequently recalled facts stay prominent, rarely accessed ones decay
4. Buffer search catches facts from the current conversation even before explicit storage

## [1.9.0] — 2026-06-09

### Added — PKM Memory System
- **PKM system wired end-to-end** — PkmManager instantiated, SQLite DB with FTS5 created at `/data/pkm.db`, all 5 MCP memory tools (`pkm_memory`, `pkm_search`, `pkm_navigate`, `pkm_collection`, `pkm_manage`) now operational.
- **Per-user memory isolation** — scope key from pool claim maps to userId for memory partitioning. Each user gets their own memories, topics, and entities.
- **REST API live** — `/api/pkm/*` routes connected to PkmManager.handleApi() instead of returning 404.

### Changed — /memory Command
- **Shows PKM stats** — total memories, topics, entities from live database instead of raw `.md` file sizes.
- **🔍 Search Memory button** — prompts user to ask a recall question.
- **Agent config secondary** — Personality and Key Facts shown as compact line below PKM stats.
- **Removed SKILLS.md/TASKS.md from menu** — not user-relevant.

## [1.8.0] — 2026-06-09

### Added
- **SI template buttons** — `/standing` menu shows 4 one-tap templates when no instructions exist: 🚪 Door Alert, 🌡 Temp Warning, ☀️ Morning Briefing, 🔋 Battery Alert. Tapping routes a pre-written prompt to the agent for automatic setup.

## [1.7.0] — 2026-06-09

### Added — RBAC
- **RBAC API fully wired** — 17 REST endpoints now connected to RBACManager. MCP `access-control` tools (rbac_list_roles, rbac_set_user_role, rbac_create_invite, etc.) return real data instead of 404 errors. Roles, users, invites, overrides, and audit log all operational.

### Fixed — Agent Context
- **Version awareness** — agent now knows its own version and can answer "what version are you?"
- **Supervisor API access** — preamble now includes `$SUPERVISOR_TOKEN` curl instructions so agent can reach HA API directly when MCP tools are unavailable.
- **HA connection status** — injected into agent context (connected/disconnected + version).

### Fixed — WebUI Chat
- **Chat SSE streaming** — WebUI chat panel now receives real-time events (text_chunk, thought, tool_start, tool_end, done, error). Previously only sent initial status, making the chat panel non-functional.
- **Removed duplicate listener code** — cleaned up brittle streamer-patching approach in favor of clean EventEmitter-based conversation listeners.

### Changed — UX
- **Layman-friendly /status** — removed pool instance IDs, scope keys, and developer metrics. Shows model, active chats, capacity, HA connection, SI status, and avg response time in plain language.
- **Layman-friendly /memory** — files renamed to human labels (🤖 Personality, 📝 Key Facts, 🔧 Capabilities, 📋 Current Tasks). Added description text. "Reset" button says "keep personality" instead of "keep identity".

## [1.6.0] — 2026-06-09

### Added — Standing Instructions
- **`template_notify` action type** — zero-token Jinja2 template notifications. HA's template engine formats the message, result sent directly to Telegram. No agent wake, no token cost. Use for "send me the temperature every morning" without burning tokens.
- **Global rate limiting** — max 20 `wake_agent` fires per hour (prevents runaway token usage).
- **Per-SI rate cap** — max 10 fires per hour per instruction. Exceeding triggers circuit breaker auto-disable with user notification.

### Changed — Token Optimization
- **~60% reduction in first-message context** — agent context now loads only IDENTITY.md + MEMORY.md (SKILLS.md/TASKS.md available on disk). Daily logs removed from injection — agent uses `pkm_search` and `session-history` tools on demand. MAX_FILE_SIZE halved to 4000 chars.
- **Lean SI conversation profile** — `skipContext` option on prompt enricher allows SI prompts to skip memory/preamble injection.

### Fixed — Streaming
- **Draft ID type** — changed from string to integer per Telegram Bot API spec. Prevents silent draft failures.
- **Initial draft failure handling** — if `sendMessageDraft` fails on first call (API unavailable), falls back to edit mode instead of leaving user with no visual feedback.
- **Multi-turn display** — `onTurnEnd()` inserts paragraph breaks between agent turns so multi-turn responses don't merge into one blob.

## [1.5.0] — 2026-06-09

### Added — UX & Polish
- **`/start` command** — registered as Telegram deep-link entry point. Shows welcome + help menu.
- **Richer `/help`** — explains capabilities: photo analysis, file attachments, steering, settings, standing instructions, and memory.
- **Model descriptions in `/settings`** — "⚡ Fast — quick answers", "🔵 Standard — balanced", "🧠 Reasoning — deep analysis". Warns that model change resets conversation.
- **Standing instructions empty state** — shows example prompt ("alert me when the front door opens") instead of just "No instructions configured."
- **Trigger type icons** in `/standing` list — 📡 state_change, ⏰ cron, ⏲ timer.
- **Markdown table support** — pipe tables converted to aligned `<pre>` blocks instead of garbled text.

### Fixed — Formatting & Streaming
- **Italic regex no longer misfires on math** — `3 * 4 * 5` no longer becomes `3 <i> 4 </i> 5`. Added CommonMark space-awareness.
- **Ordered lists preserve numbering** — `1.`, `2.`, `3.` instead of all becoming `▸`.
- **HTML-safe message chunking** — `chunkMessage` now converts markdown→HTML first, then chunks at 4096 chars. Previously sized on raw markdown, causing Telegram MESSAGE_TOO_LONG rejections.
- **HTML truncation closes unclosed tags** — streamer `#truncate` now tracks and closes open `<b>`, `<pre>`, `<blockquote>` etc. instead of producing malformed HTML.

### Fixed — Security
- **Config API token redaction** — HA Supervisor schema is an object `{key: "password"}`, not an array. Previous code iterated nothing — `bot_token` and `github_token` were returned in cleartext.
- **Request body size limit** — `#readBody()` now caps at 1MB to prevent DoS via memory exhaustion.
- **SSE heartbeat** — log stream sends 30s heartbeat to keep connections alive behind HA Ingress/nginx reverse proxies.
- **`send_file` path jail** — restricted to `/config/`, `/share/`, `/media/`, `/tmp/`. Agents can no longer read arbitrary files.
- **`telegram_call` allowlist** — blocklist (5 methods) replaced with explicit allowlist (16 safe methods). Blocks `banChatMember`, `deleteChatPhoto`, etc.
- **UDS buffer limit** — 1MB cap on sidecar connections prevents OOM.
- **MCP timeout alignment** — `ask_user` timeout aligned to 5.5min (was 30min) to match UDS server.
- **Error path sanitization** — `send_file` errors return `err.code` instead of full filesystem paths.

### Fixed — Standing Instructions
- **SI prompt timeout** — 5-minute max per SI agent prompt. Previously a hung agent blocked that SI scope key forever.
- **SI debounce key collision** — uses instruction ID instead of DJB2 hash, preventing hash collisions from silently dropping SIs.
- **SI conversation cleanup** — destroy errors now logged instead of silently swallowed.

### Fixed — UX
- **User-friendly error messages** — pool exhaustion and generic errors no longer leak internal error messages.
- **Menu expiry message** — expired menus show "⏰ Menu expired" instead of silently stripping buttons.

### Fixed — Startup
- **Bot token retry on boot** — `getMe()` now retries 3 times with 5s delay, re-reading config on each attempt. Previously, if `options.json` wasn't ready at boot, the bot exited immediately with "Invalid bot token".
- **`/start` registered with BotFather** — `setMyCommands` now includes `/start` and orders commands logically.

## [1.4.12] — 2026-06-09

### Fixed
- **Pool: zombie claimed instance detection** — Health check now detects claimed instances with dead processes and cleans them up. Previously only idle instances were health-checked, allowing dead claimed instances to consume pool capacity indefinitely.
- **Pool: health check triggers pre-warm** — Health check failures now trigger replacement spawn (like crash handler), preventing pool from silently shrinking below pre-warm threshold.
- **Pool: wait queue drain after spawn** — After crash/health-check replacement spawn, the wait queue is drained again so queued waiters get served by the new instance instead of timing out.
- **Conversation: receive serialization** — Two near-simultaneous messages for an idle conversation could both enter `#prompt()` concurrently, causing interleaved ACP prompts and garbled streamer output. Now serialized through a promise queue.
- **Conversation: crash recovery releases old instance** — `replaceInstance()` now releases the old dead pool instance before acquiring a new one, preventing pool capacity leak.
- **Standing Instructions: cron minute alignment** — Cron evaluation now aligns to clock minute boundaries using `setTimeout` instead of drifting `setInterval`. Prevents missed cron triggers (e.g., `0 6 * * *` could miss the 06:00 minute).

## [1.4.11] — 2026-06-09

### Fixed
- **Pool reconfigure: MCP servers restored** — When pool reconfigured an idle instance to a different model tier, internal sidecar MCP servers (telegram, standing-instructions, access-control, memory, session-history) were lost, leaving only external servers (ha-mcp). Now properly merges internal + external servers, matching the initial spawn path.
- **dispatch_to_agent model fallthrough** — Dispatcher tool no longer hardcodes `model: "standard"` as default. When the agent doesn't specify a model, the API dispatch falls through to the user's `defaultModel` from `/settings`.
- **background_task model/profile** — Background tasks now inherit the user's `defaultModel` and `mcpProfile: "owner"` instead of empty defaults.
- **Pre-warm uses defaultModel** — Pool pre-warm now spawns instances with the user's preferred model instead of the dispatcher model, reducing needless reconfigures.
- **Router: direct model routing** — Removed dispatcher model indirection; user messages now route directly to the user's preferred model tier.

## [1.4.10] — 2026-06-09

### Fixed
- **dispatch_to_agent**: Now respects user's `default_model` setting from `/settings` menu. Previously hardcoded to "standard", ignoring the user's preference.

## [1.4.9] — 2026-06-09

### Changed — ha-mcp discovery replaces bootstrap

- **Removed pip-based ha-mcp bootstrap** — the bot no longer installs ha-mcp via `pip install` into a Python venv at startup.
- **Added sibling add-on discovery** — ha-mcp is now auto-discovered via the Supervisor API by finding the running add-on, reading its `secret_path` and network port, and constructing the SSE URL.
- Pool agents automatically get the discovered ha-mcp endpoint — no manual MCP config needed.
- Removed unused `node:child_process` and filesystem write imports from config module.

## [1.4.8] — 2026-06-09

### Added — send_file MCP tool

- **New `send_file` tool** — agents can now send files directly to users via Telegram as document or photo attachments instead of saving to /config/www/ and sharing URLs.
- Supports auto-detection: images (jpg, png, gif, webp) sent as photos, everything else as documents. Override with `type` parameter.
- Thread-aware: files route to the correct chat/thread via scope key.
- Validates file size (50MB Telegram limit) and handles missing files gracefully.
- Wired through MCP server → UDS → Telegram client's existing `callForm()` multipart upload support.

## [1.4.4] — 2026-06-08

### Fixed — Thread routing for all MCP tools

- **Scope key via file** — Pool writes `.scope-key` to instance's COPILOT_HOME on claim/release. MCP sidecar reads it dynamically on each tool call. Fixes ask_user, notify_user, background_task all going to main chat instead of the active thread.
- **notify_user thread support** — Now routes to the correct thread (was hardcoded to owner chatId without threadId).
- **tryResolveText thread-aware** — Free-text ask_user answers now match by threadId, preventing cross-thread answer leaks.
- **Auto-rename DM topics** — Topic rename after first prompt now fires for all threaded conversations (was forum-only). Uses existing icon + title heuristic.

## [1.4.3] — 2026-06-08

### Changed

- Removed startup "Bot online" notification. Shutdown notification kept for active sessions only.

## [1.4.2] — 2026-06-08

### Fixed — ask_user 180s delay

- **Boot order fix** — UDS server now starts BEFORE pool boot, so the socket is guaranteed to exist when MCP sidecars need it. Previously pool booted first → sidecars spawned → UDS socket didn't exist yet.
- **UDS server `start()` now async** — returns a Promise that resolves when the server is actually listening (was fire-and-forget).
- **MCP sidecar connection retry** — `callBot()` retries up to 4 times with exponential backoff (500ms → 4s) on ENOENT/ECONNREFUSED, instead of failing immediately.
- **Lazy ConversationManager** — UDS server accepts `setConversationManager()` since it now starts before ConversationManager exists.

## [1.4.1] — 2026-06-08

### Changed — MCP server renames (agent-facing)

- `tg-ux` → **`telegram`** — ask_user, notify_user, background_task, telegram_call
- `si-tools` → **`standing-instructions`** — si_create/list/get/update/delete/toggle
- `rbac-tools` → **`access-control`** — user roles & permissions
- `pkm-tools` → **`memory`** — pkm_memory, pkm_search, pkm_navigate, pkm_collection, pkm_manage
- `session-history` — unchanged (already clear)
- Updated: acp-pool.mjs, acp-client.mjs, all MCP server scripts, mcp.json, SKILLS.md, copilot-instructions.md

### Removed

- **self_test tool** — v6 testing infrastructure, no longer functional. Removed from telegram MCP server.

## [1.4.0] — 2026-06-08

### Removed — v6 architecture (BREAKING)

- **Deleted 24 v6-only files** — orchestrator.mjs, agent-memory.mjs, acp-manager.mjs, lifecycle.mjs, prompt-builder.mjs, interactive-flows.mjs, scope-manager.mjs, scope-state.mjs, sessions.mjs, commands.mjs, status.mjs, tool-notifications.mjs, history.mjs, event-log.mjs, metrics.mjs, errors.mjs, pairing.mjs, index-v6.mjs, adapter.mjs, buttons.mjs, transport-ref.mjs, test-registry.mjs, tests-phase-a.mjs, tests-phase-b.mjs.
- No more dual maintenance — all context injection, daily log loading, memory management is in v7 only (prompt-enricher.mjs).

### Added

- **UDS server for v7** (`src/gateway/uds-server.mjs`) — Replacement for InteractiveFlows UDS server. Handles all MCP sidecar IPC: `ask_user`, `notify_user`, `background_task`, `telegram_call`. Integrates with Router for callback/text interception. Same UDS socket protocol — sidecar scripts unchanged.

### Changed

- **index.mjs** — Now starts UDS server and wires it to Router. Added to shutdown sequence.
- **router.mjs** — Added `setUdsServer()`, UDS callback routing (`uds:` prefix), text interception for pending ask_user questions, cancel-all on `/stop`.

## [1.3.14] — 2026-06-08

### Added

- **Memory reset command** — `/memory` menu now has "🔄 Reset (keep identity)" button. Resets MEMORY.md, SKILLS.md, TASKS.md to defaults and clears daily logs. IDENTITY.md is preserved. Includes confirmation step.

### Changed

- **File/PKM boundary clarified** — MEMORY.md is now for seed facts only (key entities, versions). Long-term knowledge goes to PKM via `pkm_memory`. Agent instructions updated accordingly.
- **Default templates compressed** — MEMORY_DEFAULT and SKILLS_DEFAULT in agent-memory.mjs now match the lean format. New instances start with ~1KB defaults instead of ~4KB.

## [1.3.13] — 2026-06-08

### Changed

- **Topic-based daily logs** — New format: `memory/YYYY-MM-DD/<topic>.md` (e.g. `bot-dev.md`, `home-automation.md`). Each topic gets its own file under the date directory. Both v6 and v7 loaders support the new format with fallback to legacy flat `YYYY-MM-DD.md` files. Budget (4KB/day) shared across all topic files.

## [1.3.12] — 2026-06-08

### Fixed

- **Daily log loader bug (v7)** — `PromptEnricher` was reading ALL `.md` files in `memory/`, sorting alphabetically, and picking the last 2. Plan files (`pkm-plan.md`, `rbac-plan.md`) sorted after dates → loaded instead of actual daily logs. Now uses explicit date construction (matching v6 behavior).
- **Context token reduction** — Deduplicated IDENTITY.md + MEMORY.md (people, preferences, rules were tripled). Compressed SKILLS.md and copilot-instructions.md. Total injected context: 6.6KB (was 17.3KB) — **62% reduction**.

### Changed

- **Daily log labels** — Now show relative context: "today (Sun 2026-06-08)" instead of raw "2026-06-08"
- **Agent memory instructions** — Tell agents to use descriptive topic tags in daily logs (e.g. `#bot-dev`, `#home-automation`, `#debug`)
- **Plan files relocated** — Moved `pkm-plan.md`, `rbac-plan.md`, `background-agents-plan.md` from `memory/` to `plans/` to prevent accidental loading

## [1.3.11] — 2026-06-08

### Added

- **`telegram_call` MCP tool** — Agents can now call any Telegram Bot API method directly. Enables forum topic management (rename, create, close, set icons), message operations, and chat administration. Security: blocks sensitive methods (webhook, logout). Documented in `copilot-instructions.md` with examples.

## [1.3.10] — 2026-06-08

### Fixed

- **Agents missing HA context** — `.github/copilot-instructions.md` (HA tool preferences, environment, dashboard rules, safety) was only loaded by the CLI binary natively. If the CLI didn't auto-detect the git repo, agents got tools but no operational instructions. Both v6 `PromptBuilder` and v7 `PromptEnricher` now explicitly load and inject `copilot-instructions.md` on the first message — guaranteed regardless of CLI behavior.

## [1.3.9] — 2026-06-08

### Added

- **Session resumption** — Conversations now persist their ACP session ID in an append-only ledger (`/data/session-ledger.jsonl`). After idle reap or bot restart, the next message resumes the previous session via `loadSession()` instead of starting fresh. Agent retains full conversation history — no more blank slate after 30 min of inactivity.
- **`/new` clears session** — The `/new` command now explicitly clears the ledger entry so the next conversation starts with a genuinely fresh session.
- **Graceful shutdown persistence** — All active conversation session IDs are saved to the ledger on bot shutdown.

### Fixed

- **Concurrent message race condition** — Two messages arriving for the same scope during conversation creation could leak a pool instance. `route()` now serializes creation per scope using an in-flight promise guard.

## [1.3.8] — 2026-06-08

### Added

- **Cross-session history** — New `session-history` MCP server with 3 tools: `session_search` (keyword search across checkpoints/turns), `session_list_recent` (overview of recent work), `session_get_details` (full session deep-dive). Uses `node:sqlite` to read the shared session store directly. Agents can now check what other agents did — cloned repos, code changes, decisions.
- **Shared session store** — Pool instances now symlink `session-store.db` and `session-state/` to the primary COPILOT_HOME instead of creating isolated copies. All agents share the same session history. Session data persists across pool instance lifecycles (no more lost in `/tmp/`).

## [1.3.7] — 2026-06-08

### Improved

- **Smart forum topic titles** — Topic names now truncated to 28 chars (word-boundary) instead of 64, with greeting filler stripped ("Hey can you..." → meaningful text). Topic icons auto-set from 13 keyword categories (🏠 home, 💻 code, 🤖 automation, ⛅ weather, etc.) using Telegram's `icon_custom_emoji_id`. Plurals now match correctly.

## [1.3.6] — 2026-06-08

### Fixed

- **Status close button not working** — `MenuManager.close()` called `editMessageText` without `reply_markup`, so Telegram preserved the inline keyboard after the text changed. Now explicitly sends `reply_markup: { inline_keyboard: [] }` to remove buttons on close.
- **DM topic menu callbacks broken** — `parseMenuCallback()` dropped the threadId from `dm:userId:threadId` scoped callbacks, causing menu lookups to fail in DM topic threads. Now preserves the full DM topic scope.
- **Hardcoded "Ezra v7" branding removed** — All references replaced with dynamic `config.version` from config.yaml. Instance names belong to deployments, not the project.

### Added

- **Local MCP registration** — Bot sidecar servers (tg-ux, si-tools, rbac-tools, pkm-tools) can now be added to `$COPILOT_HOME/mcp.json` for standalone CLI sessions via the merge script in the repo README.

## [1.3.5] — 2026-06-08

### Fixed

- **Internal MCP tools missing when external servers configured** — Pool passed external MCP servers (e.g. ha-mcp) as `stdioMcpServers`, which caused `ACPClient` to skip internal sidecar servers (tg-ux, si-tools, rbac-tools, pkm-tools). Now merges internal defaults with external profile servers so all tools are available. Guest profile still gets no MCP tools.

## [1.3.4] — 2026-06-08

### Fixed

- **Menus in threads appearing outside the thread** — `MenuManager` tracked menus by `chatId:menuId` without including `threadId`, causing menus from different threads to collide. Running the same command in another thread would edit the old thread's message instead of sending a new one. Now includes threadId in the menu key.
- **Close calls lose thread context** — All `menus.close()` calls in the router now pass `threadId` for correct menu lookup in threaded chats.

### Added

- **Status dismiss button** — `/status` now has a "❌ Close" button (moved Settings to second row for better layout).

## [1.3.3] — 2026-06-08

### Fixed

- **Agent context not loading** — `PromptEnricher` hardcoded agent dir to `/config/.agent` instead of using `config.agentDir` (default: `/config/copilot-telegram-bot`). This caused the agent to start with zero identity/memory context, losing knowledge of SI tools, HA tools, and personality. Now resolves: config option → default → legacy fallback.
- **Daily logs missing from agent context** — `PromptEnricher` only loaded the 4 main files (IDENTITY/MEMORY/SKILLS/TASKS). Now also loads recent daily logs and self-maintenance instructions, matching the old `agent-memory.mjs` behavior.

## [1.3.2] — 2026-06-08

### Fixed

- **WebUI logs empty** — v7 `index.mjs` never hooked `console.log` into `webui.pushLog()`. The log buffer and SSE stream were never fed. Ported the `console.log` intercept from `index-v6.mjs`.

## [1.3.1] — 2026-06-08

### Fixed

- **Streamer progress stuck on "Thinking..."** — `ResponseStreamer` had a double-dereference bug (`result?.result?.message_id` instead of `result?.message_id`) in 6 locations. Since `client.call()` already returns `json.result`, the messageId was always `null`, so no progress edits ever fired. The placeholder just sat there forever. Fixed all 6 instances.

## [1.3.0] — 2026-06-08

### Added

- **DM Topic Core** — Native topic threads in private chats. When enabled (`dm_topics_enabled: true`), bot creates operator-curated topics (🏠 Home Control, 🔍 Research, 🚨 Alerts, 📋 Briefings) and routes each to an isolated conversation scope (`dm:{userId}:{threadId}`).
- **TopicManager** — New `topic-manager.mjs` manages topic lifecycle: creates on startup, persists to `/data/dm-topics.json`, resolves names↔threadIds, prevents auto-rename on operator topics.
- **Root lobby handler** — When topics are enabled, non-command messages in the DM root get redirected to topics with guidance. Commands (/help, /status, etc.) still work in the lobby.
- **SI thread routing** — Standing instruction results auto-route to matching DM topics (e.g., alerts → 🚨 Alerts, daily briefings → 📋 Briefings). Falls back to Briefings topic if no match.
- **Streaming transport config** — New `streaming_transport` option: `auto` (default, draft for DMs, edit for groups/topics), `draft` (force drafts), `edit` (always editMessageText), `off` (final-only, no progress). Per-response fallback on draft failure.

### Changed

- **makeRef() simplified** — No longer strips `threadId` for private chats. Callers that don't want threads pass null. Auto-recovery in client.mjs handles stale thread IDs.
- **Scope resolution** — Both `ScopeManager.resolveKey()` and `Router.#resolveScopeKey()` now produce `dm:{userId}:{threadId}` scopes for topic-scoped private chats. Callback parsing updated to handle the new 3-part DM scope keys.
- **ScopeManager.deleteByUser()** — Now deletes all DM scopes for a user including topic-scoped ones.

## [1.2.0] — 2026-06-08

### Fixed

- **MCP tools not loading (Bug #1)** — Pool passed empty `{}` as MCP servers config, which overrode the defaults in ACPClient. Result: agents had zero MCP sidecar tools (no si-tools, tg-ux, rbac-tools, pkm-tools). Fixed by checking for empty object before passing to ACPClient.
- **Tool names not displayed (Bug #2)** — ACP emits `toolName` property but streamer destructured `name`. Tool progress showed "undefined" or generic labels. Fixed to resolve `toolName || name`.
- **Tool end status ignored (Bug #3)** — ACP emits `status: "failed"` but streamer only checked `error` property. Failed tools showed as successful. Fixed to check both `error` and `status === "failed"`.
- **Forum thread support** — Elicitation buttons, file rejections, and error messages now respect `threadId` for forum topic chats.
- **Draft mode thread guard** — Draft streaming disabled for forum threads (Telegram drafts don't support `message_thread_id`).

### Added

- **Dispatcher architecture** — Pre-warm agent uses fast model (Haiku) as a triage/dispatcher. Simple tasks handled directly; complex tasks (research, code changes, reports) delegated to full-capability agent via `dispatch_to_agent` MCP tool. Dispatched agent uses standard (Sonnet) or reasoning (Opus) model and sends response directly to user.
- **`dispatch_to_agent` tool** — New MCP tool for agent-initiated task delegation. Creates a separate conversation with a higher-tier model. Max 3 concurrent dispatches to prevent pool exhaustion.
- **Progress query interception** — When the agent is busy and user asks "what's happening?" or similar, shows tool progress instead of cancelling the current operation.
- **Auto-rename forum topics** — First user message in a forum topic automatically renames the topic with a meaningful title.
- **Comprehensive tool labels** — Added friendly display names for 15+ tools (SI, PKM, tg-ux, dispatch) in the streaming progress UI.
- **`dispatcherModel` config** — New config option to control which model the dispatcher uses (default: "fast").

### Changed

- **Enricher shared** — PromptEnricher created in main and shared between Router and WebUI for consistent enrichment of dispatched prompts.
- **Adaptive elapsed timer** — Streamer periodically re-renders to keep elapsed timer accurate, with adaptive intervals (3s → 15s).

## [1.1.0] — 2026-06-08

### Added

- **Standing Instruction Bridge** — SI wake_agent now routes through the ACP Pool via ConversationManager
- **Group Mention Filter** — Bot only responds when @mentioned, replied-to, or addressed via command in groups
- **File Attachments** — Text documents embedded in prompts, photos downloaded for ACP, unsupported media gracefully rejected
- **Inline Keyboard Framework** — Scope-aware menus with edit-in-place and 5-minute auto-expiry
- **Full Command UX** — All 7 commands now have proper inline keyboards:
  - `/help` — quick action grid with buttons
  - `/status` — pool/conversation/metrics with refresh + action buttons
  - `/settings` — model tier picker (fast/standard/reasoning)
  - `/standing` — SI list with pause/resume controls
  - `/memory` — agent file viewer with content display
- **WebUI v7 Adaptation** — Dashboard shows pool instances, conversations, and metrics
- **Graceful Shutdown** — Active conversations notified on restart

### Fixed (from critique)

- Path traversal protection on memory file viewer
- WebUI chat API no longer accepts user-supplied model/mcpProfile
- Photo temp files cleaned up after 10 minutes
- SI conversations destroyed after completion (prevents memory leak)

### Changed

- WebUI reduced to 6 tabs (removed Users/RBAC — deferred)
- WebUI backend API returns v7 pool/conversation data structure

## [1.0.0] — 2026-06-08

### 🚀 Major — Ezra v7: Multi-Session ACP Pool Architecture

Complete rewrite of the bot's core. Replaces the single-instance orchestrator with an N-instance pool that supports concurrent conversations, model routing, and mid-conversation steering.

### Added

- **ACP Pool** (`src/pool/`) — Configurable pool of Copilot CLI instances (1–10)
  - 6-step acquire algorithm: sticky → matching idle → spawn → reconfigure → evict → wait queue
  - Model tiers: fast (Haiku 4.5), standard (Sonnet 4.5), reasoning (Opus 4.6)
  - MCP profiles: owner (full tools) vs guest (restricted)
  - Isolated COPILOT_HOME per instance with separate auth tokens
  - Health checks, idle reaping, crash supervision with auto-replace
- **Conversation layer** (`src/conversation/`) — State machine per user session
  - States: idle → prompting → idle (with eliciting and dead)
  - Steering: send new message mid-prompt → cancels old, starts new
  - Crash recovery: instance dies → acquire new → auto-retry (2× limit)
  - ResponseStreamer: 4-layer progressive rendering (content + code + expandable details + buttons)
- **Gateway** (`src/gateway/`) — Clean routing layer
  - Router: Telegram update parsing, permission gate, command dispatch
  - Permissions: 3-role gate (owner/member/guest) from config + RBAC
  - PromptEnricher: injects agent memory, sender context, pinned instructions
  - Scope keys: `dm:{userId}`, `group:{chatId}:{userId}`, `forum:{chatId}:{threadId}`
- **7 clean commands**: /stop, /new, /help, /status, /settings, /standing, /memory
- **Config options**: pool_size, pool_pre_warm, pool_idle_minutes, pool_wait_timeout_seconds, default_model, guest_model, si_default_model

### Security (from 3-agent Opus critique)

- Callback button auth: verify clicking user owns the conversation
- Pinned message injection: require permission before storing as context
- MCP profile preservation through crash recovery (no privilege escalation)

### Fixed (15 findings from critique)

- Race condition: concurrent spawns no longer exceed maxSize
- Sticky check: won't return dead instances
- Wait queue: exact model+profile match only (no silent downgrades)
- Reconfigure failure: proper cleanup instead of corrupt state
- HTML truncation: safe cut point (no mid-tag/entity breaks)
- Elicitation on dead instance: graceful failure
- Render timer leak: cleared on streamer restart
- Listener detach: works even if old ACP is dead
- Router: proper stop() with listener cleanup
- Pinned map: LRU eviction at 100 entries

### Changed

- Entry point is now v7 architecture (`src/index.mjs`)
- Old v6 preserved as `src/index-v6.mjs` for rollback

## [0.75.0] — 2026-06-08

### Added — Ezra v6 Phase B: Embedded SDK Spike (ER-1)

- **SDK spike files** — Two proof-of-concept implementations:
  - `spike-vercel.mjs` — Vercel AI SDK v6 (generateText + streamText + MCP client structural test)
  - `spike-anthropic.mjs` — Anthropic SDK direct (tool_use loop + streaming)
- **Decision matrix** — `decision.mjs` with full comparison, recommendation (Vercel AI SDK v6), risks, migration strategy, and Phase C implications
- **ER-1 self-test** — `tests-phase-b.mjs` validates spike files exist and contain required patterns
- **Recommendation: Vercel AI SDK v6** — multi-model requirement (MM-1) is the deciding factor

### Critique findings documented (0 CRITICAL code fixes, design risks noted)
- CRITICAL (design): Token cost shift from subscription to per-token (~$50-75/mo est.)
- CRITICAL (design): MCP server lifecycle management — bot must spawn/manage servers
- HIGH (design): In-process blast radius — agent crash = bot crash
- HIGH (design): Conversation history management needed from scratch
- All tracked as Phase C blockers in decision.mjs

## [0.74.0] — 2026-06-08

### Added — Ezra v6 Phase A-ST: Self-Test Infrastructure (ST-1, ST-2, ST-5)

- **`self_test` MCP tool (ST-1)** — Agents can call `self_test({id})` for one requirement, `self_test({phase})` for a phase, or `self_test({all: true})` for full regression. Returns pass/fail/skip with details.
- **Test registry (ST-2)** — Central registry with per-requirement test functions. 8 Phase A tests registered (UX-1, UX-2, SI-1, SI-2, BG-3, ST-1, ST-2, ST-5). Results persisted to `/config/www/ezra-test-results.json`. Concurrent run mutex, 30s per-test timeout.
- **Instrumentation hooks (ST-5)** — Resettable counters for LLM calls (+ tokens), Telegram API calls, HA service calls, HA template evaluations, and event bus events. Singleton at `src/testing/instrumentation.mjs`. Hooked into TelegramClient.call(), HA orchestrator service/template paths, core orchestrator prompt path, and EventLog.emit().
- **Test file per phase** — `src/testing/tests-phase-a.mjs` pattern for scalable test organization.

### Critique fixes applied
- UX-1 test returns `skip` (not `pass`) — cosmetic-only finding with no code change
- Context-null guard — tests skip gracefully if called before bot fully initializes
- Concurrent run mutex — rejects overlapping self_test runs
- 30s test timeout — prevents hanging tests from blocking the run
- Event bus instrumentation — added to EventLog.emit() (was missing from ST-5 spec)
- Consistent return shape — unknown test IDs include phase/title fields
- Schema precedence documented — `all > phase > id`

## [0.73.0] — 2026-06-08

### Added — Ezra v6 Phase A3: Task Group Aggregation (BG-3)

- **Grouped background tasks** — `background_task` MCP tool now accepts `group_id` + `group_size` for multi-task aggregation. Tasks with the same group_id are tracked together.
- **Automatic aggregation** — When all tasks in a group complete, results are synthesized: primary ACP receives an aggregation prompt with all task outputs and produces a unified report.
- **Error handling in groups** — Errors count toward group completion (no immediate notification for grouped errors; they appear in the aggregated report).
- **Stale group timeout** — Groups that don't complete within 10 minutes trigger partial aggregation with available results.
- **Fallback paths** — Tasks that get rejected (queue full) or fall back to primary still count toward group completion with appropriate status markers.
- **Status visibility** — `backgroundStatus` getter now includes active group tracking (groupId, completed/total, age).
- **Silent + grouped** — Silent tasks still record results for group aggregation (output isn't delivered individually but counts toward the group).

## [0.72.0] — 2026-06-08

### Added — Ezra v6 Phase A2: Silent SI + notify_user

- **Silent mode for wake_agent (SI-1)** — `silent: true` on wake_agent actions suppresses ALL auto-delivery: no "🔔 Processing..." notification, no result delivery, no typing indicators. Silent tasks only run on overflow ACP (never fall back to primary). Errors still deliver (by design — errors are actionable).
- **`notify_user` MCP tool (SI-2)** — New fire-and-forget tool for autonomous agents to send one-way Telegram notifications. Available on overflow via tg-ux MCP server. Returns immediately after queuing message.
- **Autonomous preamble** — Silent tasks get a dedicated preamble instructing them to work silently, use `notify_user` for alerts, and prohibiting `ask_user`/`background_task`.
- **Overflow MCP expansion** — Overflow ACP now has tg-ux (for notify_user), si-tools, and pkm-tools (for memory access). RBAC tools remain excluded.
- **`silent` field in SI schema** — Exposed in si-mcp-server.mjs ACTION_SCHEMA for agent-created SIs.
- **Status visibility** — `backgroundStatus` getter now exposes `silent` flag per task.

## [0.71.1] — 2026-06-08

### Fixed — Ezra v6 Phase A1: Elicitation Disambiguation + Draft Assessment
- **Elicitation disambiguation (UX-2)** — When ask_user/elicitation is pending, messages that look like new topics (questions, commands, 4+ word sentences starting with action verbs) now cancel the elicitation and are processed as new prompts instead of being swallowed as answers. Short replies (1-3 words), numeric answers, and enum/choice matches still resolve as answers.
- **Bot add-on** — `orchestrator.mjs`: added `isLikelyNewTopic()` heuristic before consuming messages as elicitation answers; `interactive-flows.mjs`: stores question text in `pendingElicitation` for future disambiguation improvements
- **CLI extension** — `extension.mjs`: added matching `isLikelyNewTopic()` function; stores `choices` and `question` in `awaitingInput` for disambiguation
- **Draft blocking assessment (UX-1)** — Confirmed `sendMessageDraft` does NOT block user input. The API creates an ephemeral typing bubble that auto-disappears after 30s. User can always type and send messages. The "blocking" concern is cosmetic only on some clients. No code change needed.

## [0.71.0] — 2026-06-08

### Changed — PKM v2 Phase 6: Integration + Polish + Final Review
- **MCP pkm_search tool** — added `queries`, `entity`, `expand_context` params to schema + handler
- **Expanded context rendering** — MCP search response now shows "Related (expanded context)" section when present
- **SKILLS.md updated** — v2 tool docs: 5 consolidated tools, topic tree, activation model, collections, context expansion
- **agent-memory.mjs SKILLS_DEFAULT** — updated seed template to match v2 tool documentation
- **Code review** — syntax verified across all 6 PKM files, security check on route guards

## [0.70.0] — 2026-06-08

### Changed — PKM v2 Phase 5: Search Upgrade
- **Activation-weighted ranking** — replaced recency-based scoring with `|bm25| × activation × confidence`
- **Multi-query support** — `queries` array (1–5) runs each, merges + deduplicates results
- **Topic filtering** — `topic` param filters FTS5 results by primary_topic_id or note_topics entries; resolves names via fuzzy match
- **Entity filtering** — `entity` param filters results to notes linked to matching entities
- **Context expansion** — new `expandContext()` method finds neighbors of top-3 results via shared entities/topics/links; opt-in via `expand_context: true`
- **Search route updated** — passes `queries`, `topic`, `entity`, `expand_context` to search engine; returns `{ results, expanded }`
- **Removed route-level topic post-filtering** — topic filtering now handled inside search engine for consistency

## [0.69.0] — 2026-06-08

### Changed — PKM v2 Phase 4: MCP Tool Consolidation + REST API
- **14 tools → 5 mega-tools**: `pkm_memory` (write/update/delete/get/link), `pkm_navigate` (map/browse/context/timeline), `pkm_search` (with entity + scope support), `pkm_collection` (create/add/query/update/remove/list), `pkm_manage` (stats/settings/topic_create/topic_move/topic_merge/maintain)
- **Agent scope unification** — `scope: "agent"` parameter replaces 4 separate `pkm_agent_*` tools
- **REST API refactor** — `handleApi` refactored from if/else chain to route table (Map + prefix routes)
- **New REST endpoints** — `/api/pkm/navigate/*`, `/api/pkm/collection/*`, `/api/pkm/topics/*`, `/api/pkm/link`, `/api/pkm/maintain`
- **Enhanced memory map renderer** — topic tree with bridges + collections + uncategorized count
- **Updated system/agent hints** — reference new v2 tool names and action syntax
- **Rollback safety** — old v1 tool definitions kept as comment block in MCP server
- **MCP server version** bumped to 2.0.0

## [0.68.0] — 2026-06-08

### Added — PKM v2 Phase 3: Collections + Navigation + Enhanced Map
- **Collection CRUD** — `createCollection`, `addCollectionItem`, `queryCollection` (JSON field filter), `updateCollectionItem`, `removeCollectionItem`, `deleteCollection`
- **Topic browsing** — `browseTopicNotes` with sort by activation/date/title, optional secondary topic inclusion
- **Context expansion** — `getNeighbors` returns related notes via shared entities + topics + explicit links (UNION query, max 10)
- **Timeline** — `getTimeline` groups notes by week/month/year with type breakdown
- **Cross-topic bridges** — `getCrossTopicBridges` finds top 3 topic pairs with ≥ 2 shared notes
- **Enhanced memory map** — `getMemoryMap` replaced with topic-tree version: topic hierarchy, collections summary, bridges, progressive detail
- **Map caching** — 5-min TTL in `pkm_cache` table, auto-invalidated on note/topic/collection mutations

## [0.67.0] — 2026-06-08

### Added — PKM v2 Phase 2: Note-Topic Assignment + Activation + Entity Dedup
- **Note-topic assignment** — `assignNoteToTopic`, `removeNoteFromTopic`, `getNoteTopics` with primary/secondary support
- **Activation model** — ACT-R simplified: `ln(access_count+1) - decay_rate × days + importance × 0.5` with durability-based decay rates
- **Access tracking** — `trackAccess` increments count + recomputes activation; `decayAllActivations` for batch maintenance
- **Auto-topic assignment** — Keyword classifier in extractor assigns notes to People/Home/Life topics (max 2 per note)
- **Entity dedup** — 3-step matching: exact name → alias → substring (e.g. "Dan" matches "Daniel"), auto-enriches aliases
- **Topic backfill** — Existing notes assigned to topics during v2 migration based on content/entities/tags
- **createNote topics** — Optional `topics` array parameter resolves names and assigns primary + secondary
- **Activation decay** — Runs in maintenance timer for all enabled users

## [0.66.0] — 2026-06-08

### Added — PKM v2 Phase 1: Schema Migration + Topic Tree Foundation
- **Schema v2 migration** — 4 new tables (`topics`, `note_topics`, `collections`, `pkm_cache`) + 7 new columns on `notes`/`note_links` + 3 new indexes
- **Topic tree** — hierarchical topics with max depth 3, icons, descriptions, sort order
- **Topic CRUD** — `createTopic`, `getTopics`, `getTopic`, `updateTopic`, `deleteTopic`
- **Topic operations** — `moveTopic` (reparent with cycle/depth checks), `mergeTopics` (combine with note reassignment)
- **Fuzzy name matching** — `resolveTopicName` with case-insensitive exact match → Levenshtein ≤ 2 fuzzy fallback
- **Default topic seeding** — People 👥, Home 🏠, Life 🌱 auto-created for existing enabled users on migration
- **Migration safety** — idempotent (IF NOT EXISTS + try/catch on ALTER), transactional, with rollback on failure

## [0.65.2] — 2026-06-08

### Added — Memory Map (`pkm_map`)
- **`pkm_map`** MCP tool — ASCII directory-tree overview of a user's memory structure
- Shows: types, top tags, entities (people/places), timeline, sources, durability, household
- Per-user isolation — each user sees only their own map
- Agent uses this to orient before blind-searching a user's memory
- `GET /api/pkm/map` REST endpoint
- System hint updated to recommend `pkm_map` for orientation

## [0.65.1] — 2026-06-08

### Added — Agent memory management tools
- **`pkm_agent_update`** MCP tool — Agent can now update/archive its own notes (was missing, causing "Access denied" errors)
- **`pkm_agent_delete`** MCP tool — Agent can securely delete its own notes
- REST API endpoints: `PUT /api/pkm/agent/notes/:id`, `DELETE /api/pkm/agent/notes/:id`

### Changed — More proactive memory hints
- User hint now encourages proactive memory writing, not just on explicit ask
- Agent hint now mentions all 4 tools (search/write/update/delete) and encourages active memory maintenance

## [0.65.0] — 2026-06-08

### Fixed — PKM Phase 8: Final Review + Security Polish
- **Security fix**: `updateNote()` and `secureDelete()` now verify household membership before allowing modification of household-scoped notes (was allowing any authenticated user)
- **Security fix**: `leaveHousehold()` prevents the last owner from leaving (avoids orphaned households)
- **Data fix**: `exportUserData()` now includes entity_notes linking data in export

### Added
- **Seeded default docs** updated with full PKM tool documentation — new installations get PKM skills out of the box
- **Doc migration** — existing installations will auto-merge PKM docs into IDENTITY.md and SKILLS.md on next startup
- **User SKILLS.md** updated with comprehensive PKM tool reference
- **Final build report** at `/config/www/pkm-final-report.html`

## [0.64.0] — 2026-06-08

### Added — PKM Phase 7: Household + Group + Export
- **Household management** — Create, join, leave households for shared memories (`/memory household` commands)
- **Household access control** — Membership verification enforced on note read/write, household notes visible to all members
- **Group chat context** — In group chats, searches automatically target household memories (if user is a household member)
- **Data export** — `/memory export` generates full JSON export (notes, entities, structured data, audit log) downloadable via URL
- **Household search fix** — FTS5 search uses `scope_id` for household scope (any member can find any member's shared notes)
- **Updated /memory help** — Shows export + household commands

## [0.63.0] — 2026-06-08

### Added — PKM Phase 6: Entity + Structured Data + Contradiction Detection
- **Entity extraction & linking** — Named entities (people, places, companies) from LLM extraction are stored in `entities` table and linked to notes via `entity_notes`
- **Entity search MCP tool** (`pkm_entity_search`) — Search memories by person/place name, returns entity info and linked memory count
- **Contradiction detection** — New notes automatically supersede older conflicting notes:
  - Health/structured data: newer reading supersedes all older readings of same type (e.g. weight)
  - Preferences/facts: title similarity matching (>60% word overlap) marks older as superseded
- **Entity REST API** — `POST /api/pkm/entities` (search) + `GET /api/pkm/entities/:id` (get linked notes)
- Access control enforced on entity endpoints (user isolation)

## [0.62.0] — 2026-06-08

### Added — PKM Phase 5: LLM Extraction Wiring
- **LLM extraction pipeline wired** — Conversation windows now get extracted via the overflow ACP when they close
- **`ensureOverflow()` method** on ACPManager — Public API to spawn overflow ACP on demand for background LLM calls
- Extraction uses overflow-only policy (never primary) to avoid blocking user prompts
- Graceful degradation: extraction deferred if overflow busy or disabled, retries on next 5-min maintenance cycle

## [0.61.0] — 2026-06-08

### Added — PKM (Personal Knowledge Management) Phase 1
- **Core memory system** — SQLite-backed long-term memory with FTS5 full-text search, per-user privacy isolation, and secure deletion
- **6 new modules**: `store.mjs` (schema + CRUD), `security.mjs` (scrubbing + injection defense), `extractor.mjs` (conversation window tracking + extraction pipeline), `search.mjs` (FTS5 + prefetch + deep recall), `pkm-mcp-server.mjs` (10 MCP tools), `index.mjs` (coordinator)
- **10 MCP tools**: `pkm_search`, `pkm_write`, `pkm_read`, `pkm_update`, `pkm_delete`, `pkm_recent`, `pkm_stats`, `pkm_settings`, `pkm_agent_search`, `pkm_agent_write`
- **RBAC integration** — `pkm:read`, `pkm:write`, `pkm:admin` capabilities with role-based defaults
- **Conversation tracking** — User and agent messages tracked in conversation windows for future extraction
- **Prompt builder PKM hints** — Agent and user memory hints injected into preamble when PKM is enabled
- **REST API** — `/api/pkm/*` routes in webui server for MCP server communication
- **/memory command** — `/memory enable|disable|stats|delete all` for user self-service
- **Secure deletion** — `PRAGMA secure_delete`, FTS5 secure-delete mode, WAL checkpoint for forensic-grade data removal
- **Sensitive content scrubbing** — Credit cards, passwords, OTPs, API keys, and tokens automatically scrubbed before storage
- **Prompt injection defense** — 4-layer detection (system prompt manipulation, role-play attacks, output override, data exfiltration)
- **Agent private memory** — Separate memory scope for agent's own operational knowledge, bootstrapped from MEMORY.md

## [0.60.0] — 2026-06-07

### Fixed (RBAC UX Audit)
- **Expired users now get "access expired" message** instead of going through new-user approval flow
- **Approval audit records admin's actual ID** instead of generic "approval" string
- **Invite creation enforces delegation boundary** — `canGrantRole()` checked when `createdBy` is specified; prevents creating invites for roles above your rank
- **TOOL_DENY events logged to audit** — Permission denials now recorded in RBAC audit log with tool, capability, entity, and reason
- **Invite tokens masked in list APIs** — `listInvites()` returns 8-char ID prefix instead of full bearer token; revocation works by prefix match
- **Invite revocation records actor** — `revokeInvite()` accepts `revokedBy` parameter for proper audit attribution

### Added
- **Invite revocation** — `revokeInvite()` method, `DELETE /api/rbac/invites` endpoint, `rbac_revoke_invite` MCP tool
- **Invite listing** — `listInvites()` with status filter, `GET /api/rbac/invites` endpoint, `rbac_list_invites` MCP tool
- **Default invite expiry** — Invites expire after 7 days if no custom expiry set
- **Approval notification includes chat context** — Shows "Via: Direct message" or "Via: Group chat" in admin approval request
- **WebUI: Invites list** — Active/used/expired invite listing with status badges and revoke buttons
- **WebUI: Audit log filters** — Filter by event type and actor; dedicated filter UI with clear button
- **WebUI: Role editor** — Inline edit form for roles with grouped capability picker (Entity/Automation/Dashboard/Admin/SI/Other)
- **WebUI: Role creation with capabilities** — New role form now includes full capability picker
- **WebUI: Built-in role editing** — Edit button on built-in roles for capability/rank customization

## [0.59.1] — 2026-06-07

### Fixed (Final Review)
- **SECURITY: `ha_eval_template` no longer bypasses RBAC** — Moved from universal tools (no permission check) to `entity:read` capability. Guests without `entity:read` can no longer use template evaluation to read all entity states.
- **SECURITY: Owner role assignment blocked via REST API** — `PUT /api/rbac/users/:id/role` now rejects `role: "owner"` (must be set via `allowed_chat_ids` config). Also accepts optional `actorId` for delegation boundary enforcement.
- **`ha_bulk_control` per-entity RBAC checks** — Bulk control tool now extracts all entity IDs from arguments (`entity_ids`, `entities`, `entity_id`) and checks RBAC for each individually. Per-entity deny overrides can no longer be bypassed via bulk operations.
- **Invite link prevents role downgrade** — Expired users with higher-ranked roles who rejoin via a lower-ranked invite link keep their original role instead of being silently downgraded. Admin is notified of the re-activation.

## [0.59.0] — 2026-06-07

### Added
- **Audit log** — Append-only JSONL audit trail at `/data/rbac-audit.log`. Records all RBAC mutations: role grants/revokes, role CRUD, overrides, invites, expiry events. Supports paginated reads with filtering by event/actor/target. Auto-rotates at 10K entries.
- **Override MCP tools** — 4 new agent-callable tools: `rbac_list_overrides`, `rbac_set_override`, `rbac_delete_override`, `rbac_get_audit_log`.
- **Override REST API** — `GET/POST/DELETE /api/rbac/overrides` and `GET /api/rbac/audit` endpoints.
- **WebUI "Users & Roles" tab** — Full RBAC management UI with sub-tabs for Users (edit/revoke), Roles (create/delete/inspect), Overrides (create/delete), Audit log (paginated viewer), and Invites (link generator).
- **Filtered override queries** — `getOverrides()` now accepts optional entity_id/target_type/target_id filters.

### Fixed
- Audit log rotation threshold lowered from 1MB to 512KB to ensure rotation fires before 10K-line limit.

## [0.58.0] — 2026-06-07

### Added
- **Admin approval flow** — New users trigger inline button prompts to all admins with `user:manage` capability. First admin to respond wins; role assignment is immediate with welcome message and original message replay.
- **Invite link onboarding** — Users can join via `/start invite_TOKEN` or `/start guest_TOKEN` deep links. Auto-assigns role from invite config, supports usage limits and expiry.
- **Expiry notifications** — 5-minute background check notifies users and admins when access expires. Expiry flag resets on role reassignment so re-approved users get future notifications.
- **Stale approval cleanup** — Pending approvals older than 15 minutes are automatically cleaned up, preventing permanent "being reviewed" stuck state.
- **`/pair list` shows roles** — Updated to display role name + icon instead of just admin badge.
- **RBACManager utility methods** — `getUsersWithCapability()`, `getGrantableRoles()`, `getWelcomeMessage()`, `getNewlyExpiredUsers()`.

### Fixed
- **Pending approval null-destructure** — ButtonManager prompt expiry no longer crashes the approval handler (guards against null result).
- **Message replay chat type** — Stores actual chat type instead of hardcoding "private", fixing group-originated approval replays.
- **User notified on approval failure** — If `setUserRole` throws during approval (e.g., deleted role), user now gets an error message instead of silence.

## [0.57.0] — 2026-06-07

### Added
- **RBAC permission enforcement** — Tool calls from non-owner users are now checked against role capabilities before reaching the permission prompt. RBAC denials are absolute (cannot be bypassed by allow-all mode or per-scope grants). Enforcement happens in `PermissionHandler` before any existing auto-approve logic.
- **RBAC MCP tools** (`rbac-mcp-server.mjs`) — 11 agent-callable tools for managing roles, users, and permissions:
  - `rbac_list_roles`, `rbac_get_role`, `rbac_create_role`, `rbac_update_role`, `rbac_delete_role` — full role lifecycle
  - `rbac_list_users`, `rbac_get_user`, `rbac_set_user_role`, `rbac_revoke_user` — user management
  - `rbac_check_permission` — debug tool for testing permission resolution
  - `rbac_create_invite` — generate invite tokens for self-service onboarding
- **RBAC REST API** — 11 endpoints under `/api/rbac/` in the WebUI server, backing the MCP tools
- **RBAC MCP server registered** on primary ACP only (excluded from overflow/background to prevent privilege escalation via `--allow-all` bypass)

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
