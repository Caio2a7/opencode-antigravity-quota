import { createHash } from "node:crypto"
import { readdir, readFile as fsReadFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const DEFAULT_TIMEOUT_MS = 10_000
const EXPIRY_BUFFER_MS = 60_000
const MAX_CACHE_ENTRIES = 64
const MAX_RETRY_MS = 60 * 60_000

const CLIENT_ID_RE = /\bANTIGRAVITY_CLIENT_ID\s*=\s*["']([^"']+)["']/
const CLIENT_SECRET_RE = /\bANTIGRAVITY_CLIENT_SECRET\s*=\s*["']([^"']+)["']/

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
}

export interface OAuthDiscoverDeps {
  env: Record<string, string | undefined>
  homeDir: string
  readFile: (path: string) => Promise<string>
  listDir: (dir: string) => Promise<string[]>
  statMtime: (path: string) => Promise<number | null>
}

export type TokenExchangeErrorKind = "unauthorized" | "rate_limited" | "network" | "http" | "no_client"

export type TokenExchangeResult =
  | { ok: true; accessToken: string; expiresAt: Date }
  | { ok: false; kind: TokenExchangeErrorKind; message: string; retryAfterMs?: number }

export interface TokenExchangerOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => Date
  discoverClient?: () => Promise<OAuthClientConfig | null>
}

export interface TokenExchanger {
  exchange(refreshToken: string): Promise<TokenExchangeResult>
  invalidate(refreshToken: string): void
}

const nonEmpty = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null)

export function defaultOAuthDiscoverDeps(): OAuthDiscoverDeps {
  return {
    env: process.env,
    homeDir: homedir(),
    readFile: (p) => fsReadFile(p, "utf8"),
    listDir: (d) => readdir(d),
    statMtime: async (p) => {
      try {
        return (await stat(p)).mtimeMs
      } catch {
        return null
      }
    },
  }
}

export function extractClientFromConstants(text: string): OAuthClientConfig | null {
  const clientId = text.match(CLIENT_ID_RE)?.[1]?.trim()
  const clientSecret = text.match(CLIENT_SECRET_RE)?.[1]?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

async function safeListDir(deps: OAuthDiscoverDeps, dir: string): Promise<string[]> {
  try {
    return await deps.listDir(dir)
  } catch {
    return []
  }
}

async function sortByNewest(deps: OAuthDiscoverDeps, parent: string, entries: readonly string[]): Promise<string[]> {
  const weighted = await Promise.all(
    entries.map(async (name) => ({ name, mtime: (await deps.statMtime(join(parent, name))) ?? 0 })),
  )
  weighted.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : b.name.localeCompare(a.name)))
  return weighted.map((entry) => entry.name)
}

async function candidateConstantsPaths(deps: OAuthDiscoverDeps): Promise<string[]> {
  const paths: string[] = []
  const xdgCache = nonEmpty(deps.env.XDG_CACHE_HOME)
  const cacheRoot = xdgCache && isAbsolute(xdgCache) ? xdgCache : join(deps.homeDir, ".cache")
  const npmCacheDir = join(cacheRoot, "opencode", "npm")
  const pkgEntries = (await safeListDir(deps, npmCacheDir)).filter((name) => name.startsWith("opencode-antigravity-auth@"))
  for (const pkg of await sortByNewest(deps, npmCacheDir, pkgEntries)) {
    const pkgDir = join(npmCacheDir, pkg)
    const revisions = await sortByNewest(deps, pkgDir, await safeListDir(deps, pkgDir))
    for (const rev of revisions) {
      paths.push(join(pkgDir, rev, "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js"))
    }
  }
  const configDir = nonEmpty(deps.env.OPENCODE_CONFIG_DIR) ?? join(nonEmpty(deps.env.XDG_CONFIG_HOME) ?? join(deps.homeDir, ".config"), "opencode")
  paths.push(join(configDir, "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js"))
  return paths
}

/** Resolves OAuth client credentials from env vars or read-only text scan of installed opencode-antigravity-auth. */
export async function discoverOAuthClient(overrides?: Partial<OAuthDiscoverDeps>): Promise<OAuthClientConfig | null> {
  const deps: OAuthDiscoverDeps = { ...defaultOAuthDiscoverDeps(), ...overrides }
  const envId = nonEmpty(deps.env.ANTIGRAVITY_CLIENT_ID)
  const envSecret = nonEmpty(deps.env.ANTIGRAVITY_CLIENT_SECRET)
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }
  for (const filePath of await candidateConstantsPaths(deps)) {
    try {
      const parsed = extractClientFromConstants(await deps.readFile(filePath))
      if (parsed) return parsed
    } catch {
      // Try next candidate path.
    }
  }
  return null
}

