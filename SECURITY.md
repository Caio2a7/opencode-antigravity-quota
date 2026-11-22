# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for security problems.

Include the affected version, steps to reproduce and the impact. You can expect an acknowledgement and a fix or
mitigation plan as soon as the report is triaged.

## Scope

What the plugin does, and what is therefore in scope:

- Reads Antigravity and Gemini CLI OAuth credentials **read-only** from `ANTIGRAVITY_OAUTH_TOKEN` (optional `ANTIGRAVITY_PROJECT_ID`), `credentialsPath`, `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/antigravity-accounts.json` (plus `%APPDATA%\opencode\antigravity-accounts.json` on Windows), `~/.gemini/antigravity-cli/antigravity-oauth-token`, or `~/.gemini/oauth_creds.json`.
- When an account only has a refresh token and no fresh access token, exchanges it **in memory only** over HTTPS against `https://oauth2.googleapis.com/token`. Contains zero hardcoded OAuth client secrets: client credentials are read from `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET` or a read-only text scan of the locally installed `opencode-antigravity-auth` package. Access and refresh tokens are never logged, written back or persisted to disk.
- Sends HTTPS quota requests only to `https://daily-cloudcode-pa.googleapis.com` (`v1internal:retrieveUserQuotaSummary`, `v1internal:loadCodeAssist`, `v1internal:fetchAvailableModels`, `v1internal:retrieveUserQuota`) and `https://cloudcode-pa.googleapis.com` (`v1internal:retrieveUserQuota`).
- Writes a local usage snapshot cache to `${XDG_CACHE_HOME:-~/.cache}/opencode-antigravity-quota/state.json` (directory `0700`, files `0600`, atomic temp-file rename) and `fetch.lock` containing only quota percentages, reset timestamps, account email, pool counts and error backoff state — never credentials.
- Spawns zero subprocesses, sends no telemetry, performs no browser scraping and has zero runtime dependencies.
- Releases are published from GitHub Actions via npm trusted publishing (OIDC) with provenance.

Out of scope: vulnerabilities in OpenCode itself, in `opencode-antigravity-auth`, `antigravity-cli`, Gemini CLI, Google's Cloud Code or OAuth API endpoints, or in your operating system.
