import type { Synced } from '../types'

type Row = Synced & { id: string }

/**
 * Reconciles two sets of rows by last-write-wins on `updatedAt`.
 *
 * Pure and total: no clock, no network, no ordering assumptions. Everything
 * hard about sync is decided here, so it can be tested exhaustively without a
 * database.
 *
 * Ties go to `local`. A tie means the same row was stamped in the same
 * millisecond on both sides, which in practice is the row we just pushed
 * coming back to us -- keeping local avoids a pointless write.
 */
export function mergeRows<T extends Row>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of local) byId.set(row.id, row)

  for (const row of remote) {
    const mine = byId.get(row.id)
    if (!mine || row.updatedAt > mine.updatedAt) byId.set(row.id, row)
  }

  return [...byId.values()]
}

/**
 * Restores the newest-first order the UI and the statistics depend on.
 *
 * mergeRows is deliberately order-agnostic -- it unions by id, so remote-only
 * rows land wherever the server happened to return them. Every caller that
 * puts rows back into the store must re-establish the invariant, or ao5 is
 * computed from the oldest five solves instead of the newest five.
 */
export function newestFirst<T extends Row & { createdAt: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt)
}

/** Rows changed since the last successful push. */
export function dirtyRows<T extends Row>(rows: T[], since: number): T[] {
  return rows.filter((r) => r.updatedAt > since)
}

/**
 * Drops tombstoned rows. Applied only when handing data to the UI --
 * tombstones must stay in the store, or the next device that still holds the
 * row would resurrect it.
 */
export function visible<T extends Row>(rows: T[]): T[] {
  return rows.filter((r) => !r.deleted)
}
