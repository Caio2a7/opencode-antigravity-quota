import { describe, expect, test } from "bun:test"
import {
  classifyBucket,
  normalizeRemainingFraction,
  parseAvailableModelsResponse,
  parseCachedQuota,
  parseIsoDate,
  parseQuotaSummaryResponse,
  parseRetrieveUserQuotaResponse,
  QuotaParseError,
  type SnapshotMeta,
} from "../src/parse"

const NOW = new Date("2026-11-22T12:00:00Z")
const META: SnapshotMeta = {
  accountEmail: "dev@example.com",
  pool: { total: 2, enabled: 2, geminiReady: 2 },
}

describe("helpers: normalizeRemainingFraction, parseIsoDate, classifyBucket", () => {
  test("normalizeRemainingFraction clamps bounds and maps non-numbers to 0", () => {
    expect(normalizeRemainingFraction(undefined)).toBe(0)
    expect(normalizeRemainingFraction(null)).toBe(0)
    expect(normalizeRemainingFraction("0.5")).toBe(0)
    expect(normalizeRemainingFraction(Number.NaN)).toBe(0)
    expect(normalizeRemainingFraction(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeRemainingFraction(-0.25)).toBe(0)
    expect(normalizeRemainingFraction(0)).toBe(0)
    expect(normalizeRemainingFraction(0.42)).toBe(0.42)
    expect(normalizeRemainingFraction(1)).toBe(1)
    expect(normalizeRemainingFraction(1.5)).toBe(1)
  })

  test("parseIsoDate parses valid ISO timestamps and rejects invalid inputs", () => {
    expect(parseIsoDate("2026-11-22T15:00:00Z")).toEqual(new Date("2026-11-22T15:00:00Z"))
    for (const bad of ["", "   ", "not-a-date", null, undefined, 12345]) {
      expect(parseIsoDate(bad)).toBeNull()
    }
  })

  test.each([
    ["gemini-4-neon-high", undefined, "gemini_5h"],
    ["gemini-3.5-hydrogen", "Gemini Hydrogen", "gemini_5h"],
    ["gemini-2.5-pro", undefined, "gemini_5h"],
    ["gemini-3.8-flash", undefined, "gemini_5h"],
    ["gemini-argon-preview", "Gemini Argon", "gemini_argon"],
    ["custom-id", "Gemini 3 Pro", "gemini_5h"],
    ["custom-argon", "Gemini Argon High", "gemini_argon"],
    ["antigravity-argon-v1", undefined, null],
    ["claude-opus-4-6-thinking", undefined, null],
    ["gpt-oss-120b", "OpenAI GPT", null],
    ["tab_flash_lite_preview", "Gemini Flash", null],
    ["unknown-vendor-model", "Other", null],
  ] as const)("classifyBucket(%j, %j) -> %j", (modelId, displayName, expected) => {
    expect(classifyBucket(modelId, displayName)).toBe(expected)
  })
})

describe("parseQuotaSummaryResponse", () => {
  test("parses gemini_5h, gemini_weekly, gemini_argon in order and drops disabled/3p/claude/gpt", () => {
    const payload = {
      groups: [
        {
          buckets: [
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.72, resetTime: "2026-11-22T17:00:00Z" },
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.85, resetTime: "2026-11-28T00:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-22T16:00:00Z", disabled: true },
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.1, disabled: true },
          ],
        },
        {
          buckets: [
            { bucketId: "gemini-argon-weekly", remainingFraction: 0.4, resetTime: "2026-11-29T00:00:00Z" },
            { bucketId: "3p-claude-5h", window: "5h", remainingFraction: 0.2, resetTime: "2026-11-22T15:00:00Z" },
            { bucketId: "3p-openai", remainingFraction: 0.1 },
            { bucketId: "claude-weekly", remainingFraction: 0.3 },
            { bucketId: "gpt-5h", remainingFraction: 0.3 },
          ],
        },
      ],
    }
    const snap = parseQuotaSummaryResponse(payload, META, NOW)
    expect(snap).toEqual({
      accountEmail: "dev@example.com",
      source: "antigravity",
      pool: META.pool,
      fetchedAt: NOW,
      buckets: [
        { id: "gemini_5h", label: "Gemini-5h", utilization: 28, remaining: 72, resetsAt: new Date("2026-11-22T17:00:00Z"), modelCount: 1 },
        { id: "gemini_weekly", label: "Gemini-Week", utilization: 15, remaining: 85, resetsAt: new Date("2026-11-28T00:00:00Z"), modelCount: 1 },
        { id: "gemini_argon", label: "Argon", utilization: 60, remaining: 40, resetsAt: new Date("2026-11-29T00:00:00Z"), modelCount: 1 },
      ],
    })
  })

  test("proto3 omitted remainingFraction means 0% remaining and 100% utilized, and disabled=true is discarded even at 1.0", () => {
    const payload = {
      groups: [
        {
          buckets: [
            { bucketId: "gemini-5h", resetTime: "2026-11-22T16:30:00Z" },
            { bucketId: "gemini-weekly", remainingFraction: 1, resetTime: "2026-11-29T00:00:00Z", disabled: true },
            { bucketId: "argon-quota", resetTime: "2026-11-29T12:00:00Z" },
          ],
        },
      ],
    }
    const snap = parseQuotaSummaryResponse(payload, META, NOW)
    expect(snap.buckets).toEqual([
      { id: "gemini_5h", label: "Gemini-5h", utilization: 100, remaining: 0, resetsAt: new Date("2026-11-22T16:30:00Z"), modelCount: 1 },
      { id: "gemini_argon", label: "Argon", utilization: 100, remaining: 0, resetsAt: new Date("2026-11-29T12:00:00Z"), modelCount: 1 },
    ])
  })

  test.each([[null], [[]], ["x"], [{}], [{ groups: "bad" }], [{ groups: {} }]])(
    "throws QuotaParseError on invalid summary payload %j",
    (invalid) => {
      expect(() => parseQuotaSummaryResponse(invalid, META, NOW)).toThrow(QuotaParseError)
    },
  )
})

