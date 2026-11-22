import { describe, expect, test } from "bun:test"
import {
  clampInterval,
  createPoller,
  DEFAULT_INTERVAL_MS,
  MANUAL_MAX_AGE_MS,
  MIN_INTERVAL_MS,
  POST_TURN_MAX_AGE_MS,
  type LoadRequest,
  type LoadResult,
  type Timers,
} from "../src/poller"
import type { QuotaSnapshot } from "../src/types"

const snapshot = (remaining: number): QuotaSnapshot => ({
  accountEmail: "dev@example.com",
  source: "antigravity",
  buckets: [{ id: "gemini_5h", label: "Gemini-5h", utilization: 100 - remaining, remaining, resetsAt: null, modelCount: 1 }],
  pool: null,
  fetchedAt: new Date(0),
})

const ok = (remaining: number, nextInMs?: number): LoadResult => ({ ok: true, snapshot: snapshot(remaining), nextInMs })
const settle = () => new Promise((r) => setTimeout(r, 0))

function harness(results: LoadResult[], intervalMs?: number) {
  let time = 1_000_000
  const pending = new Map<number, { at: number; fn: () => void }>()
  const requests: LoadRequest[] = []
  let nextId = 1
  const timers: Timers = {
    set: (fn, ms) => {
      const id = nextId++
      pending.set(id, { at: time + ms, fn })
      return id
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  const poller = createPoller({
    intervalMs,
    now: () => new Date(time),
    timers,
    load: async (request) => results[Math.min(requests.push(request) - 1, results.length - 1)]!,
  })
  const nextDelay = (): number | null => {
    const first = [...pending.values()].sort((a, b) => a.at - b.at)[0]
    return first ? first.at - time : null
  }
  const advance = async (ms: number): Promise<void> => {
    time += ms
    for (const [id, t] of [...pending]) {
      if (t.at <= time) {
        pending.delete(id)
        t.fn()
      }
    }
    await settle()
  }
  return { poller, advance, nextDelay, requests, now: () => time }
}

describe("clampInterval", () => {
  test("defaults to 120s with a 60s floor and floors finite values", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(120_000)
    expect(MIN_INTERVAL_MS).toBe(60_000)
    expect(POST_TURN_MAX_AGE_MS).toBe(60_000)
    expect(MANUAL_MAX_AGE_MS).toBe(30_000)
    expect(clampInterval(undefined)).toBe(120_000)
    expect(clampInterval(Number.NaN)).toBe(120_000)
    expect(clampInterval(Number.POSITIVE_INFINITY)).toBe(120_000)
    expect(clampInterval(-5_000)).toBe(60_000)
    expect(clampInterval(1_000)).toBe(60_000)
    expect(clampInterval(90_500.9)).toBe(90_500)
  })
})

describe("poller", () => {
  test("loads on start, ignores duplicate start(), and schedules interval", async () => {
    const h = harness([ok(80)])
    h.poller.start()
    h.poller.start()
    await settle()
    expect(h.poller.getState().snapshot?.buckets[0]?.remaining).toBe(80)
    expect(h.nextDelay()).toBe(120_000)
    expect(h.requests).toEqual([{ maxAgeMs: 120_000 }])
    h.poller.stop()
  })

  test("honours loader nextInMs override floored at 1s", async () => {
    const h = harness([ok(90, 45_000), ok(85, 50)])
    h.poller.start()
    await settle()
    expect(h.nextDelay()).toBe(45_000)
    await h.advance(45_000)
    expect(h.nextDelay()).toBe(1_000)
    h.poller.stop()
  })

  test("failures preserve last snapshot, expose retryAt, and recover on next success", async () => {
    const failure: LoadResult = { ok: false, kind: "rate_limited", message: "429", retryAfterMs: 180_000, nextInMs: 180_000 }
    const h = harness([ok(75), failure, ok(70)])
    h.poller.start()
    await settle()
    await h.advance(120_000)
    expect(h.poller.getState().snapshot?.buckets[0]?.remaining).toBe(75)
    expect(h.poller.getState().error).toEqual({ kind: "rate_limited", message: "429", retryAt: new Date(h.now() + 180_000) })
    expect(h.nextDelay()).toBe(180_000)
    await h.advance(180_000)
    expect(h.poller.getState().error).toBeNull()
    expect(h.poller.getState().snapshot?.buckets[0]?.remaining).toBe(70)
    h.poller.stop()
  })

  test("failure may adopt a carried snapshot and sets retryAt: null without retryAfterMs", async () => {
    const h = harness([{ ok: false, kind: "network", message: "offline", snapshot: snapshot(42) }])
    h.poller.start()
    await settle()
    expect(h.poller.getState().snapshot?.buckets[0]?.remaining).toBe(42)
    expect(h.poller.getState().error).toEqual({ kind: "network", message: "offline", retryAt: null })
    h.poller.stop()
  })

  test("exposes initial snapshot immediately before any load", () => {
    const poller = createPoller({ initial: snapshot(91), load: () => new Promise(() => {}) })
    expect(poller.getState().snapshot?.buckets[0]?.remaining).toBe(91)
    expect(poller.getState().loading).toBe(false)
  })

  test("refresh deduplicates while inFlight and passes maxAgeMs", async () => {
    const h = harness([ok(50)])
    h.poller.start()
    expect(await h.poller.refresh(POST_TURN_MAX_AGE_MS)).toBe(false)
    await settle()
    expect(await h.poller.refresh(POST_TURN_MAX_AGE_MS)).toBe(true)
    expect(await h.poller.refresh()).toBe(true)
    expect(h.requests.map((r) => r.maxAgeMs)).toEqual([120_000, 60_000, 30_000])
    h.poller.stop()
  })

  test("stop() during an in-flight load suppresses state update and rescheduling", async () => {
    let release!: (r: LoadResult) => void
    const scheduled: number[] = []
    const timers: Timers = { set: (_fn, ms) => scheduled.push(ms), clear: () => {} }
    const poller = createPoller({ timers, load: () => new Promise<LoadResult>((r) => (release = r)) })
    poller.start()
    await settle()
    poller.stop()
    release(ok(55))
    await settle()
    expect(scheduled).toEqual([])
    expect(poller.getState().snapshot).toBeNull()
  })

  test("subscribe notifies on state transitions and unsubscribe stops notifications", async () => {
    const h = harness([ok(60)])
    const states: boolean[] = []
    const off = h.poller.subscribe((s) => states.push(s.loading))
    h.poller.start()
    await settle()
    expect(states).toEqual([true, false])
    off()
    await h.advance(120_000)
    expect(states).toEqual([true, false])
    h.poller.stop()
  })
})
