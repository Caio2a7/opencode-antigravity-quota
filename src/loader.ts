import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { fetchAntigravityQuota, fetchGeminiCliQuota } from "./api"
import {
  accountCandidatePaths,
  antigravityCliTokenPath,
  defaultCredentialDeps,
  extractActiveAccountEmailFromJson,
  resolveCredentials,
  type CredentialDeps,
} from "./credentials"
import { createTokenExchanger, type TokenExchanger } from "./oauth"
import type { LoadResult } from "./poller"
import type { FetchResult, ResolvedCredential } from "./types"

const EXPIRY_BUFFER_MS = 60_000

export interface LoaderDeps {
  credentialDeps?: () => CredentialDeps
  exchanger?: TokenExchanger
  fetchAntigravity?: typeof fetchAntigravityQuota
  fetchGeminiCli?: typeof fetchGeminiCliQuota
  now?: () => Date
}

export interface ReadEmailDeps {
  env?: Record<string, string | undefined>
  homeDir?: string
  platform?: NodeJS.Platform
  readFileSync?: (path: string) => string
}

function tryReadEmail(read: (path: string) => string, path: string): string | null {
  try {
    return extractActiveAccountEmailFromJson(JSON.parse(read(path)))
  } catch {
    return null
  }
}

/** Lightweight synchronous read-only lookup of the active account email for cache invalidation on account switches. */
export function readActiveAccountEmail(credentialsPath?: string, deps: ReadEmailDeps = {}): string | null {
  const env = deps.env ?? process.env
  if (env.ANTIGRAVITY_OAUTH_TOKEN?.trim()) return null
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, "utf8"))
  if (credentialsPath) return tryReadEmail(read, credentialsPath)
  const home = deps.homeDir ?? homedir()
  const platform = deps.platform ?? process.platform
  for (const path of accountCandidatePaths(env, home, platform)) {
    const email = tryReadEmail(read, path)
    if (email) return email
  }
  return tryReadEmail(read, antigravityCliTokenPath(home))
}

function hasFreshToken(cred: Extract<ResolvedCredential, { ok: true }>, now: Date): cred is Extract<ResolvedCredential, { ok: true }> & { accessToken: string } {
  if (!cred.accessToken) return false
  return cred.accessTokenExpiresAt === null || cred.accessTokenExpiresAt.getTime() > now.getTime() + EXPIRY_BUFFER_MS
}

async function fetchWithToken(
  cred: Extract<ResolvedCredential, { ok: true }>,
  accessToken: string,
  deps: { fetchAntigravity: typeof fetchAntigravityQuota; fetchGeminiCli: typeof fetchGeminiCliQuota; now: () => Date },
): Promise<FetchResult> {
  if (cred.apiKind === "gemini-cli") {
    return deps.fetchGeminiCli(accessToken, {
      projectId: cred.projectId,
      accountEmail: cred.email,
      pool: cred.pool,
      now: deps.now,
    })
  }
  return deps.fetchAntigravity(accessToken, {
    projectId: cred.projectId,
    userAgent: cred.userAgent,
    accountEmail: cred.email,
    pool: cred.pool,
    now: deps.now,
  })
}

async function resolveAccessTokenForRequest(
  cred: Extract<ResolvedCredential, { ok: true }>,
  exchanger: TokenExchanger,
  now: Date,
): Promise<{ ok: true; token: string; fromRefresh: boolean } | LoadResult> {
  if (hasFreshToken(cred, now)) return { ok: true, token: cred.accessToken, fromRefresh: false }
  if (!cred.refreshToken) {
    return { ok: false, kind: "credentials", message: "Antigravity access token expired and no refresh token available" }
  }
  const exchanged = await exchanger.exchange(cred.refreshToken)
  if (exchanged.ok) return { ok: true, token: exchanged.accessToken, fromRefresh: true }
  if (exchanged.kind === "no_client" && cred.cachedFallback !== null) {
    return { ok: true, snapshot: cred.cachedFallback }
  }
  const kind = exchanged.kind === "no_client" ? "credentials" : exchanged.kind
  return exchanged.retryAfterMs === undefined
    ? { ok: false, kind, message: exchanged.message }
    : { ok: false, kind, message: exchanged.message, retryAfterMs: exchanged.retryAfterMs }
}

/** Builds the poller's loader: read-only credential resolution, in-memory OAuth exchange, and quota fetch. */
export function createLoader(credentialsPath?: string, deps: LoaderDeps = {}): () => Promise<LoadResult> {
  const exchanger = deps.exchanger ?? createTokenExchanger()
  const fetchAntigravity = deps.fetchAntigravity ?? fetchAntigravityQuota
  const fetchGeminiCli = deps.fetchGeminiCli ?? fetchGeminiCliQuota
  const now = deps.now ?? (() => new Date())
  const makeCredDeps = deps.credentialDeps ?? (() => defaultCredentialDeps())

  return async () => {
    try {
      const cred = await resolveCredentials({ ...makeCredDeps(), now: now(), credentialsPath })
      if (!cred.ok) return { ok: false, kind: "credentials", message: cred.message }
      const resolved = await resolveAccessTokenForRequest(cred, exchanger, now())
      if (!("token" in resolved)) return resolved
      const result = await fetchWithToken(cred, resolved.token, { fetchAntigravity, fetchGeminiCli, now })
      if (!result.ok && result.kind === "unauthorized" && cred.refreshToken) {
        exchanger.invalidate(cred.refreshToken)
        if (!resolved.fromRefresh) {
          const refreshed = await exchanger.exchange(cred.refreshToken)
          if (refreshed.ok) return await fetchWithToken(cred, refreshed.accessToken, { fetchAntigravity, fetchGeminiCli, now })
        }
      }
      return result
    } catch {
      return { ok: false, kind: "internal", message: "Unexpected error loading Antigravity quota" }
    }
  }
}
