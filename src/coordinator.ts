import type { LoadRequest, LoadResult } from "./poller"
import { STATE_VERSION, type SharedState, type SharedStore } from "./shared-state"
import type { FetchErrorKind, QuotaSnapshot } from "./types"

export const BACKOFF_BASE_MS = 2 * 60_000
export const BACKOFF_MAX_MS = 30 * 60_000
export const LOCK_RETRY_MS = 3_000
const MIN_ADOPT_DELAY_MS = 5_000
const LOCAL_BACKOFF_MAX_MS = 10 * 60_000
/** Failures shared with every instance, since they stem from the endpoint or the network, not from this process. */
const SHARED_KINDS: ReadonlySet<string> = new Set<FetchErrorKind | string>(["network", "http", "rate_limited"])

export interface CoordinatorOptions {
  store: SharedStore
  /** Resolves credentials and performs one real request. */
  fetchOnce: () => Promise<LoadResult>
  intervalMs: number
  now: () => number
  /** When provided, cached snapshots from a different active account are ignored. */
  expectedAccountEmail?: () => string | null
}

export const backoffMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))

function matchesExpectedAccount(snapshot: QuotaSnapshot | null, expected: string | null): boolean {
  if (!snapshot) return false
  if (expected === null) return true
  return snapshot.accountEmail !== null && snapshot.accountEmail.toLowerCase() === expected.toLowerCase()
}

function resolveExpected(o: CoordinatorOptions): string | null {
  try {
    return o.expectedAccountEmail ? o.expectedAccountEmail() : null
  } catch {
    return null
  }
}

function blocked(state: SharedState, remainingMs: number, expected: string | null): LoadResult {
  const base = {
    ok: false as const,
    kind: state.lastError?.kind ?? "rate_limited",
    message: state.lastError?.message ?? "Antigravity quota endpoint rate limited (HTTP 429)",
    retryAfterMs: remainingMs,
    nextInMs: remainingMs,
  }
  return matchesExpectedAccount(state.snapshot, expected) && state.snapshot ? { ...base, snapshot: state.snapshot } : base
}

/** The result for an up-to-date shared state, or `null` when a request is due. */
function fromShared(o: CoordinatorOptions, state: SharedState, req: LoadRequest): LoadResult | null {
  const now = o.now()
  const expected = resolveExpected(o)
  const accountMismatch = state.snapshot !== null && !matchesExpectedAccount(state.snapshot, expected)
  if (state.blockedUntil > now && !accountMismatch) return blocked(state, state.blockedUntil - now, expected)
  if (!state.snapshot || state.fetchedAt === null || accountMismatch) return null
  const age = now - state.fetchedAt
  if (age >= req.maxAgeMs) return null
  return { ok: true, snapshot: state.snapshot, nextInMs: Math.max(MIN_ADOPT_DELAY_MS, o.intervalMs - age) }
}

function waiting(state: SharedState, expected: string | null): LoadResult {
  if (matchesExpectedAccount(state.snapshot, expected) && state.snapshot) {
    return { ok: true, snapshot: state.snapshot, nextInMs: LOCK_RETRY_MS }
  }
  return { ok: false, kind: "internal", message: "Waiting for another OpenCode window…", nextInMs: LOCK_RETRY_MS }
}

function keepSnapshot(result: LoadResult, snapshot: QuotaSnapshot | null, expected: string | null): LoadResult {
  return matchesExpectedAccount(snapshot, expected) && snapshot && !result.ok ? { ...result, snapshot } : result
}

/**
 * Wraps a loader so that any number of OpenCode instances share one request per interval: fresh data is adopted from
 * the cache file, a lock keeps a single instance fetching, and failure backoff is persisted for everyone.
 */
export function createCoordinator(o: CoordinatorOptions): (req: LoadRequest) => Promise<LoadResult> {
  let localFailures = 0

  async function fetchAndPersist(prior: SharedState): Promise<LoadResult> {
    const result = await o.fetchOnce()
    const expected = resolveExpected(o)
    if (result.ok) {
      localFailures = 0
      const fetchedAt = result.snapshot.fetchedAt.getTime()
      o.store.write({ version: STATE_VERSION, snapshot: result.snapshot, fetchedAt, blockedUntil: 0, consecutiveFailures: 0, lastError: null })
      return { ...result, nextInMs: o.intervalMs }
    }
    if (SHARED_KINDS.has(result.kind)) {
      const failures = prior.consecutiveFailures + 1
      const delay = result.kind === "rate_limited" && result.retryAfterMs ? result.retryAfterMs : backoffMs(failures)
      const lastError = { kind: result.kind as FetchErrorKind, message: result.message }
      o.store.write({ ...prior, consecutiveFailures: failures, blockedUntil: o.now() + delay, lastError })
      return keepSnapshot({ ...result, retryAfterMs: delay, nextInMs: delay }, prior.snapshot, expected)
    }
    localFailures = result.kind === "unauthorized" ? localFailures + 1 : 0
    const delay = Math.min(LOCAL_BACKOFF_MAX_MS, o.intervalMs * 2 ** Math.max(0, localFailures - 1))
    return keepSnapshot({ ...result, nextInMs: delay }, prior.snapshot, expected)
  }

  return async (req) => {
    const early = fromShared(o, o.store.read(), req)
    if (early) return early
    const release = o.store.tryLock()
    if (!release) return waiting(o.store.read(), resolveExpected(o))
    try {
      const current = o.store.read()
      return fromShared(o, current, req) ?? (await fetchAndPersist(current))
    } finally {
      release()
    }
  }
}
