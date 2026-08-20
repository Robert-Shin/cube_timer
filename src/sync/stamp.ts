import type { Synced } from '../types'

/** Single source of "now" for sync stamps, so tests can reason about order. */
export function now(): number {
  return Date.now()
}

/**
 * Marks a row as changed. Every mutation goes through this: a row edited
 * without bumping `updatedAt` would lose the next reconciliation and silently
 * revert.
 */
export function touch<T extends Synced>(row: T, fields: Partial<T> = {}): T {
  return { ...row, ...fields, updatedAt: now() }
}

/** Tombstones a row. Deletes are soft so other devices learn about them. */
export function tombstone<T extends Synced>(row: T): T {
  return { ...row, deleted: true, updatedAt: now() }
}