describe("parseAvailableModelsResponse", () => {
  test("splits Gemini models into gemini_5h (<=24h) vs gemini_weekly (>24h), keeps gemini_argon, drops claude/gpt/disabled/tab", () => {
    const raw = {
      models: {
        "gemini-4-neon-high": { displayName: "Gemini Neon", quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-22T16:00:00Z" } },
        "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.65, resetTime: "2026-11-23T12:00:00Z" } }, // exactly 24h -> gemini_5h
        "gemini-2.5-pro": { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-23T12:00:01Z" } }, // >24h -> gemini_weekly
        "gemini-argon-exp": { displayName: "Gemini Argon", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-29T18:00:00Z" } },
        "claude-opus-4-6": { quotaInfo: { remainingFraction: 0.1, resetTime: "2026-11-22T13:30:00Z" } },
        "gpt-oss-120b": { quotaInfo: { remainingFraction: 0.05, resetTime: "2026-11-22T12:20:00Z" } },
        "gemini-disabled-pro": { disabled: true, quotaInfo: { remainingFraction: 0.05, resetTime: "2026-11-22T12:30:00Z" } },
        "tab_flash_preview": { quotaInfo: { remainingFraction: 0.01, resetTime: "2026-11-22T12:10:00Z" } },
        "gemini-no-quota-pro": { displayName: "Gemini Pro No Quota" },
      },
    }
    const snap = parseAvailableModelsResponse(raw, META, NOW)
    expect(snap.buckets).toEqual([
      { id: "gemini_5h", label: "Gemini-5h", utilization: 35, remaining: 65, resetsAt: new Date("2026-11-23T12:00:00Z"), modelCount: 2 },
      { id: "gemini_weekly", label: "Gemini-Week", utilization: 10, remaining: 90, resetsAt: new Date("2026-11-23T12:00:01Z"), modelCount: 1 },
      { id: "gemini_argon", label: "Argon", utilization: 50, remaining: 50, resetsAt: new Date("2026-11-29T18:00:00Z"), modelCount: 1 },
    ])
  })

  test("proto3 omitted remainingFraction -> 0% remaining, lowest wins with own resetTime, ties break by earliest resetTime", () => {
    const raw = {
      models: {
        "gemini-a-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-22T19:00:00Z" } },
        "gemini-b-pro": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-22T14:00:00Z" } },
        "gemini-argon-preview": { quotaInfo: { resetTime: "2026-11-29T00:00:00Z" } },
      },
    }
    const snap = parseAvailableModelsResponse(raw, META, NOW)
    expect(snap.buckets).toEqual([
      { id: "gemini_5h", label: "Gemini-5h", utilization: 50, remaining: 50, resetsAt: new Date("2026-11-22T14:00:00Z"), modelCount: 2 },
      { id: "gemini_argon", label: "Argon", utilization: 100, remaining: 0, resetsAt: new Date("2026-11-29T00:00:00Z"), modelCount: 1 },
    ])
  })

  test.each([[null], ["str"], [42], [[1, 2]], [{ models: [] }], [{ models: "bad" }], [{ models: null }]])(
    "throws QuotaParseError on invalid payload %j",
    (invalid) => {
      expect(() => parseAvailableModelsResponse(invalid, META, NOW)).toThrow(QuotaParseError)
    },
  )
})

describe("parseRetrieveUserQuotaResponse", () => {
  test("splits <=24h into gemini_5h and >24h into gemini_weekly, separates argon, ignores claude", () => {
    const raw = {
      buckets: [
        { modelId: "gemini-2.5-pro", remainingFraction: 0.82, resetTime: "2026-11-22T22:00:00Z" },
        { modelId: "gemini-2.5-pro-exp", resetTime: "2026-11-22T21:00:00Z" },
        { modelId: "gemini-2.5-flash", remainingFraction: 0.7, resetTime: "2026-11-27T00:00:00Z" },
        { modelId: "gemini-argon-v1", remainingFraction: 0.6, resetTime: "2026-11-29T00:00:00Z" },
        { modelId: "claude-sonnet-4-5", remainingFraction: 0.1, resetTime: "2026-11-22T15:00:00Z" },
        { modelId: "   ", remainingFraction: 0.1 },
      ],
    }
    const snap = parseRetrieveUserQuotaResponse(raw, { accountEmail: null, pool: null }, NOW)
    expect(snap.source).toBe("gemini-cli")
    expect(snap.buckets).toEqual([
      { id: "gemini_5h", label: "Gemini-5h", utilization: 100, remaining: 0, resetsAt: new Date("2026-11-22T21:00:00Z"), modelCount: 2 },
      { id: "gemini_weekly", label: "Gemini-Week", utilization: 30, remaining: 70, resetsAt: new Date("2026-11-27T00:00:00Z"), modelCount: 1 },
      { id: "gemini_argon", label: "Argon", utilization: 40, remaining: 60, resetsAt: new Date("2026-11-29T00:00:00Z"), modelCount: 1 },
    ])
  })

  test.each([[null], [[]], ["x"], [{ buckets: {} }], [{ buckets: "bad" }]])(
    "throws QuotaParseError on invalid payload %j",
    (invalid) => {
      expect(() => parseRetrieveUserQuotaResponse(invalid, META, NOW)).toThrow(QuotaParseError)
    },
  )
})

describe("parseCachedQuota", () => {
  test("maps gemini-5h/gemini-pro/gemini-flash -> gemini_5h, gemini-weekly -> gemini_weekly, gemini-argon -> gemini_argon, ignores claude", () => {
    const updatedAt = new Date("2026-11-22T11:45:00Z")
    const cached = {
      "gemini-pro": { remainingFraction: 0.6, remainingFractionResetTime: "2026-11-22T15:00:00Z", modelCount: 3 },
      gemini_flash: { remainingFraction: 0.4, resetTime: "2026-11-22T16:00:00Z", modelCount: 2 },
      "gemini-weekly": { remainingFraction: 0.8, resetTime: "2026-11-28T00:00:00Z" },
      "gemini-argon": { remainingFractionResetTime: "2026-11-29T17:00:00Z", modelCount: -2 },
      claude: { remainingFraction: 0.1, resetTime: "2026-11-22T14:00:00Z", modelCount: 2 },
    }
    const snap = parseCachedQuota(cached, META, updatedAt)
    expect(snap).toEqual({
      accountEmail: "dev@example.com",
      source: "cached",
      pool: META.pool,
      fetchedAt: updatedAt,
      buckets: [
        { id: "gemini_5h", label: "Gemini-5h", utilization: 60, remaining: 40, resetsAt: new Date("2026-11-22T16:00:00Z"), modelCount: 5 },
        { id: "gemini_weekly", label: "Gemini-Week", utilization: 20, remaining: 80, resetsAt: new Date("2026-11-28T00:00:00Z"), modelCount: 1 },
        { id: "gemini_argon", label: "Argon", utilization: 100, remaining: 0, resetsAt: new Date("2026-11-29T17:00:00Z"), modelCount: 1 },
      ],
    })
  })

  test("returns null when only claude or unrecognized keys exist", () => {
    expect(parseCachedQuota(null, META, NOW)).toBeNull()
    expect(parseCachedQuota({}, META, NOW)).toBeNull()
    expect(parseCachedQuota({ claude: { remainingFraction: 0.5 } }, META, NOW)).toBeNull()
  })
})
