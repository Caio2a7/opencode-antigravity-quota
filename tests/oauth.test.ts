import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  createTokenExchanger,
  discoverOAuthClient,
  extractClientFromConstants,
  GOOGLE_TOKEN_URL,
  type OAuthClientConfig,
  type OAuthDiscoverDeps,
} from "../src/oauth"

const CLIENT: OAuthClientConfig = { clientId: "dummy-client-id", clientSecret: "dummy-client-secret" }
const REFRESH = "test-refresh-token"
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

describe("extractClientFromConstants and discoverOAuthClient", () => {
  test("extracts client id and secret with single or double quotes", () => {
    const js = `export const ANTIGRAVITY_CLIENT_ID = "dummy-client-id";\nexport const ANTIGRAVITY_CLIENT_SECRET = 'dummy-client-secret';`
    expect(extractClientFromConstants(js)).toEqual(CLIENT)
    expect(extractClientFromConstants(`const ANTIGRAVITY_CLIENT_ID = "only-id";`)).toBeNull()
  })

  test("env vars take precedence over filesystem discovery", async () => {
    let readCalls = 0
    const res = await discoverOAuthClient({
      env: { ANTIGRAVITY_CLIENT_ID: " dummy-env-id ", ANTIGRAVITY_CLIENT_SECRET: " dummy-env-secret " },
      homeDir: "/home/u",
      readFile: async () => (++readCalls, ""),
      listDir: async () => [],
      statMtime: async () => null,
    })
    expect(res).toEqual({ clientId: "dummy-env-id", clientSecret: "dummy-env-secret" })
    expect(readCalls).toBe(0)
  })

  test("discovers newest opencode-antigravity-auth constants.js in npm cache", async () => {
    const home = "/home/u"
    const npmDir = join(home, ".cache", "opencode", "npm")
    const oldPkg = join(npmDir, "opencode-antigravity-auth@1.0.0")
    const newPkg = join(npmDir, "opencode-antigravity-auth@2.0.0")
    const oldFile = join(oldPkg, "rev1", "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js")
    const newFile = join(newPkg, "rev2", "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js")

    const dirs: Record<string, string[]> = {
      [npmDir]: ["opencode-antigravity-auth@1.0.0", "opencode-antigravity-auth@2.0.0", "other-pkg@1.0.0"],
      [oldPkg]: ["rev1"],
      [newPkg]: ["rev2"],
    }
    const mtimes: Record<string, number> = { [oldPkg]: 100, [newPkg]: 200 }
    const files: Record<string, string> = {
      [oldFile]: `const ANTIGRAVITY_CLIENT_ID = "old-id"; const ANTIGRAVITY_CLIENT_SECRET = "old-secret";`,
      [newFile]: `const ANTIGRAVITY_CLIENT_ID = "new-id"; const ANTIGRAVITY_CLIENT_SECRET = "new-secret";`,
    }
    const deps: OAuthDiscoverDeps = {
      env: {},
      homeDir: home,
      listDir: async (d) => dirs[d] ?? [],
      statMtime: async (p) => mtimes[p] ?? 0,
      readFile: async (p) => {
        if (!(p in files)) throw new Error("ENOENT")
        return files[p]!
      },
    }
    expect(await discoverOAuthClient(deps)).toEqual({ clientId: "new-id", clientSecret: "new-secret" })
  })

  test("falls back to config dir node_modules and returns null when absent", async () => {
    const configFile = join("/cfg", "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js")
    const found = await discoverOAuthClient({
      env: { OPENCODE_CONFIG_DIR: "/cfg" },
      homeDir: "/home/u",
      listDir: async () => [],
      statMtime: async () => null,
      readFile: async (p) =>
        p === configFile ? `const ANTIGRAVITY_CLIENT_ID = "cfg-id"; const ANTIGRAVITY_CLIENT_SECRET = "cfg-secret";` : Promise.reject(new Error("ENOENT")),
    })
    expect(found).toEqual({ clientId: "cfg-id", clientSecret: "cfg-secret" })

    const none = await discoverOAuthClient({
      env: {},
      homeDir: "/home/u",
      listDir: async () => {
        throw new Error("ENOENT")
      },
      statMtime: async () => null,
      readFile: async () => {
        throw new Error("ENOENT")
      },
    })
    expect(none).toBeNull()
  })
})

