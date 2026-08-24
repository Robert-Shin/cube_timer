import { randomScrambleForEvent } from 'cubing/scramble'
import type { EventId } from './types'
import { disciplineEvents, type Discipline } from './discipline'

/**
 * Random-STATE scrambles from cubing.js (the WCA standard), not random moves.
 * The first call per event loads a solver in a worker, so it can take a moment.
 */
export async function newScramble(event: EventId): Promise<string> {
  const alg = await randomScrambleForEvent(event)
  return alg.toString()
}

/**
 * One scramble per leg, in leg order. A single-event discipline yields a
 * one-element array so the timer has a single code path for both kinds.
 *
 * Generated in parallel: the first call for an event loads a random-state
 * solver in a worker, and a four-leg relay would otherwise load them one
 * after another.
 */
export async function newScrambles(d: Discipline): Promise<string[]> {
  return Promise.all(disciplineEvents(d).map((e) => newScramble(e)))
}
