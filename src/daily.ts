import { effectiveMs, type Solve } from './types'

/** The UTC calendar day a timestamp falls in, as 'YYYY-MM-DD'. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * The fastest usable solve of one UTC day, ranked on the +2-adjusted time so
 * a penalised solve cannot beat a clean one it was actually slower than.
 */
export function bestOfDay(
  solves: Solve[],
  day: string,
): { solve: Solve; ms: number } | null {
  let best: { solve: Solve; ms: number } | null = null
  for (const s of solves) {
    if (s.deleted || s.penalty === 'dnf') continue
    if (utcDay(s.createdAt) !== day) continue
    const ms = effectiveMs(s)
    if (ms === null) continue
    if (!best || ms < best.ms) best = { solve: s, ms }
  }
  return best
}
