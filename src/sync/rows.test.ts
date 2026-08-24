import { describe, expect, it } from 'vitest'
import { rowToSolve, solveToRow, type SolveRow } from './rows'
import type { Solve } from '../types'

const solve = (over: Partial<Solve>): Solve => ({
  id: 's1', sessionId: 'n1', scramble: 'R U', timeMs: 12000,
  penalty: 'none', createdAt: 1000, updatedAt: 2000, ...over,
})

describe('splits round-trip', () => {
  it('carries recorded splits to the row and back', () => {
    const row = solveToRow(solve({ splits: [5000, 12000] }), 'u1')
    expect(row.splits).toEqual([5000, 12000])
    expect(rowToSolve(row).splits).toEqual([5000, 12000])
  })

  it('keeps "not recorded" distinct from "recorded as empty"', () => {
    // null in the column means untracked; [] means tracked with no
    // boundaries. Collapsing them would invent leg data that never existed.
    expect(solveToRow(solve({ splits: undefined }), 'u1').splits).toBeNull()
    expect(solveToRow(solve({ splits: [] }), 'u1').splits).toEqual([])

    expect(rowToSolve({ ...solveToRow(solve({}), 'u1'), splits: null }).splits).toBeUndefined()
    expect(rowToSolve({ ...solveToRow(solve({}), 'u1'), splits: [] } as SolveRow).splits).toEqual([])
  })
})
