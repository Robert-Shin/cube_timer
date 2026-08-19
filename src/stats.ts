import type { Solve } from './types'
import { effectiveMs } from './types'

/**
 * WCA average of N: drop the single best and single worst, mean the rest.
 * A DNF counts as the worst; two or more DNFs make the whole average a DNF.
 * Returns null for DNF, undefined when there aren't enough solves yet.
 */
export function averageOf(solves: Solve[], n: number): number | null | undefined {
  if (solves.length < n) return undefined
  const window = solves.slice(0, n)
  const times = window.map(effectiveMs)
  const dnfs = times.filter((t) => t === null).length
  if (dnfs > 1) return null

  const finished = (times.filter((t) => t !== null) as number[]).sort((a, b) => a - b)
  // Trim one best always; trim one worst -- which is the DNF if there is one.
  const trimmed = dnfs === 1 ? finished.slice(1) : finished.slice(1, -1)
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length
}

/** Mean of every solve, DNFs excluded. null when nothing has finished. */
export function sessionMean(solves: Solve[]): number | null {
  const times = solves.map(effectiveMs).filter((t): t is number => t !== null)
  if (times.length === 0) return null
  return times.reduce((a, b) => a + b, 0) / times.length
}

export function best(solves: Solve[]): number | null {
  const times = solves.map(effectiveMs).filter((t): t is number => t !== null)
  return times.length ? Math.min(...times) : null
}

/** Best ao_n across the whole session, scanning every window. */
export function bestAverage(solves: Solve[], n: number): number | null | undefined {
  if (solves.length < n) return undefined
  let bestAvg: number | null | undefined = undefined
  for (let i = 0; i + n <= solves.length; i++) {
    const avg = averageOf(solves.slice(i), n)
    if (typeof avg === 'number' && (bestAvg == null || avg < bestAvg)) bestAvg = avg
  }
  return bestAvg ?? null
}
