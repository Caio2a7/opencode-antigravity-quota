import { createHash } from "node:crypto"
import {
  parseAvailableModelsResponse,
  parseQuotaSummaryResponse,
  parseRetrieveUserQuotaResponse,
  type SnapshotMeta,
} from "./parse"
import type { FetchErrorKind, FetchResult, PoolSummary } from "./types"

export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
export const ANTIGRAVITY_QUOTA_SUMMARY_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`
export const ANTIGRAVITY_MODELS_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`
export const ANTIGRAVITY_LOAD_CODE_ASSIST_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`
export const ANTIGRAVITY_RETRIEVE_QUOTA_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuota`
export const GEMINI_CLI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"

export const DEFAULT_ANTIGRAVITY_USER_AGENT = "antigravity/hub/2.34.0 (aidev_client; os_type=darwin; arch=arm64)"
export const GEMINI_CLI_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RETRY_MS = 60 * 60_000
const MAX_PROJECT_CACHE = 64
const defaultProjectCache = new Map<string, string>()

export interface BaseFetchOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => Date
  accountEmail?: string | null
  pool?: PoolSummary | null
  projectId?: string | null
}

export interface AntigravityFetchOptions extends BaseFetchOptions {
  userAgent?: string | null
  projectCache?: Map<string, string>
}

export interface DiscoverProjectOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string | null
  accountEmail?: string | null
  projectCache?: Map<string, string>
}

function retryAfterMs(header: string | null): number | undefined {
  const seconds = header === null ? NaN : Number(header.trim())
  return header !== null && header.trim() !== "" && Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_MS)
    : undefined
}

function failure(kind: FetchErrorKind, message: string, retryMs?: number): FetchResult {
  return retryMs === undefined ? { ok: false, kind, message } : { ok: false, kind, message, retryAfterMs: retryMs }
}

function statusFailure(res: Response, label: string): FetchResult {
  if (res.status === 401 || res.status === 403) {
    return failure("unauthorized", `${label} rejected the token (HTTP ${res.status}) — re-authenticate your account`)
  }
  if (res.status === 429) {
    return failure("rate_limited", `${label} endpoint rate limited (HTTP 429)`, retryAfterMs(res.headers.get("retry-after")))
  }
  return failure("http", `${label} endpoint returned HTTP ${res.status}`)
}

function networkFailure(err: unknown): FetchResult {
  const reason = err instanceof Error && err.name === "AbortError" ? "request timed out" : "request failed"
  return failure("network", `Network error: ${reason}`)
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: { fetchFn: typeof fetch; timeoutMs: number },
): Promise<Response | string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await opts.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return res.ok ? await res.text() : res
  } finally {
    clearTimeout(timer)
  }
}

function extractProjectId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as { cloudaicompanionProject?: unknown }).cloudaicompanionProject
  const raw = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as { id?: unknown }).id : null
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
}

function projectCacheKey(accessToken: string, email: string | null | undefined): string {
  if (email && email.trim() !== "") return `email:${email.trim().toLowerCase()}`
  return `tok:${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`
}

/** Resolves `cloudaicompanionProject` via `loadCodeAssist` and caches it in memory. Never throws. */
export async function discoverProjectId(accessToken: string, opts: DiscoverProjectOptions = {}): Promise<string | null> {
  const cache = opts.projectCache ?? defaultProjectCache
  const key = projectCacheKey(accessToken, opts.accountEmail)
  const cached = cache.get(key)
  if (cached) return cached
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": opts.userAgent?.trim() || DEFAULT_ANTIGRAVITY_USER_AGENT,
  }
  try {
    const outcome = await postJson(
      ANTIGRAVITY_LOAD_CODE_ASSIST_URL,
      headers,
      { metadata: { ideType: "ANTIGRAVITY" } },
      { fetchFn: opts.fetch ?? fetch, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    )
    if (typeof outcome !== "string") return null
    const id = extractProjectId(JSON.parse(outcome))
    if (id) {
      cache.set(key, id)
      if (cache.size > MAX_PROJECT_CACHE) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    }
    return id
  } catch {
    return null
  }
}

