import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCacheDir, nodeFs } from "../src/shared-fs"
import { createSharedStore, emptyState, LOCK_STALE_MS, STATE_VERSION, type SharedState } from "../src/shared-state"
import { reviveSnapshot } from "../src/snapshot-codec"
import type { QuotaSnapshot } from "../src/types"
import { createMemFs } from "./helpers/memfs"

const DIR = join(tmpdir(), "cache", "agq")
const STATE = join(DIR, "state.json")
const LOCK = join(DIR, "fetch.lock")

const snapshot: QuotaSnapshot = {
  accountEmail: "dev@example.com",
  source: "antigravity",
  buckets: [
    { id: "gemini_5h", label: "Gemini-5h", utilization: 25, remaining: 75, resetsAt: new Date("2026-11-22T18:00:00Z"), modelCount: 2 },
    { id: "gemini_weekly", label: "Gemini-Week", utilization: 10, remaining: 90, resetsAt: new Date("2026-11-28T00:00:00Z"), modelCount: 1 },
    { id: "gemini_argon", label: "Argon", utilization: 100, remaining: 0, resetsAt: null, modelCount: 1 },
  ],
  pool: { total: 3, enabled: 2, geminiReady: 2 },
  fetchedAt: new Date("2026-11-22T12:00:00Z"),
}

const state: SharedState = {
  version: STATE_VERSION,
  snapshot,
  fetchedAt: snapshot.fetchedAt.getTime(),
  blockedUntil: 5_000,
  consecutiveFailures: 2,
  lastError: { kind: "rate_limited", message: "slow down" },
}

function setup() {
  let t = 1_000_000
  const mem = createMemFs(() => t)
  const store = createSharedStore({ dir: DIR, fs: mem.fs, now: () => t })
  return { mem, store, advance: (ms: number) => (t += ms) }
}

describe("reviveSnapshot", () => {
  test("round-trips snapshot with dates, pool, and nullable fields", () => {
    const revived = reviveSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(revived).toEqual(snapshot)
    expect(revived?.fetchedAt).toBeInstanceOf(Date)
    expect(revived?.buckets[0]?.resetsAt).toBeInstanceOf(Date)
    expect(revived?.buckets[2]?.resetsAt).toBeNull()

    const minimal: QuotaSnapshot = { accountEmail: null, source: "gemini-cli", buckets: [], pool: null, fetchedAt: snapshot.fetchedAt }
    expect(reviveSnapshot(JSON.parse(JSON.stringify(minimal)))).toEqual(minimal)
  })

  test("rejects malformed snapshots, invalid dates, bad bucket ids, or bad pool", () => {
    const validRaw = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
    expect(reviveSnapshot(null)).toBeNull()
    expect(reviveSnapshot("x")).toBeNull()
    expect(reviveSnapshot({ ...validRaw, source: "unknown" })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, fetchedAt: "not-a-date" })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, fetchedAt: null })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, accountEmail: 123 })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: "nope" })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: [{ id: "gemini", label: "Gemini", utilization: 0, remaining: 100, resetsAt: null, modelCount: 1 }] })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: [{ id: "gemini_pro", label: "Pro", utilization: 0, remaining: 100, resetsAt: null, modelCount: 1 }] })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: [{ id: "claude", label: "Claude", utilization: 0, remaining: 100, resetsAt: null, modelCount: 1 }] })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: [{ id: "gemini_5h", label: "Gemini-5h", utilization: 0, remaining: 100, resetsAt: "bad", modelCount: 1 }] })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, buckets: [{ id: "gemini_5h", label: "Gemini-5h", utilization: 0, remaining: 100, resetsAt: null, modelCount: -1 }] })).toBeNull()
    expect(reviveSnapshot({ ...validRaw, pool: { total: 2, enabled: 1.5, geminiReady: 1 } })).toBeNull()
  })
})

