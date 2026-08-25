import { describe, expect, it, vi } from 'vitest'
import { classifyRequestError, currentStreak, partitionFriendships, toSolves } from './friends'

const ME = 'me-uuid'

describe('friendProfile', () => {
  it('resolves to null, not a rejected promise, when the fetch layer fails outright', async () => {
    // Simulates offline/DNS/TLS: supabase-js rejects rather than resolving
    // with an `error` field. friendProfile's docstring promises null means
    // failure; before the fix, this rejection escaped the Promise.all and
    // the caller got an unhandled rejection instead.
    vi.resetModules()
    vi.doMock('./supabase', () => ({
      supabase: {
        rpc: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      },
      syncConfigured: true,
    }))

    const { friendProfile } = await import('./friends')
    await expect(friendProfile('friend-uuid', '333', 30)).resolves.toBeNull()

    vi.doUnmock('./supabase')
    vi.resetModules()
  })
})

describe('partitionFriendships', () => {
  it('splits a pending request by which side I am on', () => {
    const rows = [
      { requester: ME, addressee: 'x', state: 'pending' as const },
      { requester: 'y', addressee: ME, state: 'pending' as const },
    ]
    expect(partitionFriendships(rows, ME)).toEqual({
      accepted: [],
      incoming: ['y'],
      outgoing: ['x'],
    })
  })

  it('reports an accepted friendship as the other party, whichever side sent it', () => {
    const rows = [
      { requester: ME, addressee: 'x', state: 'accepted' as const },
      { requester: 'y', addressee: ME, state: 'accepted' as const },
    ]
    const out = partitionFriendships(rows, ME)
    expect(out.accepted.sort()).toEqual(['x', 'y'])
    expect(out.incoming).toEqual([])
    expect(out.outgoing).toEqual([])
  })

  it('returns empty lists for no rows', () => {
    expect(partitionFriendships([], ME)).toEqual({
      accepted: [], incoming: [], outgoing: [],
    })
  })
})

describe('currentStreak', () => {
  const TODAY = '2026-08-22'
  const YDAY = '2026-08-21'
  const DAY_BEFORE = '2026-08-20'
  const THREE_AGO = '2026-08-19'

  it('is 0 for an empty history', () => {
    expect(currentStreak([], TODAY)).toBe(0)
  })

  it('is 0 when the streak was already broken yesterday', () => {
    // Active three days ago, but a gap at both yesterday and today: the
    // streak is over, not just "not extended yet".
    const days = [{ day: THREE_AGO, solves: 2 }]
    expect(currentStreak(days, TODAY)).toBe(0)
  })

  it('counts a streak that runs all the way to today', () => {
    const days = [
      { day: TODAY, solves: 3 },
      { day: YDAY, solves: 1 },
      { day: DAY_BEFORE, solves: 5 },
    ]
    expect(currentStreak(days, TODAY)).toBe(3)
  })

  it('does not zero out a streak just because today has no solves yet', () => {
    // Today is not over. Yesterday (and before) were active, so the streak
    // is still alive pending today's solves -- reporting 0 here would be a
    // false "you broke your streak" the moment the clock rolls over UTC.
    const days = [
      { day: YDAY, solves: 4 },
      { day: DAY_BEFORE, solves: 2 },
    ]
    expect(currentStreak(days, TODAY)).toBe(2)
  })

  it('counts a single active day as a streak of 1', () => {
    expect(currentStreak([{ day: TODAY, solves: 1 }], TODAY)).toBe(1)
  })

  it('counts today alone as 1 even when yesterday has an explicit zero-solve row', () => {
    const days = [
      { day: TODAY, solves: 1 },
      { day: YDAY, solves: 0 },
    ]
    expect(currentStreak(days, TODAY)).toBe(1)
  })

  it('ignores a zero-solve day row the same as a missing one', () => {
    const days = [
      { day: TODAY, solves: 0 },
      { day: YDAY, solves: 5 },
      { day: DAY_BEFORE, solves: 5 },
    ]
    expect(currentStreak(days, TODAY)).toBe(2)
  })

  it('crosses a year boundary without losing the streak', () => {
    const days = [
      { day: '2026-01-01', solves: 1 },
      { day: '2025-12-31', solves: 2 },
      { day: '2025-12-30', solves: 3 },
    ]
    expect(currentStreak(days, '2026-01-01')).toBe(3)
  })

  it('crosses a month boundary without losing the streak', () => {
    const days = [
      { day: '2026-09-01', solves: 1 },
      { day: '2026-08-31', solves: 2 },
      { day: '2026-08-30', solves: 3 },
    ]
    expect(currentStreak(days, '2026-09-01')).toBe(3)
  })

  it('crosses a leap day without losing the streak', () => {
    const days = [
      { day: '2028-03-01', solves: 1 },
      { day: '2028-02-29', solves: 2 },
      { day: '2028-02-28', solves: 3 },
    ]
    expect(currentStreak(days, '2028-03-01')).toBe(3)
  })
})

describe('classifyRequestError', () => {
  it('treats no error as sent', () => {
    expect(classifyRequestError(null)).toBe('sent')
  })

  it('reads a foreign key violation as no such user', () => {
    // The username resolved to nothing, or to someone with no profile row.
    expect(classifyRequestError({ code: '23503', message: 'violates foreign key' }))
      .toBe('no-such-user')
  })

  it('reads a unique violation as already requested or already friends', () => {
    // The friendships_pair index refuses a second row for the pair, in
    // either direction.
    expect(classifyRequestError({ code: '23505', message: 'duplicate key' }))
      .toBe('already')
  })

  it('retries anything unfamiliar rather than reporting a wrong reason', () => {
    expect(classifyRequestError({ code: 'PGRST301', message: 'JWT expired' })).toBe('retry')
    expect(classifyRequestError({ message: 'Failed to fetch' })).toBe('retry')
  })
})

describe('toSolves', () => {
  const rows = [
    { day: '2026-08-25', time_ms: 12_340, penalty: 'none' },
    { day: '2026-08-24', time_ms: 23_450, penalty: 'plus2' },
    { day: '2026-08-24', time_ms: 34_560, penalty: 'dnf' },
  ]

  it('preserves the server order, which is what averageOf reads', () => {
    expect(toSolves(rows, 'sess').map((s) => s.timeMs)).toEqual([12_340, 23_450, 34_560])
  })

  it('round-trips penalties, so a friend DNF stays a DNF', () => {
    expect(toSolves(rows, 'sess').map((s) => s.penalty)).toEqual(['none', 'plus2', 'dnf'])
  })

  it('treats an unrecognised penalty as none rather than trusting the server string', () => {
    const odd = [{ day: '2026-08-25', time_ms: 1000, penalty: 'wat' }]
    expect(toSolves(odd, 'sess')[0].penalty).toBe('none')
  })

  it('gives each solve a distinct id, since React keys off it', () => {
    const ids = toSolves(rows, 'sess').map((s) => s.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('leaves parity undefined -- untracked, not "measured as none"', () => {
    expect(toSolves(rows, 'sess')[0].parity).toBeUndefined()
  })

  it('turns the day into a timestamp the trend tooltip can print', () => {
    const [first] = toSolves(rows, 'sess')
    expect(new Date(first.createdAt).toISOString().slice(0, 10)).toBe('2026-08-25')
  })
})
