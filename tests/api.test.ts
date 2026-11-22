import { describe, expect, test } from "bun:test"
import {
  ANTIGRAVITY_LOAD_CODE_ASSIST_URL,
  ANTIGRAVITY_MODELS_URL,
  ANTIGRAVITY_QUOTA_SUMMARY_URL,
  ANTIGRAVITY_RETRIEVE_QUOTA_URL,
  DEFAULT_ANTIGRAVITY_USER_AGENT,
  fetchAntigravityQuota,
  fetchGeminiCliQuota,
  GEMINI_CLI_HEADERS,
  GEMINI_CLI_QUOTA_URL,
} from "../src/api"
import { createLoader, readActiveAccountEmail } from "../src/loader"
import type { TokenExchanger } from "../src/oauth"
import type { QuotaSnapshot } from "../src/types"

const TOKEN = "test-access-token"
const NOW = new Date("2026-11-22T12:00:00Z")
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const SUMMARY_PAYLOAD = JSON.stringify({
  groups: [
    {
      buckets: [
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8, resetTime: "2026-11-22T16:00:00Z" },
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-11-28T00:00:00Z" },
        { bucketId: "gemini-argon", remainingFraction: 0.4, resetTime: "2026-11-29T14:00:00Z" },
      ],
    },
  ],
})

const MODELS_PAYLOAD = JSON.stringify({
  models: {
    "gemini-4-neon": { quotaInfo: { remainingFraction: 0.7, resetTime: "2026-11-22T16:00:00Z" } },
    "gemini-argon-preview": { quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-29T14:00:00Z" } },
  },
})

const RETRIEVE_PAYLOAD = JSON.stringify({
  buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.75, resetTime: "2026-11-22T18:00:00Z" }],
})

const respond = (status: number, body = "", headers: Record<string, string> = {}): FetchFn => async () =>
  new Response(body, { status, headers })

