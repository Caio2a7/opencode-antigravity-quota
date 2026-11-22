import { formatDuration, remainingSeverity, renderBar, severity } from "./format"
import type { QuotaOptions } from "./options"
import type { PollerState } from "./poller"
import type { QuotaBucket, Severity } from "./types"

export type Tone = "text" | "muted" | "success" | "warning" | "error"

export type Row =
  | { kind: "bar"; label: string; filled: string; empty: string; percent: string; tone: Tone }
  | { kind: "text"; text: string; tone: Tone }

export const BAR_WIDTH = 14
const LABEL_WIDTH = 12
const PRIMARY = new Set<string>(["gemini_5h", "gemini_weekly"])

const SEVERITY_TONE: Record<Severity, Tone> = {
  ok: "success",
  warn: "warning",
  high: "error",
  critical: "error",
}

const indent = " ".repeat(LABEL_WIDTH)

function bucketRows(b: QuotaBucket, now: Date, mode: QuotaOptions["displayMode"]): Row[] {
  const value = mode === "remaining" ? b.remaining : b.utilization
  const pct = Math.round(value)
  const bar = renderBar(value, BAR_WIDTH)
  const tone = SEVERITY_TONE[mode === "remaining" ? remainingSeverity(b.remaining) : severity(b.utilization)]
  const rows: Row[] = [
    {
      kind: "bar",
      label: b.label.padEnd(LABEL_WIDTH),
      ...bar,
      percent: `${String(pct).padStart(4)}%`,
      tone,
    },
  ]
  if (b.resetsAt !== null && b.utilization > 0) {
    const left = b.resetsAt.getTime() - now.getTime()
    rows.push({ kind: "text", text: `${indent}resets in ${formatDuration(left)}`, tone: "muted" })
  }
  return rows
}

function errorRows(state: PollerState, now: Date): Row[] {
  const { error, snapshot } = state
  if (!error) return []
  if (error.kind === "rate_limited") {
    const retry = error.retryAt ? ` · retry in ${formatDuration(error.retryAt.getTime() - now.getTime())}` : ""
    return [{ kind: "text", text: `rate limited${retry}`, tone: "muted" }]
  }
  return [{ kind: "text", text: `${error.message}${snapshot ? " (stale)" : ""}`, tone: "muted" }]
}

/** Pure view-model: everything the sidebar shows, independent of the renderer. */
export function buildRows(state: PollerState, now: Date, options: QuotaOptions): Row[] {
  const rows: Row[] = []
  const snap = state.snapshot
  if (snap) {
    const buckets = snap.buckets.filter((b) => PRIMARY.has(b.id) || options.showModels)
    for (const b of buckets) rows.push(...bucketRows(b, now, options.displayMode))
  } else if (state.loading) {
    rows.push({ kind: "text", text: "Loading…", tone: "muted" })
  }
  rows.push(...errorRows(state, now))
  return rows
}
