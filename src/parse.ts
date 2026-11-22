import type { BucketId, PoolSummary, QuotaBucket, QuotaSnapshot, SnapshotSource } from "./types"

export class QuotaParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuotaParseError"
  }
}

export interface SnapshotMeta {
  accountEmail: string | null
  pool: PoolSummary | null
  source?: SnapshotSource
  fetchedAt?: Date
}

const DAY_MS = 24 * 60 * 60_000

const BUCKET_ORDER: ReadonlyArray<readonly [BucketId, string]> = [
  ["gemini_5h", "Gemini-5h"],
  ["gemini_weekly", "Gemini-Week"],
  ["gemini_argon", "Argon"],
]

const CACHED_KEY_MAP: Readonly<Record<string, BucketId>> = {
  "gemini-5h": "gemini_5h",
  gemini_5h: "gemini_5h",
  gemini: "gemini_5h",
  "gemini-pro": "gemini_5h",
  gemini_pro: "gemini_5h",
  "gemini-flash": "gemini_5h",
  gemini_flash: "gemini_5h",
  "gemini-weekly": "gemini_weekly",
  gemini_weekly: "gemini_weekly",
  "gemini-argon": "gemini_argon",
  gemini_argon: "gemini_argon",
  argon: "gemini_argon",
}

type Obj = Record<string, unknown>

