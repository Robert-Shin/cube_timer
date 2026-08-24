import { describe, expect, it } from 'vitest'
import {
  disciplineEvents,
  disciplineKey,
  disciplineLabel,
  eventDiscipline,
  parseDiscipline,
  relayDiscipline,
  soleEvent,
  type Discipline,
} from './discipline'
import { EVENTS } from './types'

describe('disciplineKey', () => {
  it('serialises a single event to the bare EventId', () => {
    // Byte-identical to today's stored value, which is what lets every
    // existing sessions.event row load as a discipline with no migration.
    expect(disciplineKey(eventDiscipline('333'))).toBe('333')
  })

  it('gives every EventId a key equal to itself', () => {
    for (const e of EVENTS) expect(disciplineKey(eventDiscipline(e.id))).toBe(e.id)
  })

  it('serialises a relay with its legs in order', () => {
    expect(disciplineKey(relayDiscipline(['222', '333', '444', '555'])))
      .toBe('relay:222+333+444+555')
  })

  it('keeps leg order significant', () => {
    expect(disciplineKey(relayDiscipline(['333', '222'])))
      .not.toBe(disciplineKey(relayDiscipline(['222', '333'])))
  })
})

describe('parseDiscipline', () => {
  const roundTrips = (d: Discipline) => expect(parseDiscipline(disciplineKey(d))).toEqual(d)

  it('round-trips every single-event discipline', () => {
    for (const e of EVENTS) roundTrips(eventDiscipline(e.id))
  })

  it('round-trips a relay', () => {
    roundTrips(relayDiscipline(['222', '333', '444', '555']))
  })

  it('rejects an unknown event id', () => {
    expect(parseDiscipline('444x4')).toBeNull()
  })

  it('rejects a relay naming an unknown event', () => {
    expect(parseDiscipline('relay:222+nope')).toBeNull()
  })

  it('rejects an empty relay', () => {
    expect(parseDiscipline('relay:')).toBeNull()
  })
})

describe('disciplineLabel', () => {
  it('labels a single event with its event name', () => {
    expect(disciplineLabel(eventDiscipline('333'))).toBe('3x3')
    expect(disciplineLabel(eventDiscipline('333oh'))).toBe('3x3 OH')
  })

  it('contracts a contiguous NxN relay to its range', () => {
    expect(disciplineLabel(relayDiscipline(['222', '333', '444', '555']))).toBe('2-5 Relay')
    expect(disciplineLabel(relayDiscipline(['222', '333', '444']))).toBe('2-4 Relay')
  })

  it('spells out a relay that is not a contiguous NxN run', () => {
    expect(disciplineLabel(relayDiscipline(['222', '333', 'skewb'])))
      .toBe('2x2 + 3x3 + Skewb Relay')
    expect(disciplineLabel(relayDiscipline(['222', '444'])))
      .toBe('2x2 + 4x4 Relay')
  })
})

describe('disciplineEvents', () => {
  it('gives the one event of a single-event discipline', () => {
    expect(disciplineEvents(eventDiscipline('555'))).toEqual(['555'])
  })

  it('gives every leg of a relay, in order', () => {
    expect(disciplineEvents(relayDiscipline(['222', '333']))).toEqual(['222', '333'])
  })
})

describe('soleEvent', () => {
  it('gives the event of a single-event discipline', () => {
    expect(soleEvent(eventDiscipline('333oh'))).toBe('333oh')
  })

  it('is null for a relay, rather than silently picking the first leg', () => {
    // The callers that need one event (scrambles, parity, the daily
    // challenge) all have to be reconsidered for relays; returning legs[0]
    // would hide every one of them.
    expect(soleEvent(relayDiscipline(['222', '333']))).toBeNull()
  })
})
