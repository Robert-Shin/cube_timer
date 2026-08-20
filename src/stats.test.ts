import { describe, expect, it } from 'vitest'
import { averageOf, best, sessionMean, stdDev, subXRate, suggestGoal } from './stats'
import type { Penalty, Solve } from './types'

const mk = (ms: number, penalty: Penalty = 'none'): Solve => ({
  id: String(ms) + penalty + Math.random(),
  sessionId: 's',
  scramble: '',
  timeMs: ms,
  penalty,
  createdAt: 0,
  updatedAt: 0,
})

describe('empty and no-data cases', () => {
  // An empty session must not report DNF: that would claim every solve
  // failed when there are no solves at all.
  it('returns null, not a DNF-shaped value, with no solves', () => {
    expect(best([])).toBeNull()
    expect(sessionMean([])).toBeNull()
    expect(stdDev([])).toBeNull()
    expect(subXRate([], 12000)).toBeNull()
    expect(suggestGoal([])).toBeNull()
  })

  it('distinguishes "not enough solves" from "the average is a DNF"', () => {
    expect(averageOf([mk(1000)], 5)).toBeUndefined()
    expect(averageOf([mk(1000), mk(1, 'dnf'), mk(1, 'dnf'), mk(2000), mk(3000)], 5)).toBeNull()
  })

  it('reports null spread for a single solve, where spread is undefined', () => {
    expect(stdDev([mk(1000)])).toBeNull()
  })

  it('ignores DNFs for best and mean but not for sub-X', () => {
    const solves = [mk(10000), mk(1, 'dnf')]
    expect(best(solves)).toBe(10000)
    expect(sessionMean(solves)).toBe(10000)
    expect(subXRate(solves, 12000)!.rate).toBe(0.5)
  })
})

describe('stdDev', () => {
  it('matches a hand-computed sample standard deviation', () => {
    // [2,4,4,4,5,5,7,9] -> sample sd 2.13809, population 2
    const sd = stdDev([2, 4, 4, 4, 5, 5, 7, 9].map((n) => mk(n * 1000)))!
    expect(sd / 1000).toBeCloseTo(2.13809, 4)
  })
})

describe('subXRate', () => {
  it('excludes the boundary: sub-12 means under 12, not 12', () => {
    expect(subXRate([mk(12000)], 12000)!.under).toBe(0)
    expect(subXRate([mk(11990)], 12000)!.under).toBe(1)
  })

  it('counts DNFs in the denominator', () => {
    const r = subXRate([mk(9000), mk(11000), mk(13000), mk(1, 'dnf')], 12000)!
    expect(r.under).toBe(2)
    expect(r.total).toBe(4)
  })
})

describe('suggestGoal', () => {
  it('uses coarser steps for slower events', () => {
    expect(suggestGoal([mk(12400)])).toBe(12000)
    expect(suggestGoal([mk(47000)])).toBe(45000)
    expect(suggestGoal([mk(152000)])).toBe(150000)
  })
})
