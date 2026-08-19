export type EventId = '333' | '222' | '444'

export const EVENTS: { id: EventId; name: string }[] = [
  { id: '333', name: '3x3' },
  { id: '222', name: '2x2' },
  { id: '444', name: '4x4' },
]

export type Penalty = 'none' | 'plus2' | 'dnf'

export interface Solve {
  id: string
  event: EventId
  scramble: string
  /** Raw stopwatch time in ms, before any penalty is applied. */
  timeMs: number
  penalty: Penalty
  createdAt: number
}

/**
 * Effective time in ms, or null for a DNF. Penalties are stored separately
 * from timeMs so a mis-tapped +2 can be undone without losing the raw time.
 */
export function effectiveMs(s: Solve): number | null {
  if (s.penalty === 'dnf') return null
  return s.penalty === 'plus2' ? s.timeMs + 2000 : s.timeMs
}
