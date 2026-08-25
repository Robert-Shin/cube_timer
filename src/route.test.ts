import { describe, expect, it } from 'vitest'
import { friendHash, parseRoute } from './route'

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

describe('parseRoute', () => {
  it('reads a friend route', () => {
    expect(parseRoute(`#/friend/${UUID}`)).toEqual({ kind: 'friend', userId: UUID })
  })

  it('treats an empty hash as your own app', () => {
    expect(parseRoute('')).toEqual({ kind: 'self' })
    expect(parseRoute('#')).toEqual({ kind: 'self' })
    expect(parseRoute('#/')).toEqual({ kind: 'self' })
  })

  it('rejects anything that is not a uuid, rather than passing it to an RPC', () => {
    expect(parseRoute('#/friend/not-a-uuid')).toEqual({ kind: 'self' })
    expect(parseRoute('#/friend/')).toEqual({ kind: 'self' })
    expect(parseRoute(`#/friend/${UUID}/extra`)).toEqual({ kind: 'self' })
    expect(parseRoute(`#/friend/${UUID}' or 1=1--`)).toEqual({ kind: 'self' })
  })

  it('ignores an unknown route', () => {
    expect(parseRoute('#/settings')).toEqual({ kind: 'self' })
  })

  it('round-trips through friendHash', () => {
    expect(parseRoute(friendHash(UUID))).toEqual({ kind: 'friend', userId: UUID })
  })
})