interface BucketAccumulator {
  remainingFraction: number
  resetsAt: Date | null
  modelCount: number
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Proto3 omits float 0.0; when quotaInfo is present without remainingFraction, 0% remains. */
export function normalizeRemainingFraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function classifyBucket(modelId: string, displayName?: string): BucketId | null {
  const idLower = modelId.toLowerCase()
  if (idLower.startsWith("tab_")) return null
  const combined = `${idLower} ${(displayName ?? "").toLowerCase()}`
  if (combined.includes("claude") || combined.includes("gpt")) return null
  if (!combined.includes("gemini")) return null
  return combined.includes("argon") ? "gemini_argon" : "gemini_5h"
}

export const classifyModel = classifyBucket

function classifySummaryBucket(bucketId: unknown, window: unknown): BucketId | null {
  if (typeof bucketId !== "string" || bucketId.trim() === "") return null
  const id = bucketId.trim().toLowerCase()
  if (id.startsWith("3p-") || id.includes("claude") || id.includes("gpt")) return null
  if (id.includes("argon")) return "gemini_argon"
  const win = typeof window === "string" ? window.trim().toLowerCase() : ""
  if (id === "gemini-5h" || (id.startsWith("gemini-") && win === "5h")) return "gemini_5h"
  if (id === "gemini-weekly" || (id.startsWith("gemini-") && win === "weekly")) return "gemini_weekly"
  return null
}

function resolveModelWindowBucket(bucketId: BucketId, resetsAt: Date | null, now: Date): BucketId {
  if (bucketId === "gemini_argon") return "gemini_argon"
  return resetsAt !== null && resetsAt.getTime() - now.getTime() > DAY_MS ? "gemini_weekly" : "gemini_5h"
}

function accumulate(map: Map<BucketId, BucketAccumulator>, id: BucketId, remainingFraction: number, resetsAt: Date | null, count = 1): void {
  const prev = map.get(id)
  if (!prev) {
    map.set(id, { remainingFraction, resetsAt, modelCount: count })
    return
  }
  prev.modelCount += count
  if (remainingFraction < prev.remainingFraction) {
    prev.remainingFraction = remainingFraction
    prev.resetsAt = resetsAt
  } else if (remainingFraction === prev.remainingFraction && resetsAt !== null) {
    if (prev.resetsAt === null || resetsAt.getTime() < prev.resetsAt.getTime()) {
      prev.resetsAt = resetsAt
    }
  }
}

function toOrderedBuckets(map: ReadonlyMap<BucketId, BucketAccumulator>): QuotaBucket[] {
  const out: QuotaBucket[] = []
  for (const [id, label] of BUCKET_ORDER) {
    const acc = map.get(id)
    if (!acc) continue
    const remaining = Math.min(100, Math.max(0, Math.round(acc.remainingFraction * 1000) / 10))
    const utilization = Math.min(100, Math.max(0, Math.round((100 - remaining) * 10) / 10))
    out.push({ id, label, utilization, remaining, resetsAt: acc.resetsAt, modelCount: acc.modelCount })
  }
  return out
}

export function parseQuotaSummaryResponse(payload: unknown, meta: SnapshotMeta, now: Date = meta.fetchedAt ?? new Date()): QuotaSnapshot {
  if (!isObj(payload) || !Array.isArray(payload.groups)) {
    throw new QuotaParseError("Quota summary response is missing `groups` array")
  }
  const acc = new Map<BucketId, BucketAccumulator>()
  for (const group of payload.groups) {
    if (!isObj(group) || !Array.isArray(group.buckets)) continue
    for (const bucket of group.buckets) {
      if (!isObj(bucket) || bucket.disabled === true) continue
      const bucketId = classifySummaryBucket(bucket.bucketId, bucket.window)
      if (!bucketId) continue
      accumulate(acc, bucketId, normalizeRemainingFraction(bucket.remainingFraction), parseIsoDate(bucket.resetTime))
    }
  }
  return {
    accountEmail: meta.accountEmail,
    source: meta.source ?? "antigravity",
    buckets: toOrderedBuckets(acc),
    pool: meta.pool,
    fetchedAt: now,
  }
}

export function parseAvailableModelsResponse(raw: unknown, meta: SnapshotMeta, now: Date = meta.fetchedAt ?? new Date()): QuotaSnapshot {
  if (!isObj(raw)) throw new QuotaParseError("Available models response is not a JSON object")
  if (raw.models !== undefined && !isObj(raw.models)) throw new QuotaParseError("Response field `models` is not an object")
  const models = isObj(raw.models) ? raw.models : {}
  const acc = new Map<BucketId, BucketAccumulator>()
  for (const [modelId, entry] of Object.entries(models)) {
    if (!isObj(entry) || entry.disabled === true || !isObj(entry.quotaInfo)) continue
    const labelHint = typeof entry.displayName === "string" ? entry.displayName : typeof entry.modelName === "string" ? entry.modelName : undefined
    const baseBucket = classifyBucket(modelId, labelHint)
    if (!baseBucket) continue
    const resetsAt = parseIsoDate(entry.quotaInfo.resetTime)
    const bucketId = resolveModelWindowBucket(baseBucket, resetsAt, now)
    accumulate(acc, bucketId, normalizeRemainingFraction(entry.quotaInfo.remainingFraction), resetsAt)
  }
  return {
    accountEmail: meta.accountEmail,
    source: meta.source ?? "antigravity",
    buckets: toOrderedBuckets(acc),
    pool: meta.pool,
    fetchedAt: now,
  }
}

export function parseRetrieveUserQuotaResponse(raw: unknown, meta: SnapshotMeta, now: Date = meta.fetchedAt ?? new Date()): QuotaSnapshot {
  if (!isObj(raw)) throw new QuotaParseError("Retrieve user quota response is not a JSON object")
  if (raw.buckets !== undefined && !Array.isArray(raw.buckets)) throw new QuotaParseError("Response field `buckets` is not an array")
  const items = Array.isArray(raw.buckets) ? raw.buckets : []
  const acc = new Map<BucketId, BucketAccumulator>()
  for (const item of items) {
    if (!isObj(item) || typeof item.modelId !== "string" || item.modelId.trim() === "") continue
    const baseBucket = classifyBucket(item.modelId)
    if (!baseBucket) continue
    const resetsAt = parseIsoDate(item.resetTime)
    const bucketId = resolveModelWindowBucket(baseBucket, resetsAt, now)
    accumulate(acc, bucketId, normalizeRemainingFraction(item.remainingFraction), resetsAt)
  }
  return {
    accountEmail: meta.accountEmail,
    source: meta.source ?? "gemini-cli",
    buckets: toOrderedBuckets(acc),
    pool: meta.pool,
    fetchedAt: now,
  }
}

export function parseCachedQuota(cachedQuota: unknown, meta: SnapshotMeta, updatedAt: Date): QuotaSnapshot | null {
  if (!isObj(cachedQuota)) return null
  const acc = new Map<BucketId, BucketAccumulator>()
  for (const [key, entry] of Object.entries(cachedQuota)) {
    const bucketId = CACHED_KEY_MAP[key.toLowerCase()]
    if (!bucketId || !isObj(entry)) continue
    const remainingFraction = normalizeRemainingFraction(entry.remainingFraction)
    const resetsAt = parseIsoDate(entry.remainingFractionResetTime) ?? parseIsoDate(entry.resetTime)
    const count = typeof entry.modelCount === "number" && Number.isInteger(entry.modelCount) && entry.modelCount > 0 ? entry.modelCount : 1
    accumulate(acc, bucketId, remainingFraction, resetsAt, count)
  }
  const buckets = toOrderedBuckets(acc)
  if (buckets.length === 0) return null
  return {
    accountEmail: meta.accountEmail,
    source: "cached",
    buckets,
    pool: meta.pool,
    fetchedAt: updatedAt,
  }
}
