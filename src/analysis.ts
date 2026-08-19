import type { Solve } from './types'
import { effectiveMs } from './types'

export interface Bucket {
  /** Inclusive lower edge of the bucket, in ms. */
  startMs: number
  widthMs: number
  count: number
}

/**
 * Buckets finished solves into fixed-width bins (0.1s by default) so the shape
 * of the distribution is visible. DNFs are excluded -- they have no time to bin.
 */
export function histogram(solves: Solve[], bucketMs = 100): Bucket[] {
  const times = solves.map(effectiveMs).filter((t): t is number => t !== null)
  if (times.length === 0) return []

  const min = Math.floor(Math.min(...times) / bucketMs) * bucketMs
  const max = Math.floor(Math.max(...times) / bucketMs) * bucketMs
  const n = Math.round((max - min) / bucketMs) + 1

  // Every bin in range is present, including empty ones -- gaps are information.
  const counts = new Array<number>(n).fill(0)
  for (const t of times) counts[Math.floor((t - min) / bucketMs)]++

  return counts.map((count, i) => ({ startMs: min + i * bucketMs, widthMs: bucketMs, count }))
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
