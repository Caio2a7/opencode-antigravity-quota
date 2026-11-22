import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { backoffMs, BACKOFF_MAX_MS, createCoordinator, LOCK_RETRY_MS } from "../src/coordinator"
import { createPoller, type LoadResult, type Timers } from "../src/poller"
import { createSharedStore } from "../src/shared-state"
import type { QuotaSnapshot } from "../src/types"
import { createMemFs } from "./helpers/memfs"

const MIN = 60_000
const INTERVAL = 2 * MIN
const DIR = "/cache/agq"
const LOCK = join(DIR, "fetch.lock")

function world() {
  let t = 1_000_000_000_000
  const now = () => t
  const mem = createMemFs(now)
  const store = createSharedStore({ dir: DIR, fs: mem.fs, now })
  const queue: LoadResult[] = []
  let fetches = 0
  let gate: Promise<void> | null = null
  const fetchOnce = async (): Promise<LoadResult> => {
    fetches += 1
    if (gate) await gate
    return queue.shift() ?? { ok: false, kind: "internal", message: "queue empty" }
  }
  const snap = (remaining: number, accountEmail: string | null = "alice@example.com"): QuotaSnapshot => ({
    accountEmail,
    source: "antigravity",
    buckets: [{ id: "gemini_5h", label: "Gemini-5h", utilization: 100 - remaining, remaining, resetsAt: null, modelCount: 1 }],
    pool: null,
    fetchedAt: new Date(t),
  })
  const coordinator = (expectedAccountEmail?: () => string | null) =>
    createCoordinator({ store, fetchOnce, intervalMs: INTERVAL, now, expectedAccountEmail })
  return {
    store,
    mem,
    now,
    queue,
    coordinator,
    snap,
    fetches: () => fetches,
    advance: (ms: number) => (t += ms),
    hold: () => {
      let open!: () => void
      gate = new Promise<void>((r) => (open = r))
      return () => open()
    },
    ok: (remaining: number, email: string | null = "alice@example.com"): LoadResult => ({ ok: true, snapshot: snap(remaining, email) }),
  }
}

const rateLimited = (retryAfterMs?: number): LoadResult => ({ ok: false, kind: "rate_limited", message: "429", retryAfterMs })
const req = { maxAgeMs: INTERVAL }

describe("adoption and staleness", () => {
  test("second instance adopts fresh shared snapshot without fetching", async () => {
    const w = world()
    w.queue.push(w.ok(80))
    const a = w.coordinator()
    const b = w.coordinator()
    expect((await a(req)).ok).toBe(true)
    w.advance(30_000)
    const adopted = await b(req)
    expect(w.fetches()).toBe(1)
    expect(adopted.ok && adopted.snapshot.buckets[0]?.remaining).toBe(80)
    expect(adopted.nextInMs).toBe(INTERVAL - 30_000)
  })

  test("refetches once snapshot age reaches maxAgeMs", async () => {
    const w = world()
    w.queue.push(w.ok(80), w.ok(60))
    const load = w.coordinator()
    await load(req)
    w.advance(INTERVAL - 1)
    await load(req)
    expect(w.fetches()).toBe(1)
    w.advance(1)
    const third = await load(req)
    expect(w.fetches()).toBe(2)
    expect(third.ok && third.snapshot.buckets[0]?.remaining).toBe(60)
  })
})

describe("expectedAccountEmail invalidation", () => {
  test("switching active account ignores cached snapshot AND prior account backoff", async () => {
    const w = world()
    let activeEmail: string | null = "alice@example.com"
    w.queue.push(w.ok(90, "alice@example.com"), rateLimited(10 * MIN), w.ok(40, "bob@example.com"))
    const load = w.coordinator(() => activeEmail)

    await load(req)
    w.advance(INTERVAL)
    const blocked = await load(req)
    expect(!blocked.ok && blocked.kind).toBe("rate_limited")
    expect(w.store.read().blockedUntil).toBe(w.now() + 10 * MIN)

    // Switch active account to Bob while Alice's snapshot & block are still fresh
    activeEmail = "bob@example.com"
    const bobRes = await load(req)
    expect(w.fetches()).toBe(3)
    expect(bobRes.ok).toBe(true)
    if (bobRes.ok) {
      expect(bobRes.snapshot.accountEmail).toBe("bob@example.com")
      expect(bobRes.snapshot.buckets[0]?.remaining).toBe(40)
    }
  })

  test("matches expectedAccountEmail case-insensitively and hides mismatched snapshots on failure/wait", async () => {
    const w = world()
    w.queue.push(w.ok(75, "Alice@Example.com"))
    await w.coordinator(() => "alice@example.com")(req)

    w.advance(10_000)
    const adopted = await w.coordinator(() => "ALICE@EXAMPLE.COM")(req)
    expect(w.fetches()).toBe(1)
    expect(adopted.ok && adopted.snapshot.buckets[0]?.remaining).toBe(75)

    // Hold lock while Bob tries to read: Bob must NOT receive Alice's cached snapshot
    const open = w.hold()
    w.queue.push(w.ok(50, "bob@example.com"))
    const firstBob = w.coordinator(() => "bob@example.com")(req)
    const waitingBob = await w.coordinator(() => "bob@example.com")(req)
    expect(waitingBob.ok).toBe(false)
    expect(waitingBob.snapshot).toBeUndefined()
    open()
    await firstBob
  })

  test("degrades gracefully when expectedAccountEmail callback throws", async () => {
    const w = world()
    w.queue.push(w.ok(70, "alice@example.com"))
    await w.coordinator()(req)
    w.advance(10_000)
    const adopted = await w.coordinator(() => {
      throw new Error("disk error")
    })(req)
    expect(w.fetches()).toBe(1)
    expect(adopted.ok).toBe(true)
  })
})

