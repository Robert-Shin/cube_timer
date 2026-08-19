import type { EventId } from './types'

export type ParityId = 'oll' | 'pll' | 'edge'

export interface ParityType {
  id: ParityId
  label: string
  hint: string
}

/**
 * Which parities can occur on each event.
 *
 * The counts follow from the puzzle, not from a list:
 *  - PLL parity (a swapped pair) needs movable centers, so it happens on even
 *    cubes only -- 4x4 and 6x6, never 5x5 or 7x7.
 *  - OLL parity (a flipped dedge) can happen on any cube with dedges, 4x4 up.
 *  - A second, inner-slice dedge flip is possible once there are two edge
 *    pieces per edge to pair independently, i.e. 6x6 and 7x7.
 *
 * So: 4x4 -> 2, 5x5 -> 1, 6x6 -> 3, 7x7 -> 2. 2x2 and 3x3 have no dedges and
 * no movable centers, so no parity at all.
 */
const OLL: ParityType = {
  id: 'oll',
  label: 'OLL parity',
  hint: 'a single flipped dedge',
}
const PLL: ParityType = {
  id: 'pll',
  label: 'PLL parity',
  hint: 'a swapped pair — even cubes only',
}
const EDGE: ParityType = {
  id: 'edge',
  label: 'inner-edge parity',
  hint: 'flipped inner dedge during last two edges',
}

export const PARITY_BY_EVENT: Partial<Record<EventId, ParityType[]>> = {
  '444': [OLL, PLL],
  '555': [OLL],
  '666': [OLL, PLL, EDGE],
  '777': [OLL, EDGE],
}

export function parityTypes(event: EventId): ParityType[] {
  return PARITY_BY_EVENT[event] ?? []
}

export function hasParity(event: EventId): boolean {
  return parityTypes(event).length > 0
}

/** Stable order for a solve's parity list, so labels and keys always match. */
const ORDER: ParityId[] = ['oll', 'pll', 'edge']

export function sortParity(ids: ParityId[]): ParityId[] {
  return [...new Set(ids)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
}

/** "none", "OLL", "OLL + PLL" -- the category a solve falls into. */
export function parityLabel(event: EventId, ids: ParityId[] | undefined): string {
  if (ids === undefined) return 'untracked'
  if (ids.length === 0) return 'no parity'
  const types = parityTypes(event)
  return sortParity(ids)
    .map((id) => types.find((t) => t.id === id)?.label.replace(' parity', '') ?? id)
    .join(' + ')
}

/** Key used to group solves; distinct from the display label. */
export function parityKey(ids: ParityId[] | undefined): string {
  if (ids === undefined) return 'untracked'
  return ids.length === 0 ? 'none' : sortParity(ids).join('+')
}
