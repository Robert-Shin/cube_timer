import { randomScrambleForEvent } from 'cubing/scramble'
import type { EventId } from './types'

/**
 * Random-STATE scrambles from cubing.js (the WCA standard), not random moves.
 * The first call per event loads a solver in a worker, so it can take a moment.
 */
export async function newScramble(event: EventId): Promise<string> {
  const alg = await randomScrambleForEvent(event)
  return alg.toString()
}
