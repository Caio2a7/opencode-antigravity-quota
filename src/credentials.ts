import { readFile as fsReadFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeRemainingFraction, parseCachedQuota, parseIsoDate } from "./parse"
import type { PoolSummary, QuotaSnapshot, ResolvedCredential } from "./types"

export interface CredentialDeps {
  env: Record<string, string | undefined>
  homeDir: string
  readFile: (path: string) => Promise<string>
  now: Date
  credentialsPath?: string
  platform?: NodeJS.Platform
}

interface RawAccount {
  refreshToken: string
  email: string | null
  projectId: string | null
  enabled: boolean
  userAgent: string | null
  cachedQuota: Record<string, unknown> | null
  cachedQuotaUpdatedAt: number | null
  rateLimitResetTimes: Record<string, unknown> | null
}

const EXPIRY_BUFFER_MS = 60_000
const MISSING_MSG = "Antigravity/Gemini credentials not found — log in via opencode-antigravity-auth or Gemini CLI"
const INVALID_MSG = "Antigravity/Gemini credentials file is unreadable or malformed"
const EXPIRED_GEMINI_MSG = "Gemini CLI token expired — run `gemini` once to refresh it"
const EXPIRED_CLI_MSG = "Antigravity CLI token expired and has no refresh token — log in again"

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

export function defaultCredentialDeps(): CredentialDeps {
  return {
    env: process.env,
    homeDir: homedir(),
    readFile: (p) => fsReadFile(p, "utf8"),
    now: new Date(),
    platform: process.platform,
  }
}

export function accountCandidatePaths(env: Record<string, string | undefined>, homeDir: string, platform?: NodeJS.Platform): string[] {
  const override = nonEmpty(env.OPENCODE_CONFIG_DIR)
  const xdg = nonEmpty(env.XDG_CONFIG_HOME) ?? join(homeDir, ".config")
  const primary = join(override ?? join(xdg, "opencode"), "antigravity-accounts.json")
  if (platform !== "win32") return [primary]
  const appData = nonEmpty(env.APPDATA) ?? join(homeDir, "AppData", "Roaming")
  const legacy = join(appData, "opencode", "antigravity-accounts.json")
  return legacy === primary ? [primary] : [primary, legacy]
}

export const antigravityCliTokenPath = (homeDir: string): string => join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token")
export const geminiCliCredsPath = (homeDir: string): string => join(homeDir, ".gemini", "oauth_creds.json")

function parseExpiry(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1e11 ? value : value * 1000)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return parseIsoDate(value)
}

const isTokenFresh = (expiry: Date | null, now: Date): boolean =>
  expiry !== null && expiry.getTime() > now.getTime() + EXPIRY_BUFFER_MS

function parseRawAccount(item: unknown): RawAccount | null {
  if (!isObj(item)) return null
  const refreshToken = nonEmpty(item.refreshToken)
  if (!refreshToken) return null
  const fp = isObj(item.fingerprint) ? item.fingerprint : null
  const updatedAt = typeof item.cachedQuotaUpdatedAt === "number" && Number.isFinite(item.cachedQuotaUpdatedAt) ? item.cachedQuotaUpdatedAt : null
  return {
    refreshToken,
    email: nonEmpty(item.email),
    projectId: nonEmpty(item.managedProjectId) ?? nonEmpty(item.projectId),
    enabled: item.enabled !== false,
    userAgent: fp ? nonEmpty(fp.userAgent) : null,
    cachedQuota: isObj(item.cachedQuota) ? item.cachedQuota : null,
    cachedQuotaUpdatedAt: updatedAt,
    rateLimitResetTimes: isObj(item.rateLimitResetTimes) ? item.rateLimitResetTimes : null,
  }
}

function selectActiveAccount(raw: Obj, accounts: readonly RawAccount[]): RawAccount | null {
  const byIdx = (idx: unknown): RawAccount | null => {
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= accounts.length) return null
    const acc = accounts[idx]
    return acc && acc.enabled ? acc : null
  }
  const byFamily = isObj(raw.activeIndexByFamily) ? raw.activeIndexByFamily : null
  return byIdx(raw.activeIndex) ?? byIdx(byFamily?.gemini) ?? accounts.find((a) => a.enabled) ?? accounts[0] ?? null
}

function isGroupReady(group: unknown, nowMs: number): boolean {
  if (!isObj(group)) return true
  if (normalizeRemainingFraction(group.remainingFraction) > 0) return true
  const reset = parseIsoDate(group.remainingFractionResetTime) ?? parseIsoDate(group.resetTime)
  return reset !== null && reset.getTime() <= nowMs
}