describe("shared store read/write", () => {
  test("missing file reads as empty state (v3) and valid state round-trips", () => {
    const { store } = setup()
    expect(STATE_VERSION).toBe(3)
    expect(store.read()).toEqual(emptyState())
    expect(store.write(state)).toBe(true)
    const back = store.read()
    expect(back).toEqual(state)
    expect(back.snapshot?.fetchedAt).toBeInstanceOf(Date)
  })

  test("rejects legacy version 1 and version 2 state files and returns emptyState", () => {
    const { store, mem } = setup()
    for (const version of [1, 2]) {
      const legacy = { ...state, version, blockedUntil: Number.MAX_SAFE_INTEGER }
      mem.files.set(STATE, { data: JSON.stringify(legacy), mtime: 0 })
      expect(store.read()).toEqual(emptyState())
    }
  })

  test.each(["", "not json {", "[1]", "null", '{"version":1}', '{"version":2}', '{"version":4}', '{"version":3,"snapshot":"x"}'])(
    "corrupt content %j reads safely without throwing",
    (content) => {
      const { store, mem } = setup()
      mem.files.set(STATE, { data: content, mtime: 0 })
      const read = store.read()
      expect(read.snapshot).toBeNull()
      expect(read.blockedUntil).toBe(0)
    },
  )

  test("malformed snapshot is dropped while valid backoff metadata survives", () => {
    const { store, mem } = setup()
    const broken = { ...state, snapshot: { ...snapshot, buckets: [{ id: "bogus" }] } }
    mem.files.set(STATE, { data: JSON.stringify(broken), mtime: 0 })
    const back = store.read()
    expect(back.snapshot).toBeNull()
    expect(back.fetchedAt).toBeNull()
    expect(back.blockedUntil).toBe(5_000)
    expect(back.lastError?.kind).toBe("rate_limited")
  })

  test("writes atomically through temp file + rename and reports false on write failure", () => {
    const { store, mem } = setup()
    store.write(state)
    expect(mem.writes).toHaveLength(1)
    expect(mem.writes[0]).toStartWith(`${STATE}.`)
    expect(mem.renames).toEqual([[mem.writes[0]!, STATE]])
    expect([...mem.files.keys()]).toEqual([STATE])

    mem.fail.write = true
    expect(store.write({ ...state, blockedUntil: 99 })).toBe(false)
    expect(store.read().blockedUntil).toBe(5_000)

    mem.fail.write = false
    mem.fail.mkdir = true
    expect(store.write(state)).toBe(false)
  })
})

describe("shared store lock", () => {
  test("enforces single holder, release frees lock, and stale locks (>30s) are taken over", () => {
    const { store, mem, advance } = setup()
    const release = store.tryLock()
    expect(release).not.toBeNull()
    expect(store.tryLock()).toBeNull()
    release!()
    expect(mem.files.has(LOCK)).toBe(false)

    store.tryLock()
    advance(LOCK_STALE_MS)
    expect(store.tryLock()).toBeNull()
    advance(1)
    expect(store.tryLock()).not.toBeNull()
  })

  test("unusable cache dir degrades to no-op lock release", () => {
    const { store, mem } = setup()
    mem.fail.mkdir = true
    const release = store.tryLock()
    expect(release).not.toBeNull()
    expect(() => release!()).not.toThrow()
  })
})

describe("defaultCacheDir and nodeFs", () => {
  test("defaultCacheDir honours absolute XDG_CACHE_HOME only", () => {
    const absXdg = join(tmpdir(), "x", "cache")
    const home = join(tmpdir(), "home", "u")
    expect(defaultCacheDir({ XDG_CACHE_HOME: absXdg }, home)).toBe(join(absXdg, "opencode-antigravity-quota"))
    expect(defaultCacheDir({ XDG_CACHE_HOME: "relative" }, home)).toBe(join(home, ".cache", "opencode-antigravity-quota"))
    expect(defaultCacheDir({}, home)).toBe(join(home, ".cache", "opencode-antigravity-quota"))
  })

  test("nodeFs creates directory 0700 and state/lock files 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "agq-test-"))
    try {
      const dir = join(root, "nested", "opencode-antigravity-quota")
      const store = createSharedStore({ dir, fs: nodeFs, now: Date.now })
      expect(store.write(state)).toBe(true)
      expect(store.read()).toEqual(state)
      if (process.platform !== "win32") {
        expect(statSync(dir).mode & 0o777).toBe(0o700)
        expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600)
      }
      const release = store.tryLock()
      expect(release).not.toBeNull()
      if (process.platform !== "win32") {
        expect(statSync(join(dir, "fetch.lock")).mode & 0o777).toBe(0o600)
      }
      expect(store.tryLock()).toBeNull()
      release!()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
