/** WCA event ids, matching the ids cubing.js scrambles for. */
export type EventId =
  | '222' | '333' | '444' | '555' | '666' | '777'
  | '333bf' | '333fm' | '333oh' | '333mbf'
  | 'clock' | 'minx' | 'pyram' | 'skewb' | 'sq1'
  | '444bf' | '555bf'

export const EVENTS: { id: EventId; name: string }[] = [
  { id: '222', name: '2x2' },
  { id: '333', name: '3x3' },
  { id: '444', name: '4x4' },
  { id: '555', name: '5x5' },
  { id: '666', name: '6x6' },
  { id: '777', name: '7x7' },
  { id: '333bf', name: '3x3 BLD' },
  { id: '333fm', name: 'FMC' },
  { id: '333oh', name: '3x3 OH' },
  { id: '333mbf', name: '3x3 Multi-BLD' },
  { id: 'clock', name: 'Clock' },
  { id: 'minx', name: 'Megaminx' },
  { id: 'pyram', name: 'Pyraminx' },
  { id: 'skewb', name: 'Skewb' },
  { id: 'sq1', name: 'Square-1' },
  { id: '444bf', name: '4x4 BLD' },
  { id: '555bf', name: '5x5 BLD' },
]

export const EVENT_NAMES: Record<EventId, string> = Object.fromEntries(
  EVENTS.map((e) => [e.id, e.name]),
) as Record<EventId, string>

export function eventName(id: EventId): string {
  return EVENT_NAMES[id] ?? id
}

/** csTimer caps sessions at a similar count; 20 keeps the picker usable. */
export const MAX_SESSIONS = 20

/** Fields every synced row carries, in addition to its own data. */
export interface Synced {
  /** Local clock, ms. Drives last-write-wins reconciliation. */
  updatedAt: number
  /**
   * Tombstone. Deletes are soft because a row removed outright is invisible
   * to another device, which would then resurrect it on the next pull.
   */
  deleted?: boolean
}

export interface Session extends Synced {
  id: string
  name: string
  /** Which event this session scrambles for. Changeable after the fact. */
  event: EventId
  createdAt: number
  /**
   * Target time in ms for the sub-X rate. Per session, because sub-12 on 3x3
   * and sub-60 on 4x4 are not the same question. Unset until chosen.
   */
  goalMs?: number
  /**
   * Accent slot 1-8, indexing the theme's series hues rather than a literal
   * color, so a session keeps its identity when the theme changes.
   */
  color?: number
}

/** Accent slots offered for sessions, in the palette's fixed order. */
export const SESSION_COLORS = [1, 2, 3, 4, 5, 7, 8] as const

import type { ParityId } from './parity'

export type Penalty = 'none' | 'plus2' | 'dnf'

export interface Solve extends Synced {
  id: string
  sessionId: string
  scramble: string
  /**
   * Which parities occurred. `[]` means none; `undefined` means the solve was
   * recorded without parity tracking, which is different from "none" and is
   * kept out of parity statistics rather than counted as clean.
   */
  parity?: ParityId[]
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
