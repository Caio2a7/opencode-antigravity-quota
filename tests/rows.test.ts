import { describe, expect, test } from "bun:test"
import { parseOptions } from "../src/options"
import type { PollerState } from "../src/poller"
import { BAR_WIDTH, buildRows, type Row } from "../src/rows"
import type { QuotaSnapshot } from "../src/types"

const now = new Date("2026-06-01T12:00:00Z")
const INDENT = " ".repeat(12)

const snapshot: QuotaSnapshot = {
  accountEmail: "dev@example.com",
  source: "antigravity",
  buckets: [
    { id: "gemini_5h", label: "Gemini-5h", utilization: 60, remaining: 40, resetsAt: new Date(now.getTime() + 90 * 60_000), modelCount: 4 },
    { id: "gemini_weekly", label: "Gemini-Week", utilization: 20, remaining: 80, resetsAt: new Date(now.getTime() + 108 * 3600_000), modelCount: 4 },
    { id: "gemini_argon", label: "Argon", utilization: 80, remaining: 20, resetsAt: new Date(now.getTime() + 5 * 24 * 3600_000), modelCount: 2 },
  ],
  pool: { total: 4, enabled: 3, geminiReady: 3 },
  fetchedAt: new Date(now.getTime() - 12_000),
}

const base: PollerState = { snapshot, error: null, lastAttemptAt: now, loading: false }

const texts = (state: PollerState, opts = parseOptions({})) =>
  buildRows(state, now, opts).map((r) => (r.kind === "text" ? r.text : `${r.label}${r.percent}`))

const barByLabel = (rows: Row[], label: string) =>
  rows.find((r): r is Extract<Row, { kind: "bar" }> => r.kind === "bar" && r.label.trim() === label)

describe("buildRows", () => {
  test("renders Gemini-5h, Gemini-Week and Argon with 12-col label alignment, omitting email, pool and updated footer", () => {
    const rows = buildRows(base, now, parseOptions({}))
    const out = rows.map((r) => (r.kind === "text" ? r.text : `${r.label}${r.percent}`))
    expect(out).toEqual([
      "Gemini-5h     60%",
      `${INDENT}resets in 1h 30m`,
      "Gemini-Week   20%",
      `${INDENT}resets in 4d 12h`,
      "Argon         80%",
      `${INDENT}resets in 5d 0h`,
    ])
    expect(out.some((t) => t.includes("dev@example.com"))).toBe(false)
    expect(out.some((t) => t.includes("Account pool") || t.includes("Gemini ready"))).toBe(false)
    expect(out.some((t) => t.includes("updated"))).toBe(false)

    const g5h = barByLabel(rows, "Gemini-5h")
    const gWeek = barByLabel(rows, "Gemini-Week")
    const argon = barByLabel(rows, "Argon")
    expect(g5h?.label).toBe("Gemini-5h   ")
    expect(gWeek?.label).toBe("Gemini-Week ")
    expect(argon?.label).toBe("Argon       ")
    expect(g5h?.tone).toBe("warning")
    expect(gWeek?.tone).toBe("success")
    expect(argon?.tone).toBe("error")
    expect((g5h?.filled.length ?? 0) + (g5h?.empty.length ?? 0)).toBe(BAR_WIDTH)
  })

  test("hides resets in line when utilization is 0 even if resetsAt is present", () => {
    const idleSnap: QuotaSnapshot = {
      ...snapshot,
      buckets: [
        { id: "gemini_5h", label: "Gemini-5h", utilization: 0, remaining: 100, resetsAt: new Date(now.getTime() + 5 * 3600_000), modelCount: 4 },
        { id: "gemini_weekly", label: "Gemini-Week", utilization: 0, remaining: 100, resetsAt: new Date(now.getTime() + 7 * 24 * 3600_000), modelCount: 4 },
        { id: "gemini_argon", label: "Argon", utilization: 25, remaining: 75, resetsAt: null, modelCount: 2 },
      ],
    }
    const out = texts({ ...base, snapshot: idleSnap })
    expect(out).toEqual(["Gemini-5h      0%", "Gemini-Week    0%", "Argon         25%"])
  })

  test("renders remaining percentages, bars and remainingSeverity in remaining mode", () => {
    const mixedSnap: QuotaSnapshot = {
      ...snapshot,
      buckets: [
        { id: "gemini_5h", label: "Gemini-5h", utilization: 0, remaining: 100, resetsAt: new Date(now.getTime() + 5 * 3600_000), modelCount: 4 },
        { id: "gemini_weekly", label: "Gemini-Week", utilization: 50, remaining: 50, resetsAt: new Date(now.getTime() + 3 * 24 * 3600_000), modelCount: 4 },
        { id: "gemini_argon", label: "Argon", utilization: 80, remaining: 20, resetsAt: new Date(now.getTime() + 2 * 24 * 3600_000), modelCount: 2 },
      ],
    }
    const rows = buildRows({ ...base, snapshot: mixedSnap }, now, parseOptions({ displayMode: "remaining" }))
    const g5h = barByLabel(rows, "Gemini-5h")
    const gWeek = barByLabel(rows, "Gemini-Week")
    const argon = barByLabel(rows, "Argon")

    expect(g5h?.percent).toBe(" 100%")
    expect(g5h?.tone).toBe("success")
    expect(g5h?.filled).toBe("━".repeat(BAR_WIDTH))
    expect(gWeek?.percent).toBe("  50%")
    expect(gWeek?.tone).toBe("warning")
    expect(argon?.percent).toBe("  20%")
    expect(argon?.tone).toBe("error")
    expect(rows.some((r) => r.kind === "text" && r.text.includes("5h"))).toBe(false)
    expect(rows.some((r) => r.kind === "text" && r.text === `${INDENT}resets in 2d 0h`)).toBe(true)
  })

  test("respects showModels by showing Gemini-5h and Gemini-Week without Argon when false", () => {
    const out = texts(base, parseOptions({ showModels: false }))
    expect(out).toEqual([
      "Gemini-5h     60%",
      `${INDENT}resets in 1h 30m`,
      "Gemini-Week   20%",
      `${INDENT}resets in 4d 12h`,
    ])
  })

  test("shows Loading… when loading without a snapshot", () => {
    const rows = buildRows({ snapshot: null, error: null, lastAttemptAt: null, loading: true }, now, parseOptions({}))
    expect(rows).toEqual([{ kind: "text", text: "Loading…", tone: "muted" }])
  })

  test("shows error with stale marker when a snapshot exists and bare error without one", () => {
    const stale = texts({ ...base, error: { kind: "network", message: "offline", retryAt: null } })
    expect(stale.at(-1)).toBe("offline (stale)")
    expect(stale.some((t) => t.includes("updated"))).toBe(false)

    const bare = texts({ ...base, snapshot: null, error: { kind: "credentials", message: "Not signed in", retryAt: null } })
    expect(bare).toEqual(["Not signed in"])
  })

  test("formats rate_limited cleanly with and without snapshot or retryAt", () => {
    const retryAt = new Date(now.getTime() + 4 * 60_000)
    const withSnap = texts({ ...base, error: { kind: "rate_limited", message: "HTTP 429", retryAt } })
    expect(withSnap).toContain("rate limited · retry in 4m")
    expect(withSnap.some((t) => t.includes("429") || t.includes("stale"))).toBe(false)
    expect(withSnap.some((t) => t.startsWith("Gemini-5h"))).toBe(true)

    const noSnap = texts({ ...base, snapshot: null, error: { kind: "rate_limited", message: "HTTP 429", retryAt: null } })
    expect(noSnap).toEqual(["rate limited"])
  })
})
