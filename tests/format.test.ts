import { describe, expect, test } from "bun:test"
import { formatAge, formatDuration, remainingSeverity, renderBar, severity } from "../src/format"

const S = 1_000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe("formatDuration", () => {
  test.each([
    [0, "now"],
    [-1, "now"],
    [-5 * M, "now"],
    [Number.NaN, "now"],
    [1, "1m"],
    [30 * S, "1m"],
    [59 * S, "1m"],
    [M, "1m"],
    [2 * M + 45 * S, "2m"],
    [59 * M + 59 * S, "59m"],
    [H, "1h 0m"],
    [2 * H + 15 * M + 30 * S, "2h 15m"],
    [23 * H + 59 * M, "23h 59m"],
    [D, "1d 0h"],
    [3 * D + 7 * H + 50 * M, "3d 7h"],
  ])("formats %p ms as %j", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe("formatAge", () => {
  test.each([
    [-1_000, "just now"],
    [0, "just now"],
    [9_999, "just now"],
    [10 * S, "10s ago"],
    [59_999, "59s ago"],
    [M, "1m ago"],
    [45 * M + 20 * S, "45m ago"],
    [59 * M + 59 * S, "59m ago"],
    [H, "1h ago"],
    [5 * H + 30 * M, "5h ago"],
  ])("formats %p ms as %j", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected)
  })
})

describe("severity", () => {
  test.each([
    [-10, "ok"],
    [0, "ok"],
    [49.9, "ok"],
    [50, "warn"],
    [74.9, "warn"],
    [75, "high"],
    [99.9, "high"],
    [100, "critical"],
    [125, "critical"],
  ] as const)("used %p%% -> %s", (pct, expected) => {
    expect(severity(pct)).toBe(expected)
  })
})

describe("remainingSeverity", () => {
  test.each([
    [-5, "critical"],
    [0, "critical"],
    [0.1, "high"],
    [25, "high"],
    [25.1, "warn"],
    [50, "warn"],
    [50.1, "ok"],
    [100, "ok"],
  ] as const)("remaining %p%% -> %s", (pct, expected) => {
    expect(remainingSeverity(pct)).toBe(expected)
  })
})

describe("renderBar", () => {
  test("renders exact filled/empty segments across normal and boundary percentages", () => {
    expect(renderBar(0, 10)).toEqual({ filled: "", empty: "──────────" })
    expect(renderBar(50, 10)).toEqual({ filled: "━━━━━", empty: "─────" })
    expect(renderBar(100, 10)).toEqual({ filled: "━━━━━━━━━━", empty: "" })
    expect(renderBar(33, 10)).toEqual({ filled: "━━━", empty: "───────" })
    expect(renderBar(35, 10)).toEqual({ filled: "━━━━", empty: "──────" })
  })

  test("clamps out-of-range percentages and handles NaN or non-positive widths", () => {
    expect(renderBar(-20, 8)).toEqual({ filled: "", empty: "────────" })
    expect(renderBar(150, 8)).toEqual({ filled: "━━━━━━━━", empty: "" })
    expect(renderBar(Number.NaN, 4)).toEqual({ filled: "", empty: "────" })
    expect(renderBar(50, 0)).toEqual({ filled: "", empty: "" })
    expect(renderBar(50, -5)).toEqual({ filled: "", empty: "" })
    expect(renderBar(50, Number.NaN)).toEqual({ filled: "", empty: "" })
  })
})