function isGeminiReady(acc: RawAccount, nowMs: number): boolean {
  if (!acc.cachedQuota) {
    const rl = acc.rateLimitResetTimes?.["gemini-antigravity"] ?? acc.rateLimitResetTimes?.gemini
    return !(typeof rl === "number" && Number.isFinite(rl) && rl > nowMs)
  }
  const keys = ["gemini", "gemini-pro", "gemini_pro", "gemini-flash", "gemini_flash", "gemini-argon", "gemini_argon", "argon"]
  const entries = keys.map((k) => acc.cachedQuota?.[k]).filter(isObj)
  return entries.length === 0 ? true : entries.some((entry) => isGroupReady(entry, nowMs))
}

function computePool(accounts: readonly RawAccount[], nowMs: number): PoolSummary | null {
  const enabledList = accounts.filter((a) => a.enabled)
  if (enabledList.length <= 1) return null
  let geminiReady = 0
  for (const acc of enabledList) {
    if (isGeminiReady(acc, nowMs)) geminiReady += 1
  }
  return { total: accounts.length, enabled: enabledList.length, geminiReady }
}

/** Extracts the active account email from parsed `antigravity-accounts.json` or `antigravity-oauth-token`. */
export function extractActiveAccountEmailFromJson(parsed: unknown): string | null {
  if (!isObj(parsed)) return null
  if (Array.isArray(parsed.accounts)) {
    const accounts = parsed.accounts.map(parseRawAccount).filter((a): a is RawAccount => a !== null)
    return selectActiveAccount(parsed, accounts)?.email ?? null
  }
  if (isObj(parsed.token)) return nonEmpty(parsed.id_token_email)
  return null
}

async function tryReadJson(deps: CredentialDeps, path: string): Promise<{ found: boolean; data: unknown }> {
  let content: string
  try {
    content = await deps.readFile(path)
  } catch {
    return { found: false, data: undefined }
  }
  try {
    return { found: true, data: JSON.parse(content) as unknown }
  } catch {
    return { found: true, data: undefined }
  }
}

async function lookupReusableCliToken(deps: CredentialDeps, email: string | null): Promise<{ token: string; expiresAt: Date } | null> {
  if (!email) return null
  const { data } = await tryReadJson(deps, antigravityCliTokenPath(deps.homeDir))
  if (!isObj(data) || !isObj(data.token)) return null
  const cliEmail = nonEmpty(data.id_token_email)
  if (!cliEmail || cliEmail.toLowerCase() !== email.toLowerCase()) return null
  const accessToken = nonEmpty(data.token.access_token)
  const expiry = parseExpiry(data.token.expiry)
  return accessToken && isTokenFresh(expiry, deps.now) && expiry ? { token: accessToken, expiresAt: expiry } : null
}

type OkCred = Extract<ResolvedCredential, { ok: true }>

function okCred(source: OkCred["source"], apiKind: OkCred["apiKind"], fields: Partial<Omit<OkCred, "ok" | "source" | "apiKind">>): OkCred {
  return {
    ok: true,
    source,
    apiKind,
    accessToken: fields.accessToken ?? null,
    accessTokenExpiresAt: fields.accessTokenExpiresAt ?? null,
    refreshToken: fields.refreshToken ?? null,
    email: fields.email ?? null,
    projectId: fields.projectId ?? null,
    userAgent: fields.userAgent ?? null,
    pool: fields.pool ?? null,
    cachedFallback: fields.cachedFallback ?? null,
  }
}

async function interpretAccountsFile(parsed: Obj, deps: CredentialDeps): Promise<ResolvedCredential | null> {
  if (!Array.isArray(parsed.accounts)) return null
  const accounts = parsed.accounts.map(parseRawAccount).filter((a): a is RawAccount => a !== null)
  const active = selectActiveAccount(parsed, accounts)
  if (!active) return null
  const pool = computePool(accounts, deps.now.getTime())
  const reusable = await lookupReusableCliToken(deps, active.email)
  const updatedAt = active.cachedQuotaUpdatedAt !== null ? new Date(active.cachedQuotaUpdatedAt) : deps.now
  const cachedFallback: QuotaSnapshot | null = active.cachedQuota
    ? parseCachedQuota(active.cachedQuota, { accountEmail: active.email, pool }, updatedAt)
    : null
  return okCred("antigravity-accounts", "antigravity", {
    accessToken: reusable?.token ?? null,
    accessTokenExpiresAt: reusable?.expiresAt ?? null,
    refreshToken: active.refreshToken,
    email: active.email,
    projectId: active.projectId,
    userAgent: active.userAgent,
    pool,
    cachedFallback,
  })
}

