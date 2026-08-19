import type { EventId, Solve } from './types'
import { effectiveMs } from './types'
import { parityKey, parityLabel } from './parity'

export interface Bucket {
  /** Inclusive lower edge of the bucket, in ms. */
  startMs: number
  widthMs: number
  count: number
  /** Count per parity category, keyed as in `series`. Empty when not split. */
  parts: Record<string, number>
}

export interface Series {
  key: string
  label: string
  count: number
}

export interface Distribution {
  buckets: Bucket[]
  /** Stacking order, biggest first after "no parity". Empty when not split. */
  series: Series[]
}

/**
 * Buckets finished solves into fixed-width bins (0.1s by default) so the shape
 * of the distribution is visible. DNFs are excluded -- they have no time to bin.
 */
/** At most this many stacked categories; the rest fold into "other". */
const MAX_SERIES = 4

export function histogram(
  solves: Solve[],
  bucketMs = 100,
  splitByParity = false,
  event: EventId = '333',
): Distribution {
  const finished = solves.filter((s) => effectiveMs(s) !== null)
  if (finished.length === 0) return { buckets: [], series: [] }

  const times = finished.map((s) => effectiveMs(s)!)
  const min = Math.floor(Math.min(...times) / bucketMs) * bucketMs
  const max = Math.floor(Math.max(...times) / bucketMs) * bucketMs
  const n = Math.round((max - min) / bucketMs) + 1

  const series = splitByParity ? rankSeries(finished, event) : []
  const allowed = new Set(series.map((s) => s.key))

  // Every bin in range is present, including empty ones -- gaps are information.
  const buckets: Bucket[] = Array.from({ length: n }, (_, i) => ({
    startMs: min + i * bucketMs,
    widthMs: bucketMs,
    count: 0,
    parts: {},
  }))

  for (const solve of finished) {
    const bucket = buckets[Math.floor((effectiveMs(solve)! - min) / bucketMs)]
    bucket.count++
    if (!splitByParity) continue
    const raw = parityKey(solve.parity)
    const key = allowed.has(raw) ? raw : 'other'
    bucket.parts[key] = (bucket.parts[key] ?? 0) + 1
  }

  return { buckets, series }
}

/**
 * Parity categories in stacking order: no-parity first as the baseline, then
 * by frequency. Beyond MAX_SERIES they fold into "other" rather than growing
 * the palette, and untracked solves always sort last.
 */
function rankSeries(solves: Solve[], event: EventId): Series[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const s of solves) {
    const key = parityKey(s.parity)
    const entry = counts.get(key) ?? { label: parityLabel(event, s.parity), count: 0 }
    entry.count++
    counts.set(key, entry)
  }

  const rank = (k: string) => (k === 'none' ? -1 : k === 'untracked' ? 1e9 : 0)
  const ordered = [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count }))
    .sort((a, b) => rank(a.key) - rank(b.key) || b.count - a.count)

  if (ordered.length <= MAX_SERIES) return ordered
  const kept = ordered.slice(0, MAX_SERIES - 1)
  const rest = ordered.slice(MAX_SERIES - 1)
  return [...kept, { key: 'other', label: 'other', count: rest.reduce((n, r) => n + r.count, 0) }]
}

export interface TrendPoint {
  /** Position in chronological order, 1-based. */
  index: number
  at: number
  /** Effective time, or null for a DNF. */
  timeMs: number | null
  /** Trailing mean over the window, or null until the window fills. */
  rollingMs: number | null
}

/**
 * Chronological series with a trailing rolling mean overlaid. The mean skips
 * DNFs rather than dropping the window, so one DNF doesn't punch a hole in the
 * trend line.
 */
export function trend(solves: Solve[], window = 50): TrendPoint[] {
  // Incoming solves are newest-first; a trend reads oldest-first.
  const ordered = [...solves].reverse()

  // Sliding window: one pass, so a few thousand imported solves stay instant.
  let sum = 0
  let finished = 0

  return ordered.map((s, i) => {
    const t = effectiveMs(s)
    if (t !== null) {
      sum += t
      finished++
    }
    const leaving = i >= window ? effectiveMs(ordered[i - window]) : undefined
    if (leaving != null) {
      sum -= leaving
      finished--
    }
    const full = i + 1 >= window && finished > 0

    return {
      index: i + 1,
      at: s.createdAt,
      timeMs: t,
      rollingMs: full ? sum / finished : null,
    }
  })
}