describe("createTokenExchanger", () => {
  test("exchanges refresh token, caches in memory until expiry buffer, and supports invalidation", async () => {
    let nowMs = 1_000_000
    let calls = 0
    let lastReq: { url: string; body: string } | null = null
    const fetchFn: FetchFn = async (url, init) => {
      calls += 1
      lastReq = { url: String(url), body: String(init?.body ?? "") }
      return new Response(JSON.stringify({ access_token: `test-access-${calls}`, expires_in: 300 }), { status: 200 })
    }
    const exchanger = createTokenExchanger({
      fetch: fetchFn as never,
      now: () => new Date(nowMs),
      discoverClient: async () => CLIENT,
    })

    const first = await exchanger.exchange(REFRESH)
    expect(first).toEqual({ ok: true, accessToken: "test-access-1", expiresAt: new Date(nowMs + 300_000) })
    expect(lastReq!.url).toBe(GOOGLE_TOKEN_URL)
    expect(lastReq!.body).toContain("grant_type=refresh_token")
    expect(lastReq!.body).toContain("client_id=dummy-client-id")
    expect(lastReq!.body).toContain("client_secret=dummy-client-secret")

    // Cached hit well before 60s expiry buffer
    nowMs += 200_000
    const cached = await exchanger.exchange(REFRESH)
    expect(cached).toEqual(first)
    expect(calls).toBe(1)

    // Within 60s expiry buffer -> triggers fresh exchange
    nowMs += 40_000
    const refreshed = await exchanger.exchange(REFRESH)
    expect(refreshed.ok && refreshed.accessToken).toBe("test-access-2")
    expect(calls).toBe(2)

    // Explicit invalidate forces exchange immediately
    exchanger.invalidate(REFRESH)
    const afterInvalidate = await exchanger.exchange(REFRESH)
    expect(afterInvalidate.ok && afterInvalidate.accessToken).toBe("test-access-3")
    expect(calls).toBe(3)
  })

  test("deduplicates concurrent exchanges for the same refresh token", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn: FetchFn = async () => {
      calls += 1
      await gate
      return new Response(JSON.stringify({ access_token: "test-shared-token", expires_in: 600 }), { status: 200 })
    }
    const exchanger = createTokenExchanger({ fetch: fetchFn as never, discoverClient: async () => CLIENT })
    const p1 = exchanger.exchange(REFRESH)
    const p2 = exchanger.exchange(REFRESH)
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(calls).toBe(1)
    expect(r1).toEqual(r2)
  })

  test("maps HTTP 400 invalid_grant and 401 to unauthorized without leaking secrets", async () => {
    for (const [status, body] of [
      [400, JSON.stringify({ error: "invalid_grant" })],
      [401, JSON.stringify({ error: "unauthorized_client" })],
    ] as const) {
      const exchanger = createTokenExchanger({
        fetch: (async () => new Response(body, { status })) as never,
        discoverClient: async () => CLIENT,
      })
      const r = await exchanger.exchange(REFRESH)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.kind).toBe("unauthorized")
        expect(r.message).not.toContain(CLIENT.clientSecret)
        expect(r.message).not.toContain(REFRESH)
      }
    }
  })

  test("maps HTTP 429 with Retry-After (and caps at 1h), and 500/invalid body to http", async () => {
    const rateLimited = createTokenExchanger({
      fetch: (async () => new Response("slow", { status: 429, headers: { "retry-after": "120" } })) as never,
      discoverClient: async () => CLIENT,
    })
    expect(await rateLimited.exchange(REFRESH)).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 120_000 })

    const capped = createTokenExchanger({
      fetch: (async () => new Response("slow", { status: 429, headers: { "retry-after": "99999" } })) as never,
      discoverClient: async () => CLIENT,
    })
    expect(await capped.exchange(REFRESH)).toMatchObject({ ok: false, kind: "rate_limited", retryAfterMs: 3_600_000 })

    const serverErr = createTokenExchanger({
      fetch: (async () => new Response("oops", { status: 500 })) as never,
      discoverClient: async () => CLIENT,
    })
    expect(await serverErr.exchange(REFRESH)).toMatchObject({ ok: false, kind: "http" })

    const emptyTok = createTokenExchanger({
      fetch: (async () => new Response(JSON.stringify({ access_token: "   " }), { status: 200 })) as never,
      discoverClient: async () => CLIENT,
    })
    expect(await emptyTok.exchange(REFRESH)).toMatchObject({ ok: false, kind: "http" })
  })

  test("maps network rejection, timeout abort, and missing OAuth client", async () => {
    const netFail = createTokenExchanger({
      fetch: (async () => {
        throw new Error("ECONNRESET")
      }) as never,
      discoverClient: async () => CLIENT,
    })
    expect(await netFail.exchange(REFRESH)).toMatchObject({ ok: false, kind: "network" })

    const timeoutFail = createTokenExchanger({
      timeoutMs: 25,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))
        })) as never,
      discoverClient: async () => CLIENT,
    })
    const timed = await timeoutFail.exchange(REFRESH)
    expect(!timed.ok && timed.kind === "network" && timed.message).toContain("timed out")

    const noClient = createTokenExchanger({
      fetch: (async () => new Response("", { status: 200 })) as never,
      discoverClient: async () => null,
    })
    expect(await noClient.exchange(REFRESH)).toMatchObject({ ok: false, kind: "no_client" })
  })
})
