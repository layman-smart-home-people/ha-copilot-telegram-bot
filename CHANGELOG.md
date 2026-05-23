# Changelog

## 0.1.0 (2025-01-27)

Initial release.

### Features
- Always-on Telegram bot daemon
- On-demand Copilot CLI spawning via ACP (Agent Client Protocol)
- Auto-reconnect on Copilot crash
- Message queue during Copilot startup
- Rich Telegram formatting (Markdown → HTML conversion)
- Message chunking for long responses (4096 char limit)
- Typing indicators with debounce
- Live tool-call status bubbles (auto-deleted on completion)
- Photo and document attachment support
- Image relay from Copilot tool results
- Rate-limited send queue with 429 retry
- Slash commands: /autopilot, /plan, /model, /compact, /cancel, /usage, /status, /session, /help
- Chat ID allowlist for access control
- Preamble optimization (full system prompt on first message, short tag after)
- Idle timeout with configurable minutes
- Graceful shutdown with s6-overlay
- Multi-architecture support (aarch64, amd64)