describe("single-flight lock and backoff persistence", () => {
  test("held lock makes other instances wait; stale lock (>30s) is taken over; lock released on reject", async () => {
    const w = world()
    const open = w.hold()
    w.queue.push(w.ok(55))
    const a = w.coordinator()(req)
    const b = await w.coordinator()(req)
    expect(w.fetches()).toBe(1)
    expect(b).toMatchObject({ ok: false, nextInMs: LOCK_RETRY_MS })
    open()
    await a
    expect(w.mem.files.has(LOCK)).toBe(false)

    w.mem.files.set(LOCK, { data: "stale", mtime: w.now() - 31_000 })
    w.advance(INTERVAL)
    w.queue.push(w.ok(45))
    expect((await w.coordinator()(req)).ok).toBe(true)
    expect(w.fetches()).toBe(2)

    w.advance(INTERVAL)
    const failing = createCoordinator({ store: w.store, fetchOnce: () => Promise.reject(new Error("boom")), intervalMs: INTERVAL, now: w.now })
    await expect(failing(req)).rejects.toThrow("boom")
    expect(w.mem.files.has(LOCK)).toBe(false)
  })

  test("persists exponential backoff 2m -> 4m -> 8m -> 16m -> 30m cap and resets on success", async () => {
    const w = world()
    const load = w.coordinator()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      w.queue.push(rateLimited())
      const r = await load({ maxAgeMs: 0 })
      delays.push(!r.ok ? (r.retryAfterMs ?? -1) : -1)
      w.advance(delays.at(-1)!)
    }
    expect(delays).toEqual([2, 4, 8, 16, 30, 30].map((m) => m * MIN))
    expect(backoffMs(99)).toBe(BACKOFF_MAX_MS)

    w.queue.push(w.ok(85))
    await load({ maxAgeMs: 0 })
    expect(w.store.read()).toMatchObject({ consecutiveFailures: 0, blockedUntil: 0, lastError: null })
  })

  test("429 Retry-After blocks all instances while unauthorized stays local", async () => {
    const w = world()
    w.queue.push(rateLimited(5 * MIN))
    const first = await w.coordinator()(req)
    expect(!first.ok && first.retryAfterMs).toBe(5 * MIN)
    w.advance(MIN)
    const blocked = await w.coordinator()({ maxAgeMs: 0 })
    expect(w.fetches()).toBe(1)
    expect(!blocked.ok && blocked.retryAfterMs).toBe(4 * MIN)

    w.advance(4 * MIN)
    w.queue.push({ ok: false, kind: "unauthorized", message: "401" }, w.ok(99))
    const unauth = await w.coordinator()({ maxAgeMs: 0 })
    expect(!unauth.ok && unauth.kind).toBe("unauthorized")
    expect(w.store.read().blockedUntil).toBe(w.now()) // unchanged by unauthorized
    expect((await w.coordinator()({ maxAgeMs: 0 })).ok).toBe(true)
  })
})

describe("multi-poller integration", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test("two pollers sharing one store issue a single fetch", async () => {
    const w = world()
    const open = w.hold()
    w.queue.push(w.ok(66))
    const mk = () => {
      const scheduled: Array<{ fn: () => void; ms: number }> = []
      const timers: Timers = { set: (fn, ms) => scheduled.push({ fn, ms }), clear: () => {} }
      const poller = createPoller({ timers, intervalMs: INTERVAL, now: () => new Date(w.now()), load: w.coordinator() })
      return { poller, scheduled }
    }
    const a = mk()
    const b = mk()
    a.poller.start()
    b.poller.start()
    await settle()
    open()
    await settle()
    expect(w.fetches()).toBe(1)
    expect(a.poller.getState().snapshot?.buckets[0]?.remaining).toBe(66)
    expect(b.scheduled.at(-1)?.ms).toBe(LOCK_RETRY_MS)
    b.scheduled.at(-1)!.fn()
    await settle()
    expect(w.fetches()).toBe(1)
    expect(b.poller.getState().snapshot?.buckets[0]?.remaining).toBe(66)
    a.poller.stop()
    b.poller.stop()
  })
})
