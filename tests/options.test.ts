import { describe, expect, test } from "bun:test"
import { parseOptions } from "../src/options"
import { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } from "../src/poller"

describe("parseOptions", () => {
  test("returns defaults when input is undefined or empty", () => {
    const expected = {
      refreshIntervalMs: DEFAULT_INTERVAL_MS,
      showModels: true,
      displayMode: "used" as const,
      credentialsPath: undefined,
    }
    expect(parseOptions(undefined)).toEqual(expected)
    expect(parseOptions({})).toEqual(expected)
  })

  test("clamps refreshInterval below 60s up to 60s and converts valid seconds to ms", () => {
    expect(parseOptions({ refreshInterval: 0 }).refreshIntervalMs).toBe(MIN_INTERVAL_MS)
    expect(parseOptions({ refreshInterval: -10 }).refreshIntervalMs).toBe(MIN_INTERVAL_MS)
    expect(parseOptions({ refreshInterval: 30 }).refreshIntervalMs).toBe(MIN_INTERVAL_MS)
    expect(parseOptions({ refreshInterval: 59.9 }).refreshIntervalMs).toBe(MIN_INTERVAL_MS)
    expect(parseOptions({ refreshInterval: 60 }).refreshIntervalMs).toBe(60_000)
    expect(parseOptions({ refreshInterval: 180 }).refreshIntervalMs).toBe(180_000)
    expect(parseOptions({ refreshInterval: 90.5 }).refreshIntervalMs).toBe(90_500)
  })

  test("falls back to default interval on non-numeric or non-finite refreshInterval", () => {
    for (const value of ["60", null, true, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseOptions({ refreshInterval: value }).refreshIntervalMs).toBe(DEFAULT_INTERVAL_MS)
    }
  })

  test("parses showModels boolean with true fallback on invalid types", () => {
    expect(parseOptions({ showModels: false }).showModels).toBe(false)
    for (const invalid of ["false", 0, null, 1]) {
      expect(parseOptions({ showModels: invalid }).showModels).toBe(true)
    }
  })

  test("validates displayMode against used and remaining only", () => {
    expect(parseOptions({ displayMode: "used" }).displayMode).toBe("used")
    expect(parseOptions({ displayMode: "remaining" }).displayMode).toBe("remaining")
    for (const invalid of ["left", "USED", "", null, 123, true]) {
      expect(parseOptions({ displayMode: invalid }).displayMode).toBe("used")
    }
  })

  test("trims credentialsPath and treats blank or non-string values as undefined", () => {
    expect(parseOptions({ credentialsPath: "  /etc/ag/accounts.json \n" }).credentialsPath).toBe("/etc/ag/accounts.json")
    for (const empty of ["", "   ", "\t\n", null, 42, true]) {
      expect(parseOptions({ credentialsPath: empty }).credentialsPath).toBeUndefined()
    }
  })
})
