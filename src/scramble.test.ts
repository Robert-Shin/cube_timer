import { describe, expect, it, vi } from 'vitest'

vi.mock('cubing/scramble', () => ({
  randomScrambleForEvent: vi.fn(async (event: string) => ({
    toString: () => `scramble-for-${event}`,
  })),
}))

const { newScrambles } = await import('./scramble')
const { eventDiscipline, relayDiscipline } = await import('./discipline')

describe('newScrambles', () => {
  it('returns exactly one scramble for a single-event discipline', async () => {
    // One code path for both kinds: the caller always gets an array.
    expect(await newScrambles(eventDiscipline('333'))).toEqual(['scramble-for-333'])
  })

  it('returns one scramble per leg, in leg order', async () => {
    expect(await newScrambles(relayDiscipline(['222', '333', '444']))).toEqual([
      'scramble-for-222',
      'scramble-for-333',
      'scramble-for-444',
    ])
  })
})