describe("fetchAntigravityQuota", () => {
  test("calls retrieveUserQuotaSummary as primary endpoint (1 request) with headers, project, and AbortSignal", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const res = await fetchAntigravityQuota(TOKEN, {
      projectId: "proj-123",
      accountEmail: "dev@example.com",
      userAgent: "custom-ag/1.2",
      now: () => NOW,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init })
        return new Response(SUMMARY_PAYLOAD, { status: 200 })
      }) as never,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(ANTIGRAVITY_QUOTA_SUMMARY_URL)
    const headers = new Headers(seen[0]!.init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("user-agent")).toBe("custom-ag/1.2")
    expect(seen[0]!.init?.body).toBe(JSON.stringify({ project: "proj-123" }))
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.snapshot.source).toBe("antigravity")
      expect(res.snapshot.buckets.map((b) => [b.id, b.remaining])).toEqual([
        ["gemini_5h", 80],
        ["gemini_weekly", 90],
        ["gemini_argon", 40],
      ])
    }
  })

  test("discovers projectId via loadCodeAssist when absent and caches it", async () => {
    const calls: Array<{ url: string; body: string; ua: string | null }> = []
    const projectCache = new Map<string, string>()
    const fetchFn: FetchFn = async (url, init) => {
      const u = String(url)
      calls.push({ url: u, body: String(init?.body ?? ""), ua: new Headers(init?.headers).get("user-agent") })
      if (u === ANTIGRAVITY_LOAD_CODE_ASSIST_URL) {
        return new Response(JSON.stringify({ cloudaicompanionProject: { id: "discovered-proj" } }), { status: 200 })
      }
      return new Response(SUMMARY_PAYLOAD, { status: 200 })
    }

    await fetchAntigravityQuota(TOKEN, { fetch: fetchFn as never, now: () => NOW, accountEmail: "u@example.com", projectCache })
    await fetchAntigravityQuota(TOKEN, { fetch: fetchFn as never, now: () => NOW, accountEmail: "u@example.com", projectCache })

    expect(calls.map((c) => c.url)).toEqual([ANTIGRAVITY_LOAD_CODE_ASSIST_URL, ANTIGRAVITY_QUOTA_SUMMARY_URL, ANTIGRAVITY_QUOTA_SUMMARY_URL])
    expect(calls[0]!.ua).toBe(DEFAULT_ANTIGRAVITY_USER_AGENT)
    expect(calls[1]!.body).toBe(JSON.stringify({ project: "discovered-proj" }))
  })

  test("falls back to fetchAvailableModels on 404 or summary with only 3p-* buckets, then retrieveUserQuota if models empty", async () => {
    const urls404: string[] = []
    const res404 = await fetchAntigravityQuota(TOKEN, {
      projectId: "p",
      now: () => NOW,
      fetch: (async (url: string | URL | Request) => {
        const u = String(url)
        urls404.push(u)
        return u === ANTIGRAVITY_QUOTA_SUMMARY_URL ? new Response("", { status: 404 }) : new Response(MODELS_PAYLOAD, { status: 200 })
      }) as never,
    })
    expect(urls404).toEqual([ANTIGRAVITY_QUOTA_SUMMARY_URL, ANTIGRAVITY_MODELS_URL])
    expect(res404.ok && res404.snapshot.buckets.map((b) => b.id)).toEqual(["gemini_5h", "gemini_argon"])

    const urls3p: string[] = []
    const only3p = JSON.stringify({ groups: [{ buckets: [{ bucketId: "3p-claude-5h", remainingFraction: 0.5 }] }] })
    const res3p = await fetchAntigravityQuota(TOKEN, {
      projectId: "p",
      now: () => NOW,
      fetch: (async (url: string | URL | Request) => {
        const u = String(url)
        urls3p.push(u)
        if (u === ANTIGRAVITY_QUOTA_SUMMARY_URL) return new Response(only3p, { status: 200 })
        if (u === ANTIGRAVITY_MODELS_URL) return new Response(JSON.stringify({ models: {} }), { status: 200 })
        return new Response(RETRIEVE_PAYLOAD, { status: 200 })
      }) as never,
    })
    expect(urls3p).toEqual([ANTIGRAVITY_QUOTA_SUMMARY_URL, ANTIGRAVITY_MODELS_URL, ANTIGRAVITY_RETRIEVE_QUOTA_URL])
    expect(res3p.ok && res3p.snapshot.buckets[0]?.id).toBe("gemini_5h")
  })

  test("short-circuits without fallback on 401/403, 429 with Retry-After, and timeout; maps 500/parse when fallback also fails", async () => {
    for (const status of [401, 403]) {
      let calls = 0
      const r = await fetchAntigravityQuota(TOKEN, {
        projectId: "p",
        fetch: (async () => (++calls, new Response("", { status }))) as never,
      })
      expect(calls).toBe(1)
      expect(!r.ok && r.kind).toBe("unauthorized")
      expect(!r.ok && r.message).not.toContain(TOKEN)
    }

    let calls429 = 0
    const r429 = await fetchAntigravityQuota(TOKEN, {
      projectId: "p",
      fetch: (async () => (++calls429, new Response("", { status: 429, headers: { "retry-after": "45" } }))) as never,
    })
    expect(calls429).toBe(1)
    expect(r429).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 45_000 })

    let callsTimeout = 0
    const timeout = await fetchAntigravityQuota(TOKEN, {
      projectId: "p",
      timeoutMs: 25,
      fetch: ((_u: unknown, init?: RequestInit) => {
        callsTimeout += 1
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))
        })
      }) as never,
    })
    expect(callsTimeout).toBe(1)
    expect(!timeout.ok && timeout.kind).toBe("network")

    const r500 = await fetchAntigravityQuota(TOKEN, { projectId: "p", fetch: respond(500) as never })
    expect(!r500.ok && r500.kind === "http" && r500.message).toContain("500")

    const badJson = await fetchAntigravityQuota(TOKEN, { projectId: "p", fetch: respond(200, "{bad-json") as never })
    expect(!badJson.ok && badJson.kind).toBe("parse")
  })
})

describe("fetchGeminiCliQuota", () => {
  test("sends GEMINI_CLI_HEADERS and parses response", async () => {
    let seenUrl = ""
    let seenHeaders: Headers | null = null
    const res = await fetchGeminiCliQuota(TOKEN, {
      projectId: "gem-proj",
      now: () => NOW,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url)
        seenHeaders = new Headers(init?.headers)
        return new Response(RETRIEVE_PAYLOAD, { status: 200 })
      }) as never,
    })
    expect(seenUrl).toBe(GEMINI_CLI_QUOTA_URL)
    expect(seenHeaders!.get("x-goog-api-client")).toBe(GEMINI_CLI_HEADERS["X-Goog-Api-Client"]!)
    expect(seenHeaders!.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(res.ok && res.snapshot.source === "gemini-cli" && res.snapshot.buckets[0]?.id).toBe("gemini_5h")
  })

  test("maps HTTP and parse errors cleanly", async () => {
    expect(await fetchGeminiCliQuota(TOKEN, { fetch: respond(403) as never })).toMatchObject({ ok: false, kind: "unauthorized" })
    expect(await fetchGeminiCliQuota(TOKEN, { fetch: respond(429, "", { "retry-after": "15" }) as never })).toMatchObject({
      ok: false,
      kind: "rate_limited",
      retryAfterMs: 15_000,
    })
    expect(await fetchGeminiCliQuota(TOKEN, { fetch: respond(502) as never })).toMatchObject({ ok: false, kind: "http" })
    expect(await fetchGeminiCliQuota(TOKEN, { fetch: respond(200, "not-json") as never })).toMatchObject({ ok: false, kind: "parse" })
  })
})

