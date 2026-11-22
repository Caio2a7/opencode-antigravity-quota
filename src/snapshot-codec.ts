import type { BucketId, PoolSummary, QuotaBucket, QuotaSnapshot, SnapshotSource } from "./types"

const BUCKET_IDS: readonly string[] = ["gemini_5h", "gemini_weekly", "gemini_argon"]
const SOURCES: readonly string[] = ["antigravity", "gemini-cli", "cached"]

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isNonNegInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0
const isBucketId = (value: unknown): value is BucketId => typeof value === "string" && BUCKET_IDS.includes(value)
const isSource = (value: unknown): value is SnapshotSource => typeof value === "string" && SOURCES.includes(value)

/** `undefined` marks an invalid value, `null` a legitimately absent one. */
function dateOrNull(value: unknown): Date | null | undefined {
  if (value === null) return null
  if (typeof value !== "string") return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const stringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined

function reviveBucket(value: unknown): QuotaBucket | null {
  if (!isObject(value) || !isBucketId(value.id) || typeof value.label !== "string") return null
  const resetsAt = dateOrNull(value.resetsAt)
  if (!isFiniteNumber(value.utilization) || !isFiniteNumber(value.remaining) || !isNonNegInt(value.modelCount) || resetsAt === undefined) {
    return null
  }
  return { id: value.id, label: value.label, utilization: value.utilization, remaining: value.remaining, resetsAt, modelCount: value.modelCount }
}

function revivePool(value: unknown): PoolSummary | null | undefined {
  if (value === null) return null
  if (!isObject(value)) return undefined
  const { total, enabled, geminiReady } = value
  if (!isNonNegInt(total) || !isNonNegInt(enabled) || !isNonNegInt(geminiReady)) {
    return undefined
  }
  return { total, enabled, geminiReady }
}

function reviveList<T>(value: unknown, revive: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const items = value.map(revive)
  return items.every((item): item is Exclude<T, null> => item !== null) ? (items as T[]) : null
}

/** Rebuilds a snapshot from untrusted JSON (dates as ISO strings); `null` when any part is malformed. */
export function reviveSnapshot(value: unknown): QuotaSnapshot | null {
  if (!isObject(value) || !isSource(value.source)) return null
  const accountEmail = stringOrNull(value.accountEmail)
  const buckets = reviveList(value.buckets, reviveBucket)
  const pool = revivePool(value.pool)
  const fetchedAt = dateOrNull(value.fetchedAt)
  if (accountEmail === undefined || !buckets || pool === undefined || !fetchedAt) return null
  return { accountEmail, source: value.source, buckets, pool, fetchedAt }
}
