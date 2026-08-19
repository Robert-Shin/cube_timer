import type { EventId, Solve } from './types'
import { effectiveMs } from './types'
import { parityKey, parityLabel } from './parity'

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

/**
 * Sample standard deviation (n-1) of finished solves. Sample, not population:
 * a session is a sample of your solving, not the whole of it. Returns null
 * below two finished solves, where spread is undefined.
 */
export function stdDev(solves: Solve[]): number | null {
  const times = solves.map(effectiveMs).filter((t): t is number => t !== null)
  if (times.length < 2) return null
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const variance = times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / (times.length - 1)
  return Math.sqrt(variance)
}

export interface ParityGroup {
  key: string
  label: string
  /** Solves in this group, including DNFs. */
  count: number
  /** Finished solves -- what mean and sd are computed from. */
  finished: number
  mean: number | null
  sd: number | null
  /** Mean minus the no-parity mean: the time this parity costs. */
  deltaMs: number | null
}

/**
 * Groups solves by which parities occurred and reports mean and spread for
 * each, plus the gap to the no-parity mean -- the expected cost of that
 * parity. Solves recorded before tracking was on are grouped separately and
 * never folded into "no parity", which would understate the clean mean.
 */
export function parityGroups(solves: Solve[], event: EventId): ParityGroup[] {
  const buckets = new Map<string, Solve[]>()
  for (const s of solves) {
    const key = parityKey(s.parity)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(s)
  }

  const groups: ParityGroup[] = []
  for (const [key, group] of buckets) {
    const times = group.map(effectiveMs).filter((t): t is number => t !== null)
    const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null
    groups.push({
      key,
      label: parityLabel(event, group[0].parity),
      count: group.length,
      finished: times.length,
      mean,
      sd: stdDev(group),
      deltaMs: null,
    })
  }

  // Untracked solves get no delta: their parity is unknown, so the gap to the
  // clean mean measures nothing.
  const clean = groups.find((g) => g.key === 'none')?.mean ?? null
  for (const g of groups) {
    const comparable = g.key !== 'none' && g.key !== 'untracked'
    g.deltaMs = clean !== null && g.mean !== null && comparable ? g.mean - clean : null
  }

  // "no parity" first, then heaviest groups, with untracked last.
  const rank = (g: ParityGroup) => (g.key === 'none' ? -1 : g.key === 'untracked' ? 1e9 : 0)
  return groups.sort((a, b) => rank(a) - rank(b) || b.count - a.count)
}