describe("createLoader and readActiveAccountEmail", () => {
  const sampleSnapshot: QuotaSnapshot = {
    accountEmail: "dev@example.com",
    source: "antigravity",
    buckets: [{ id: "gemini_5h", label: "Gemini-5h", utilization: 20, remaining: 80, resetsAt: null, modelCount: 1 }],
    pool: null,
    fetchedAt: NOW,
  }

  test("happy path uses fresh access token and fetches Antigravity quota", async () => {
    const loader = createLoader("/accounts.json", {
      now: () => NOW,
      credentialDeps: () => ({ env: { ANTIGRAVITY_OAUTH_TOKEN: TOKEN }, homeDir: "/h", readFile: async () => "", now: NOW }),
      fetchAntigravity: async (tok) => (tok === TOKEN ? { ok: true, snapshot: sampleSnapshot } : { ok: false, kind: "http", message: "bad" }),
    })
    expect(await loader()).toEqual({ ok: true, snapshot: sampleSnapshot })
  })

  test("retries once via refresh token after 401 when initial token came from CLI", async () => {
    const tokensSeen: string[] = []
    let invalidated = 0
    const accountsJson = JSON.stringify({ accounts: [{ refreshToken: "test-refresh", email: "dev@example.com" }] })
    const cliJson = JSON.stringify({
      id_token_email: "dev@example.com",
      token: { access_token: "test-stale-cli", expiry: "2026-11-22T14:00:00Z" },
    })
    const exchanger: TokenExchanger = {
      exchange: async () => ({ ok: true, accessToken: "test-fresh-refreshed", expiresAt: new Date(NOW.getTime() + 600_000) }),
      invalidate: () => void (invalidated += 1),
    }
    const loader = createLoader(undefined, {
      now: () => NOW,
      exchanger,
      credentialDeps: () => ({
        env: {},
        homeDir: "/home/u",
        now: NOW,
        readFile: async (p) => (p.endsWith("antigravity-accounts.json") ? accountsJson : cliJson),
      }),
      fetchAntigravity: async (tok) => {
        tokensSeen.push(tok)
        return tok === "test-stale-cli" ? { ok: false, kind: "unauthorized", message: "401" } : { ok: true, snapshot: sampleSnapshot }
      },
    })
    expect(await loader()).toEqual({ ok: true, snapshot: sampleSnapshot })
    expect(invalidated).toBe(1)
    expect(tokensSeen).toEqual(["test-stale-cli", "test-fresh-refreshed"])
  })

  test("falls back to cachedFallback when OAuth client is missing (no_client)", async () => {
    const accountsJson = JSON.stringify({
      accounts: [
        {
          refreshToken: "test-refresh",
          email: "dev@example.com",
          cachedQuotaUpdatedAt: NOW.getTime() - 60_000,
          cachedQuota: { "gemini-pro": { remainingFraction: 0.65, resetTime: "2026-11-22T16:00:00Z" } },
        },
      ],
    })
    const exchanger: TokenExchanger = {
      exchange: async () => ({ ok: false, kind: "no_client", message: "missing client" }),
      invalidate: () => {},
    }
    const loader = createLoader("/acc.json", {
      now: () => NOW,
      exchanger,
      credentialDeps: () => ({
        env: {},
        homeDir: "/home/u",
        now: NOW,
        readFile: async (p) => (p === "/acc.json" ? accountsJson : Promise.reject(new Error("ENOENT"))),
      }),
    })
    const res = await loader()
    expect(res.ok && res.snapshot.source).toBe("cached")
    expect(res.ok && res.snapshot.buckets[0]?.id).toBe("gemini_5h")
    expect(res.ok && res.snapshot.buckets[0]?.remaining).toBe(65)
  })

  test("readActiveAccountEmail skips on env token and reads explicit path otherwise", () => {
    expect(readActiveAccountEmail("/acc.json", { env: { ANTIGRAVITY_OAUTH_TOKEN: TOKEN } })).toBeNull()
    const email = readActiveAccountEmail("/acc.json", {
      env: {},
      readFileSync: () => JSON.stringify({ accounts: [{ refreshToken: "r", email: "active@example.com" }] }),
    })
    expect(email).toBe("active@example.com")
  })
})
