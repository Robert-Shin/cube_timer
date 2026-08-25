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
 * Bucket widths offered in the UI, in ms. Fixed rather than derived so the
 * axis always reads in round numbers.
 */
export const BUCKET_OPTIONS = [50, 100, 250, 500, 1000] as const

/** Bins to aim for across the data's range -- enough to show the shape of a
 *  distribution without every bin holding one solve. */
const TARGET_BINS = 30

/**
 * The offered bucket width that best fits a set of solves.
 *
 * A fixed 0.1s default is right for 3x3 and useless for 4x4 and up, where the
 * spread is tens of seconds and 0.1s bins hold one or two solves each -- the
 * distribution reads as noise rather than a shape. This picks whichever
 * offered width lands closest to TARGET_BINS across the actual range, in log
 * space so 250ms is treated as the midpoint between 100 and 500 rather than
 * being lost to the linear gap.
 */
export function suggestBucket(solves: Solve[]): number {
  const times = solves.map((s) => effectiveMs(s)).filter((t): t is number => t !== null)
  if (times.length < 2) return 100
  const range = Math.max(...times) - Math.min(...times)
  if (range <= 0) return BUCKET_OPTIONS[0]
  const target = range / TARGET_BINS
  return BUCKET_OPTIONS.reduce((best, opt) =>
    Math.abs(Math.log(opt / target)) < Math.abs(Math.log(best / target)) ? opt : best,
  )
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
  /** Trailing 25th and 75th percentiles over the same window. */
  p25: number | null
  p75: number | null
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
  // Window contents kept sorted, so percentiles are a lookup rather than a
  // sort at every step.
  const sorted: number[] = []

  return ordered.map((s, i) => {
    const t = effectiveMs(s)
    if (t !== null) {
      sum += t
      insertSorted(sorted, t)
    }
    const leaving = i >= window ? effectiveMs(ordered[i - window]) : undefined
    if (leaving != null) {
      sum -= leaving
      removeSorted(sorted, leaving)
    }
    const full = i + 1 >= window && sorted.length > 0

    return {
      index: i + 1,
      at: s.createdAt,
      timeMs: t,
      rollingMs: full ? sum / sorted.length : null,
      p25: full ? percentile(sorted, 0.25) : null,
      p75: full ? percentile(sorted, 0.75) : null,
    }
  })
}

/** Index of the first element >= value, in a sorted array. */
function lowerBound(arr: number[], value: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insertSorted(arr: number[], value: number): void {
  arr.splice(lowerBound(arr, value), 0, value)
}

function removeSorted(arr: number[], value: number): void {
  const i = lowerBound(arr, value)
  if (arr[i] === value) arr.splice(i, 1)
}

/** Linear-interpolated percentile of a sorted array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface CalendarDay {
  /** Local date, as YYYY-MM-DD. */
  date: string
  count: number
  /** Mean of finished solves that day, or null if all were DNFs. */
  meanMs: number | null
}

/** Local YYYY-MM-DD; practice days are local days, not UTC ones. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Solves per calendar day, for the practice grid. */
export function calendarDays(solves: Solve[]): Map<string, CalendarDay> {
  const days = new Map<string, { count: number; sum: number; finished: number }>()
  for (const s of solves) {
    const key = dayKey(s.createdAt)
    const day = days.get(key) ?? { count: 0, sum: 0, finished: 0 }
    day.count++
    const t = effectiveMs(s)
    if (t !== null) {
      day.sum += t
      day.finished++
    }
    days.set(key, day)
  }

  const out = new Map<string, CalendarDay>()
  for (const [date, d] of days) {
    out.set(date, { date, count: d.count, meanMs: d.finished ? d.sum / d.finished : null })
  }
  return out
}
