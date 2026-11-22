import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  accountCandidatePaths,
  antigravityCliTokenPath,
  extractActiveAccountEmailFromJson,
  geminiCliCredsPath,
  resolveCredentials,
  type CredentialDeps,
} from "../src/credentials"

const NOW = new Date("2026-11-22T12:00:00Z")
const FRESH_ISO = "2026-11-22T13:00:00Z"
const EXPIRED_ISO = "2026-11-22T12:00:30Z" // inside 60s expiry buffer
const PAST_ISO = "2026-11-22T11:00:00Z"
const FUTURE_ISO = "2026-11-22T18:00:00Z"
const HOME = "/home/tester"
const ACCOUNTS_PATH = join(HOME, ".config", "opencode", "antigravity-accounts.json")
const CLI_PATH = antigravityCliTokenPath(HOME)
const GEMINI_PATH = geminiCliCredsPath(HOME)

function harness(files: Record<string, string>) {
  const calls: string[] = []
  const readFile = async (p: string) => {
    calls.push(p)
    if (!(p in files)) throw new Error(`ENOENT: ${p}`)
    return files[p]!
  }
  return { calls, readFile }
}

const deps = (files: Record<string, string>, extra: Partial<CredentialDeps> = {}): CredentialDeps => ({
  env: {},
  homeDir: HOME,
  readFile: harness(files).readFile,
  now: NOW,
  platform: "linux",
  ...extra,
})

const cliTokenJson = (email: string, expiry = FRESH_ISO, accessToken = "test-cli-access", refreshToken?: string) =>
  JSON.stringify({
    id_token_email: email,
    token: { access_token: accessToken, expiry, ...(refreshToken ? { refresh_token: refreshToken } : {}) },
  })

describe("precedence and path discovery", () => {
  test("ANTIGRAVITY_OAUTH_TOKEN env wins without reading any file", async () => {
    const h = harness({ [ACCOUNTS_PATH]: "{}" })
    const r = await resolveCredentials({
      env: { ANTIGRAVITY_OAUTH_TOKEN: "  test-env-token \n", ANTIGRAVITY_PROJECT_ID: " proj-env " },
      homeDir: HOME,
      readFile: h.readFile,
      now: NOW,
    })
    expect(h.calls).toEqual([])
    expect(r).toEqual({
      ok: true,
      source: "env",
      apiKind: "antigravity",
      accessToken: "test-env-token",
      accessTokenExpiresAt: null,
      refreshToken: null,
      email: null,
      projectId: "proj-env",
      userAgent: null,
      pool: null,
      cachedFallback: null,
    })
  })

  test("blank env token falls through to explicit credentialsPath, then default files", async () => {
    const custom = "/custom/explicit.json"
    const h = harness({
      [custom]: JSON.stringify({ accounts: [{ refreshToken: "test-refresh-1", email: "a@example.com" }] }),
    })
    const r = await resolveCredentials({
      env: { ANTIGRAVITY_OAUTH_TOKEN: "   " },
      homeDir: HOME,
      readFile: h.readFile,
      now: NOW,
      credentialsPath: custom,
    })
    expect(h.calls).toEqual([custom, CLI_PATH])
    expect(r.ok && r.source === "antigravity-accounts" && r.refreshToken).toBe("test-refresh-1")
  })

  test("explicit credentialsPath supports antigravity-cli, gemini-cli, and reports missing/invalid", async () => {
    const cli = await resolveCredentials(deps({ "/p/cli.json": cliTokenJson("u@example.com") }, { credentialsPath: "/p/cli.json" }))
    expect(cli.ok && cli.source === "antigravity-cli" && cli.accessToken).toBe("test-cli-access")

    const gem = await resolveCredentials(
      deps(
        { "/p/g.json": JSON.stringify({ access_token: "test-gem-access", expiry_date: NOW.getTime() + 120_000, project_id: "g-proj" }) },
        { credentialsPath: "/p/g.json" },
      ),
    )
    expect(gem.ok && gem.source === "gemini-cli" && gem.apiKind === "gemini-cli" && gem.projectId).toBe("g-proj")

    const missing = await resolveCredentials(deps({}, { credentialsPath: "/p/missing.json" }))
    expect(!missing.ok && missing.reason).toBe("missing")

    const invalid = await resolveCredentials(deps({ "/p/bad.json": "{not json" }, { credentialsPath: "/p/bad.json" }))
    expect(!invalid.ok && invalid.reason).toBe("invalid")
  })

  test("falls through accounts -> antigravity-cli -> gemini-cli -> missing", async () => {
    const fromCli = await resolveCredentials(deps({ [CLI_PATH]: cliTokenJson("cli@example.com") }))
    expect(fromCli.ok && fromCli.source === "antigravity-cli" && fromCli.email).toBe("cli@example.com")

    const fromGemini = await resolveCredentials(
      deps({
        [CLI_PATH]: cliTokenJson("cli@example.com", EXPIRED_ISO),
        [GEMINI_PATH]: JSON.stringify({ access_token: "test-gem-token", expiry_date: Math.floor(NOW.getTime() / 1000) + 300 }),
      }),
    )
    expect(fromGemini.ok && fromGemini.source === "gemini-cli" && fromGemini.accessToken).toBe("test-gem-token")

    const expiredGemini = await resolveCredentials(
      deps({ [GEMINI_PATH]: JSON.stringify({ access_token: "test-gem-token", expiry_date: NOW.getTime() + 30_000 }) }),
    )
    expect(!expiredGemini.ok && expiredGemini.reason).toBe("expired")

    const none = await resolveCredentials(deps({}))
    expect(!none.ok && none.reason).toBe("missing")
  })

  test("accountCandidatePaths honours OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, and win32 APPDATA", () => {
    expect(accountCandidatePaths({ OPENCODE_CONFIG_DIR: "/alt" }, HOME, "linux")).toEqual([join("/alt", "antigravity-accounts.json")])
    expect(accountCandidatePaths({ XDG_CONFIG_HOME: "/xdg" }, HOME, "linux")).toEqual([join("/xdg", "opencode", "antigravity-accounts.json")])
    expect(accountCandidatePaths({ APPDATA: "/roaming" }, HOME, "win32")).toEqual([
      join(HOME, ".config", "opencode", "antigravity-accounts.json"),
      join("/roaming", "opencode", "antigravity-accounts.json"),
    ])
  })
})

