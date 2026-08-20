import { describe, expect, it } from 'vitest'
import { dirtyRows, mergeRows, newestFirst, visible } from './merge'

const row = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, updatedAt, ...extra }) as never

const ids = (rows: { id: string; updatedAt: number }[]) =>
  rows.map((r) => `${r.id}@${r.updatedAt}`).sort()

describe('mergeRows', () => {
  it('takes the newer side per row', () => {
    expect(ids(mergeRows([row('a', 1)], [row('a', 2)]))).toEqual(['a@2'])
    expect(ids(mergeRows([row('a', 5)], [row('a', 3)]))).toEqual(['a@5'])
  })

  it('keeps local on a tie, avoiding a pointless write-back', () => {
    const merged = mergeRows([row('a', 4, { v: 'L' })], [row('a', 4, { v: 'R' })])
    expect((merged[0] as { v: string }).v).toBe('L')
  })

  it('unions rows present on only one side', () => {
    expect(ids(mergeRows([row('a', 1)], [row('b', 1)]))).toEqual(['a@1', 'b@1'])
    expect(mergeRows([], [])).toEqual([])
  })

  it('lets a newer tombstone win, and an older one lose', () => {
    expect(mergeRows([row('a', 1, { deleted: false })], [row('a', 9, { deleted: true })])[0])
      .toHaveProperty('deleted', true)
    expect(mergeRows([row('a', 9, { deleted: false })], [row('a', 2, { deleted: true })])[0])
      .toHaveProperty('deleted', false)
  })

  it('never resurrects a deleted row on a later round-trip', () => {
    // The other device still holds the pre-delete row and pushes it back.
    const afterDelete = mergeRows([row('a', 1)], [row('a', 5, { deleted: true })])
    expect(mergeRows(afterDelete, [row('a', 1)])[0]).toHaveProperty('deleted', true)
  })

  it('is order-independent and idempotent', () => {
    const local = [row('a', 3), row('b', 1)]
    const remote = [row('a', 7), row('c', 2, { deleted: true })]
    expect(ids(mergeRows(local, remote))).toEqual(ids(mergeRows(remote, local)))
    expect(ids(mergeRows(mergeRows(local, remote), remote))).toEqual(
      ids(mergeRows(local, remote)),
    )
  })
})

describe('dirtyRows', () => {
  it('returns rows strictly newer than the cursor', () => {
    expect(ids(dirtyRows([row('a', 1), row('b', 5), row('c', 9)], 4))).toEqual(['b@5', 'c@9'])
  })

  it('excludes a row stamped exactly at the cursor', () => {
    expect(dirtyRows([row('a', 5)], 5)).toHaveLength(0)
  })
})

describe('visible', () => {
  it('hides tombstones without removing them from the caller array', () => {
    const rows = [row('a', 1), row('b', 2, { deleted: true })]
    expect(ids(visible(rows))).toEqual(['a@1'])
    expect(rows).toHaveLength(2)
  })
})

describe('newestFirst', () => {
  const solve = (id: string, createdAt: number) => ({ id, updatedAt: 0, createdAt })

  it('orders by createdAt, newest first', () => {
    const out = newestFirst([solve('old', 100), solve('new', 300), solve('mid', 200)])
    expect(out.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('restores the invariant after a merge appends remote rows in server order', () => {
    // A fresh device pulls everything: the local side is empty, so every row
    // arrives in the order the server returned it -- oldest first.
    const remote = [solve('a', 100), solve('b', 200), solve('c', 300)]
    const merged = mergeRows([], remote)
    expect(newestFirst(merged).map((s) => s.id)).toEqual(['c', 'b', 'a'])
  })
})
