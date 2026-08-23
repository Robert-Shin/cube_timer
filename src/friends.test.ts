import { describe, expect, it, vi } from 'vitest'
import { classifyRequestError, partitionFriendships } from './friends'

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