async function callAndParse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  label: string,
  parse: (raw: unknown) => FetchResult,
  opts: { fetchFn: typeof fetch; timeoutMs: number },
): Promise<FetchResult> {
  let outcome: Response | string
  try {
    outcome = await postJson(url, headers, body, opts)
  } catch (err) {
    return networkFailure(err)
  }
  if (typeof outcome !== "string") return statusFailure(outcome, label)
  try {
    return parse(JSON.parse(outcome))
  } catch {
    return failure("parse", `Unexpected response from the ${label} endpoint`)
  }
}

const TERMINAL_SUMMARY_ERRORS: ReadonlySet<FetchErrorKind> = new Set(["unauthorized", "rate_limited", "network"])

async function fetchAntigravityLegacy(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  meta: SnapshotMeta,
  now: () => Date,
  reqOpts: { fetchFn: typeof fetch; timeoutMs: number },
): Promise<FetchResult> {
  const models = await callAndParse(
    ANTIGRAVITY_MODELS_URL,
    headers,
    body,
    "Antigravity quota",
    (raw) => ({ ok: true, snapshot: parseAvailableModelsResponse(raw, meta, now()) }),
    reqOpts,
  )
  if (!models.ok || models.snapshot.buckets.length > 0) return models
  const fallback = await callAndParse(
    ANTIGRAVITY_RETRIEVE_QUOTA_URL,
    headers,
    body,
    "Antigravity quota",
    (raw) => ({ ok: true, snapshot: parseRetrieveUserQuotaResponse(raw, meta, now()) }),
    reqOpts,
  )
  return fallback.ok ? fallback : models
}

/** Fetches Antigravity quota via `retrieveUserQuotaSummary`, falling back to `fetchAvailableModels` -> `retrieveUserQuota`. */
export async function fetchAntigravityQuota(accessToken: string, opts: AntigravityFetchOptions = {}): Promise<FetchResult> {
  const fetchFn = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? (() => new Date())
  const userAgent = opts.userAgent?.trim() || DEFAULT_ANTIGRAVITY_USER_AGENT
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  }
  const projectId = opts.projectId?.trim() || (await discoverProjectId(accessToken, {
    fetch: fetchFn,
    timeoutMs,
    userAgent,
    accountEmail: opts.accountEmail,
    projectCache: opts.projectCache,
  }))
  const body: Record<string, unknown> = projectId ? { project: projectId } : {}
  const meta: SnapshotMeta = { accountEmail: opts.accountEmail ?? null, pool: opts.pool ?? null, source: "antigravity" }
  const reqOpts = { fetchFn, timeoutMs }

  const summary = await callAndParse(
    ANTIGRAVITY_QUOTA_SUMMARY_URL,
    headers,
    body,
    "Antigravity quota",
    (raw) => ({ ok: true, snapshot: parseQuotaSummaryResponse(raw, meta, now()) }),
    reqOpts,
  )
  if (summary.ok && summary.snapshot.buckets.length > 0) return summary
  if (!summary.ok && TERMINAL_SUMMARY_ERRORS.has(summary.kind)) return summary
  return fetchAntigravityLegacy(headers, body, meta, now, reqOpts)
}

/** Fetches Gemini CLI quota via production `retrieveUserQuota`. Never throws. */
export async function fetchGeminiCliQuota(accessToken: string, opts: BaseFetchOptions = {}): Promise<FetchResult> {
  const fetchFn = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? (() => new Date())
  const headers = {
    ...GEMINI_CLI_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  }
  const projectId = opts.projectId?.trim() || null
  const body: Record<string, unknown> = projectId ? { project: projectId } : {}
  const meta: SnapshotMeta = { accountEmail: opts.accountEmail ?? null, pool: opts.pool ?? null, source: "gemini-cli" }

  return callAndParse(
    GEMINI_CLI_QUOTA_URL,
    headers,
    body,
    "Gemini CLI quota",
    (raw) => ({ ok: true, snapshot: parseRetrieveUserQuotaResponse(raw, meta, now()) }),
    { fetchFn, timeoutMs },
  )
}
