import { EVENT_NAMES, eventName, type EventId } from './types'

/**
 * What a session is practising. Not the same thing as a WCA event: a relay
 * puts several scrambles on screen for one time, so it has no EventId and
 * never will.
 *
 * The single-event variant is the only one any picker offers today. The
 * relay variant exists now so that shipping relays later adds a case here
 * rather than migrating every session row and every friend RPC a second
 * time.
 */
export type Discipline =
  | { kind: 'event'; event: EventId }
  | { kind: 'relay'; events: EventId[] }

export const eventDiscipline = (event: EventId): Discipline => ({ kind: 'event', event })
export const relayDiscipline = (events: EventId[]): Discipline => ({ kind: 'relay', events })

/**
 * The stable string a session stores and the app keys state by.
 *
 * A single-event key is byte-identical to its EventId, which is the whole
 * reason no data migration is needed: `sessions.event` is a text column that
 * already holds exactly these values, and every row written before
 * disciplines existed is already a valid key.
 */
export function disciplineKey(d: Discipline): string {
  return d.kind === 'event' ? d.event : `relay:${d.events.join('+')}`
}

const isEventId = (s: string): s is EventId => s in EVENT_NAMES

/** Inverse of disciplineKey. Null for anything this build cannot name. */
export function parseDiscipline(key: string): Discipline | null {
  if (!key.startsWith('relay:')) return isEventId(key) ? eventDiscipline(key) : null

  const legs = key.slice('relay:'.length).split('+')
  // An empty key splits to [''], which is not an event -- so the isEventId
  // check below rejects it without needing a separate length test.
  if (!legs.every(isEventId)) return null
  return relayDiscipline(legs)
}

/** The events a discipline scrambles, in the order they are shown. */
export function disciplineEvents(d: Discipline): EventId[] {
  return d.kind === 'event' ? [d.event] : d.events
}

/** '222'|'333'|... -> 2|3|..., or null for anything not an NxN cube. */
function cubeOrder(e: EventId): number | null {
  return /^([2-7])\1\1$/.test(e) ? Number(e[0]) : null
}

/**
 * '3x3', '2-5 Relay', '2x2 + 3x3 + Skewb Relay'.
 *
 * A contiguous run of NxN cubes contracts to a range because that is what
 * cubers call it; anything else is spelled out rather than given a range
 * that would misdescribe which puzzles are in it.
 */
export function disciplineLabel(d: Discipline): string {
  if (d.kind === 'event') return eventName(d.event)

  const orders = d.events.map(cubeOrder)
  const contiguous =
    orders.length > 1 &&
    orders.every((n, i) => n !== null && (i === 0 || n === orders[i - 1]! + 1))
  if (contiguous) return `${orders[0]}-${orders[orders.length - 1]} Relay`

  return `${d.events.map(eventName).join(' + ')} Relay`
}

/**
 * The single event a discipline scrambles, or null for a relay.
 *
 * Returns null rather than the first leg on purpose: every caller that needs
 * one event -- scramble generation, parity tracking, the daily challenge --
 * is a place that will have to be reconsidered when relays ship, and a
 * silent `events[0]` would hide all of them.
 */
export function soleEvent(d: Discipline): EventId | null {
  return d.kind === 'event' ? d.event : null
}
