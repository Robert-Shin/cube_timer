import type { EventId } from './types'

/**
 * The events that have a daily challenge, i.e. the ones
 * `scripts/generate-scrambles.mjs` generates a shared scramble for. Anything
 * else (333oh, 333bf, 333fm, …) has no board and no scramble, so publishing a
 * daily best for it only writes rows nobody ever queries.
 *
 * MIRRORED in scripts/generate-scrambles.mjs (`EVENTS`), which is plain .mjs
 * and cannot import this .ts module. Change one, change the other.
 */
export const CHALLENGE_EVENTS: EventId[] = [
  '222', '333', '444', '555', '666', '777', 'minx', 'pyram', 'skewb', 'sq1', 'clock',
]

const SET = new Set<string>(CHALLENGE_EVENTS)

export function isChallengeEvent(event: EventId): boolean {
  return SET.has(event)
}
