import { describe, expect, it } from 'vitest'
import { BUCKET_OPTIONS, suggestBucket } from './analysis'
import type { Solve } from './types'

const solve = (timeMs: number, penalty: Solve['penalty'] = 'none'): Solve => ({
  id: String(timeMs) + penalty,
  sessionId: 's',
  scramble: '',
  timeMs,
  penalty,
  createdAt: 0,
  updatedAt: 0,
})

describe('suggestBucket', () => {
  it('only ever returns an offered width', () => {
    for (const spread of [200, 2_000, 20_000, 200_000]) {
      const got = suggestBucket([solve(10_000), solve(10_000 + spread)])
      expect(BUCKET_OPTIONS).toContain(got as (typeof BUCKET_OPTIONS)[number])
    }
  })

  it('picks a fine bucket for a tight 3x3 spread', () => {
    // 11.00-14.00: a 3s range wants ~0.1s bins.
    expect(suggestBucket([solve(11_000), solve(14_000)])).toBe(100)
  })

  it('picks the coarsest bucket for a wide 4x4 spread', () => {
    // 46s-1:28: 0.1s bins would be ~420 of them.
    expect(suggestBucket([solve(46_000), solve(88_000)])).toBe(1000)
  })

  it('ignores DNFs, which have no time to bin', () => {
    const solves = [solve(11_000), solve(14_000), solve(600_000, 'dnf')]
    expect(suggestBucket(solves)).toBe(100)
  })

  it('falls back to the old default when there is nothing to measure', () => {
    expect(suggestBucket([])).toBe(100)
    expect(suggestBucket([solve(12_000)])).toBe(100)
  })
})