describe("CLI access token reuse", () => {
  const accountsFile = JSON.stringify({
    activeIndex: 0,
    accounts: [{ refreshToken: "test-refresh", email: "Alice@Example.com", managedProjectId: "proj-1", fingerprint: { userAgent: "ag/1.0" } }],
  })

  test("reuses fresh CLI access_token when email matches case-insensitively", async () => {
    const r = await resolveCredentials(deps({ [ACCOUNTS_PATH]: accountsFile, [CLI_PATH]: cliTokenJson("alice@example.com", FRESH_ISO) }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.accessToken).toBe("test-cli-access")
      expect(r.accessTokenExpiresAt).toEqual(new Date(FRESH_ISO))
      expect(r.projectId).toBe("proj-1")
      expect(r.userAgent).toBe("ag/1.0")
    }
  })

  test("ignores CLI token when expired or belonging to a different email", async () => {
    const expired = await resolveCredentials(deps({ [ACCOUNTS_PATH]: accountsFile, [CLI_PATH]: cliTokenJson("alice@example.com", EXPIRED_ISO) }))
    expect(expired.ok && expired.accessToken).toBeNull()

    const wrongEmail = await resolveCredentials(deps({ [ACCOUNTS_PATH]: accountsFile, [CLI_PATH]: cliTokenJson("bob@example.com", FRESH_ISO) }))
    expect(wrongEmail.ok && wrongEmail.accessToken).toBeNull()
  })
})

describe("pool summary and cachedFallback", () => {
  test("returns pool: null when only 1 enabled account exists", async () => {
    const content = JSON.stringify({
      activeIndex: 0,
      accounts: [
        { refreshToken: "test-r1", email: "a@example.com", enabled: true },
        { refreshToken: "test-r2", email: "b@example.com", enabled: false },
      ],
    })
    const r = await resolveCredentials(deps({ [ACCOUNTS_PATH]: content }))
    expect(r.ok && r.pool).toBeNull()
  })

  test("computes PoolSummary with disabled accounts, past resetTime as ready, and rateLimitResetTimes", async () => {
    const content = JSON.stringify({
      activeIndex: 1,
      accounts: [
        {
          refreshToken: "test-r1",
          email: "a@example.com",
          enabled: true,
          cachedQuota: {
            "gemini-pro": { remainingFraction: 0, remainingFractionResetTime: PAST_ISO },
            claude: { remainingFraction: 0, remainingFractionResetTime: FUTURE_ISO },
          },
        },
        {
          refreshToken: "test-r2",
          email: "b@example.com",
          enabled: true,
          cachedQuotaUpdatedAt: NOW.getTime() - 120_000,
          cachedQuota: {
            "gemini-pro": { remainingFraction: 0.7, resetTime: FUTURE_ISO },
            claude: { remainingFraction: 0.5, resetTime: FUTURE_ISO },
          },
        },
        {
          refreshToken: "test-r3",
          email: "c@example.com",
          enabled: true,
          rateLimitResetTimes: { "gemini-antigravity": NOW.getTime() + 60_000, claude: NOW.getTime() - 1_000 },
        },
        { refreshToken: "test-r4", email: "disabled@example.com", enabled: false },
      ],
    })
    const r = await resolveCredentials(deps({ [ACCOUNTS_PATH]: content }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.email).toBe("b@example.com")
      // Enabled: a (gemini ready via past reset), b (gemini ready), c (gemini rate-limited)
      expect(r.pool).toEqual({ total: 4, enabled: 3, geminiReady: 2 })
      expect(r.cachedFallback).not.toBeNull()
      expect(r.cachedFallback?.source).toBe("cached")
      expect(r.cachedFallback?.fetchedAt).toEqual(new Date(NOW.getTime() - 120_000))
      expect(r.cachedFallback?.buckets.map((b) => [b.id, b.remaining])).toEqual([["gemini_5h", 70]])
    }
  })

  test("extractActiveAccountEmailFromJson handles accounts, CLI JSON, and invalid inputs", () => {
    expect(
      extractActiveAccountEmailFromJson({
        activeIndex: 0,
        accounts: [
          { refreshToken: "r1", email: "disabled@example.com", enabled: false },
          { refreshToken: "r2", email: "enabled@example.com", enabled: true },
        ],
      }),
    ).toBe("enabled@example.com")
    expect(extractActiveAccountEmailFromJson({ id_token_email: "cli@example.com", token: {} })).toBe("cli@example.com")
    expect(extractActiveAccountEmailFromJson(null)).toBeNull()
    expect(extractActiveAccountEmailFromJson({})).toBeNull()
  })
})
