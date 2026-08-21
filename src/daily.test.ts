import { describe, expect, it } from 'vitest'
import { bestOfDay, utcDay } from './daily'
import type { Solve } from './types'

const solve = (over: Partial<Solve>): Solve => ({
  id: 'x', sessionId: 's', scramble: 'R U', timeMs: 10000,
  penalty: 'none', createdAt: Date.UTC(2026, 7, 20, 12), updatedAt: 0, ...over,
})

describe('utcDay', () => {
  it('formats as an ISO date', () => {
    expect(utcDay(Date.UTC(2026, 7, 20, 12))).toBe('2026-08-20')
  })

  it('uses UTC, not the local timezone, either side of midnight', () => {
    expect(utcDay(Date.UTC(2026, 7, 20, 23, 59))).toBe('2026-08-20')
    expect(utcDay(Date.UTC(2026, 7, 21, 0, 1))).toBe('2026-08-21')
  })
})

describe('bestOfDay', () => {
  const day = '2026-08-20'

  it('returns the fastest solve of that day', () => {
    const list = [
      solve({ id: 'a', timeMs: 12000 }),
      solve({ id: 'b', timeMs: 9000 }),
      solve({ id: 'c', timeMs: 11000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('b')
  })

  it('ignores solves from other days', () => {
    const list = [
      solve({ id: 'yesterday', timeMs: 5000, createdAt: Date.UTC(2026, 7, 19, 12) }),
      solve({ id: 'today', timeMs: 9000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('today')
  })

  it('excludes DNFs and deleted solves', () => {
    const list = [
      solve({ id: 'dnf', timeMs: 1000, penalty: 'dnf' }),
      solve({ id: 'gone', timeMs: 2000, deleted: true }),
      solve({ id: 'real', timeMs: 9000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('real')
  })

  it('ranks on the +2-adjusted time, not the raw one', () => {
    const list = [
      solve({ id: 'penalised', timeMs: 9000, penalty: 'plus2' }), // 11.00
      solve({ id: 'clean', timeMs: 10000 }),                      // 10.00
    ]
    const best = bestOfDay(list, '333', day)
    expect(best?.solve.id).toBe('clean')
    expect(best?.ms).toBe(10000)
  })

  it('returns null when the day has no usable solve', () => {
    expect(bestOfDay([], '333', day)).toBeNull()
    expect(bestOfDay([solve({ penalty: 'dnf' })], '333', day)).toBeNull()
  })
})