function interpretAntigravityCli(parsed: Obj, now: Date): ResolvedCredential {
  if (!isObj(parsed.token)) return { ok: false, reason: "invalid", message: INVALID_MSG }
  const access = nonEmpty(parsed.token.access_token)
  const refresh = nonEmpty(parsed.token.refresh_token)
  const expiry = parseExpiry(parsed.token.expiry)
  const freshAccess = access && isTokenFresh(expiry, now) ? access : null
  if (!freshAccess && !refresh) return { ok: false, reason: access ? "expired" : "invalid", message: access ? EXPIRED_CLI_MSG : INVALID_MSG }
  return okCred("antigravity-cli", "antigravity", {
    accessToken: freshAccess,
    accessTokenExpiresAt: freshAccess ? expiry : null,
    refreshToken: refresh,
    email: nonEmpty(parsed.id_token_email),
  })
}

function interpretGeminiCli(parsed: Obj, now: Date): ResolvedCredential {
  const access = nonEmpty(parsed.access_token)
  if (!access) return { ok: false, reason: "invalid", message: INVALID_MSG }
  const expiry = parseExpiry(parsed.expiry_date)
  if (!isTokenFresh(expiry, now)) return { ok: false, reason: "expired", message: EXPIRED_GEMINI_MSG }
  return okCred("gemini-cli", "gemini-cli", {
    accessToken: access,
    accessTokenExpiresAt: expiry,
    refreshToken: nonEmpty(parsed.refresh_token),
    projectId: nonEmpty(parsed.project_id),
  })
}

async function resolveExplicitFile(path: string, deps: CredentialDeps): Promise<ResolvedCredential> {
  const { found, data } = await tryReadJson(deps, path)
  if (!found) return { ok: false, reason: "missing", message: `Credentials file not found at ${path}` }
  if (!isObj(data)) return { ok: false, reason: "invalid", message: INVALID_MSG }
  if (Array.isArray(data.accounts)) {
    return (await interpretAccountsFile(data, deps)) ?? { ok: false, reason: "invalid", message: INVALID_MSG }
  }
  if (isObj(data.token)) return interpretAntigravityCli(data, deps.now)
  if (typeof data.access_token === "string" || typeof data.refresh_token === "string") {
    return interpretGeminiCli(data, deps.now)
  }
  return { ok: false, reason: "invalid", message: INVALID_MSG }
}

function envCredential(env: Record<string, string | undefined>): ResolvedCredential | null {
  const accessToken = nonEmpty(env.ANTIGRAVITY_OAUTH_TOKEN)
  return accessToken ? okCred("env", "antigravity", { accessToken, projectId: nonEmpty(env.ANTIGRAVITY_PROJECT_ID) }) : null
}

async function resolveAccountsFromDefaultPaths(deps: CredentialDeps): Promise<ResolvedCredential | null> {
  for (const path of accountCandidatePaths(deps.env, deps.homeDir, deps.platform)) {
    const { data } = await tryReadJson(deps, path)
    if (isObj(data)) {
      const resolved = await interpretAccountsFile(data, deps)
      if (resolved) return resolved
    }
  }
  return null
}

/** Read-only credential lookup across env, explicit path, antigravity-accounts, antigravity-cli, and gemini-cli. */
export async function resolveCredentials(deps: CredentialDeps): Promise<ResolvedCredential> {
  const fromEnv = envCredential(deps.env)
  if (fromEnv) return fromEnv
  if (deps.credentialsPath) return resolveExplicitFile(deps.credentialsPath, deps)

  const fromAccounts = await resolveAccountsFromDefaultPaths(deps)
  if (fromAccounts) return fromAccounts

  const cli = await tryReadJson(deps, antigravityCliTokenPath(deps.homeDir))
  if (isObj(cli.data) && isObj(cli.data.token)) {
    const cliResult = interpretAntigravityCli(cli.data, deps.now)
    if (cliResult.ok) return cliResult
  }

  const gemini = await tryReadJson(deps, geminiCliCredsPath(deps.homeDir))
  if (isObj(gemini.data)) return interpretGeminiCli(gemini.data, deps.now)

  return { ok: false, reason: "missing", message: MISSING_MSG }
}