function tokenHash(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex")
}

function retryAfterMs(header: string | null): number | undefined {
  const seconds = header === null ? NaN : Number(header.trim())
  return header !== null && header.trim() !== "" && Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_MS)
    : undefined
}

function parseErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error
    }
  } catch {
    // Non-JSON error body.
  }
  return null
}

function interpretHttpFailure(status: number, body: string, retryAfter: string | null): TokenExchangeResult {
  const code = parseErrorCode(body)
  if (status === 401 || (status === 400 && code === "invalid_grant")) {
    return { ok: false, kind: "unauthorized", message: "Antigravity refresh token rejected or revoked — re-authenticate your account" }
  }
  if (status === 429) {
    const retryMs = retryAfterMs(retryAfter)
    return retryMs === undefined
      ? { ok: false, kind: "rate_limited", message: "Google OAuth token endpoint rate limited (HTTP 429)" }
      : { ok: false, kind: "rate_limited", message: "Google OAuth token endpoint rate limited (HTTP 429)", retryAfterMs: retryMs }
  }
  return { ok: false, kind: "http", message: `Google OAuth token endpoint returned HTTP ${status}` }
}

async function requestToken(
  refreshToken: string,
  client: OAuthClientConfig,
  opts: { fetchFn: typeof fetch; timeoutMs: number; now: () => Date },
): Promise<TokenExchangeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await opts.fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) return interpretHttpFailure(res.status, body, res.headers.get("retry-after"))
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { access_token?: unknown }).access_token !== "string") {
      return { ok: false, kind: "http", message: "Unexpected response from Google OAuth token endpoint" }
    }
    const token = (parsed as { access_token: string; expires_in?: unknown }).access_token.trim()
    if (!token) return { ok: false, kind: "http", message: "Google OAuth returned an empty access token" }
    const rawExpires = (parsed as { expires_in?: unknown }).expires_in
    const expiresInSec = typeof rawExpires === "number" && Number.isFinite(rawExpires) && rawExpires > 0 ? rawExpires : 3600
    return { ok: true, accessToken: token, expiresAt: new Date(opts.now().getTime() + expiresInSec * 1000) }
  } catch (err) {
    if (err instanceof SyntaxError) return { ok: false, kind: "http", message: "Unexpected response from Google OAuth token endpoint" }
    const reason = err instanceof Error && err.name === "AbortError" ? "request timed out" : "request failed"
    return { ok: false, kind: "network", message: `OAuth network error: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

const NO_CLIENT_RESULT: TokenExchangeResult = {
  ok: false,
  kind: "no_client",
  message: "Antigravity OAuth client not found — set ANTIGRAVITY_CLIENT_ID/SECRET or install opencode-antigravity-auth",
}

function storeInCache(cache: Map<string, { accessToken: string; expiresAt: Date }>, key: string, entry: { accessToken: string; expiresAt: Date }): void {
  cache.set(key, entry)
  if (cache.size <= MAX_CACHE_ENTRIES) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}

/** Exchanges refresh tokens for access tokens in memory only; never persists tokens to disk. */
export function createTokenExchanger(opts: TokenExchangerOptions = {}): TokenExchanger {
  const fetchFn = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? (() => new Date())
  const discoverClient = opts.discoverClient ?? (() => discoverOAuthClient())
  const cache = new Map<string, { accessToken: string; expiresAt: Date }>()
  const inFlight = new Map<string, Promise<TokenExchangeResult>>()

  const runExchange = async (refreshToken: string, key: string): Promise<TokenExchangeResult> => {
    const client = await discoverClient()
    if (!client) return NO_CLIENT_RESULT
    const result = await requestToken(refreshToken, client, { fetchFn, timeoutMs, now })
    if (result.ok) storeInCache(cache, key, { accessToken: result.accessToken, expiresAt: result.expiresAt })
    else if (result.kind === "unauthorized") cache.delete(key)
    return result
  }

  return {
    async exchange(refreshToken) {
      const key = tokenHash(refreshToken)
      const cached = cache.get(key)
      if (cached && cached.expiresAt.getTime() > now().getTime() + EXPIRY_BUFFER_MS) {
        return { ok: true, accessToken: cached.accessToken, expiresAt: cached.expiresAt }
      }
      const existing = inFlight.get(key)
      if (existing) return existing
      const pending = runExchange(refreshToken, key).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      })
      inFlight.set(key, pending)
      return pending
    },
    invalidate: (refreshToken) => void cache.delete(tokenHash(refreshToken)),
  }
}
