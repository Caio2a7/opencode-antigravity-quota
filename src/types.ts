export type BucketId = "gemini_5h" | "gemini_weekly" | "gemini_argon"

export interface QuotaBucket {
  id: BucketId
  label: string
  utilization: number
  remaining: number
  resetsAt: Date | null
  modelCount: number
}

export interface PoolSummary {
  total: number
  enabled: number
  geminiReady: number
}

export type SnapshotSource = "antigravity" | "gemini-cli" | "cached"

export interface QuotaSnapshot {
  accountEmail: string | null
  source: SnapshotSource
  buckets: QuotaBucket[]
  pool: PoolSummary | null
  fetchedAt: Date
}

export type Severity = "ok" | "warn" | "high" | "critical"
export type FetchErrorKind = "network" | "unauthorized" | "rate_limited" | "http" | "parse"
export type FetchResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; kind: FetchErrorKind; message: string; retryAfterMs?: number }

export type CredentialSource = "env" | "antigravity-accounts" | "antigravity-cli" | "gemini-cli"
export type ApiKind = "antigravity" | "gemini-cli"

export type ResolvedCredential =
  | {
      ok: true
      source: CredentialSource
      apiKind: ApiKind
      accessToken: string | null
      accessTokenExpiresAt: Date | null
      refreshToken: string | null
      email: string | null
      projectId: string | null
      userAgent: string | null
      pool: PoolSummary | null
      cachedFallback: QuotaSnapshot | null
    }
  | {
      ok: false
      reason: "missing" | "invalid" | "expired"
      message: string
    }
