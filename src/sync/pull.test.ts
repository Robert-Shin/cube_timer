import { describe, expect, it } from 'vitest'
import { PAGE, needsFullPull, paginate } from './pull'

/** A fake table of `total` rows that honours an inclusive range request. */
const table = (total: number, cap = PAGE) => {
  const calls: [number, number][] = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    const end = Math.min(to, from + cap - 1)
    return Array.from({ length: Math.max(0, Math.min(end, total - 1) - from + 1) }, (_, i) => from + i)
  }
  return { page, calls }
}

describe('paginate', () => {
  it('reads a single short page without asking for a second', async () => {
    const t = table(3, 10)
    expect(await paginate(t.page, 10)).toEqual([0, 1, 2])
    expect(t.calls).toEqual([[0, 9]])
  })

  it('reads every row when the total is a multiple of the page size', async () => {
    // The case a `length === 0` guard alone gets wrong: the third request is
    // what proves the data ended, so it has to be made.
    const t = table(20, 10)
    expect(await paginate(t.page, 10)).toHaveLength(20)
    expect(t.calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ])
  })

  it('keeps paging past the server cap instead of stopping at one page', async () => {
    // The regression this file exists for: a server that truncates every
    // response to `cap` rows, with far more rows than that behind it. A
    // single unbounded select returns cap rows and looks successful.
    const t = table(4500, 1000)
    const rows = await paginate(t.page, 1000)
    expect(rows).toHaveLength(4500)
    expect(new Set(rows).size).toBe(4500)
  })

  it('returns nothing for an empty table', async () => {
    expect(await paginate(table(0).page)).toEqual([])
  })
})

describe('needsFullPull', () => {
  it('is true when the server holds solves this device does not', () => {
    // The incident's own numbers.
    expect(needsFullPull({ sessions: 16, solves: 4517 }, { sessions: 16, solves: 1023 })).toBe(true)
  })

  it('is true when the server holds sessions this device does not', () => {
    expect(needsFullPull({ sessions: 16, solves: 1023 }, { sessions: 10, solves: 1023 })).toBe(true)
  })

  it('is false when the two sides agree', () => {
    expect(needsFullPull({ sessions: 16, solves: 4517 }, { sessions: 16, solves: 4517 })).toBe(false)
  })

  it('is false when local is ahead -- unpushed rows are not missing rows', () => {
    expect(needsFullPull({ sessions: 2, solves: 10 }, { sessions: 3, solves: 14 })).toBe(false)
  })
})
