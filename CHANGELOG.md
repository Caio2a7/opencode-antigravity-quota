# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-22

### Added

- OpenCode V2 CLI/TUI plugin rendering an "Antigravity Quota" block in the session sidebar (`sidebar.content` slot).
- Unified quota bars for `Gemini-5h` (5-hour pool), `Gemini-Week` (7-day weekly pool) and `Argon` (7-day weekly pool) with severity colouring, `used`/`remaining` display modes and ticking relative reset countdowns.
- Primary quota fetch via `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` (with `v1internal:loadCodeAssist` project discovery when absent), with fallbacks to `v1internal:fetchAvailableModels`, `v1internal:retrieveUserQuota`, Gemini CLI `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` and `cachedQuota` from `antigravity-accounts.json`.
- Strictly read-only credential lookup (`ANTIGRAVITY_OAUTH_TOKEN`, `credentialsPath`, `antigravity-accounts.json`, `~/.gemini/antigravity-cli/antigravity-oauth-token`, `~/.gemini/oauth_creds.json`).
- In-memory-only OAuth token refresh via `https://oauth2.googleapis.com/token` with zero hardcoded OAuth secrets (resolving client credentials from `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET` or read-only scan of installed `opencode-antigravity-auth`).
- Multi-window coordination through `${XDG_CACHE_HOME:-~/.cache}/opencode-antigravity-quota/state.json` (`0700`/`0600`, atomic rename) and `fetch.lock`: shared snapshot cache, single-flight requests, `Retry-After` support, persisted exponential backoff (2m → 30m) and immediate cache invalidation when the active account changes.
- Polite polling with a 120s default (60s minimum), stale-while-error / rate-limit display, debounced post-turn refresh and `/antigravity-quota` (`/ag-quota`) slash command / command-palette entry.
- Options: `refreshInterval`, `displayMode`, `showModels`, `credentialsPath`.
- Release automation from GitHub Actions via npm trusted publishing (OIDC) with provenance.

[Unreleased]: https://github.com/Caio2a7/opencode-antigravity-quota/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Caio2a7/opencode-antigravity-quota/releases/tag/v0.1.0
