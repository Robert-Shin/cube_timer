/**
 * The `profiles` table: who you are on the board, and whether you want to be on
 * it. Kept apart from dailyClient.ts, which owns the daily tables.
 */

/** Mirrors the `profiles_username_format` check constraint in schema.sql. */
const SHAPE = /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/

/** What the user typed, tidied: the ends trimmed, interior runs collapsed. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * An error to show, or null if the name is good. Deliberately duplicates the
 * database constraint rather than trusting it: the constraint is the authority,
 * but a round trip is a poor way to tell someone their name is too short.
 */
export function validateUsername(name: string): string | null {
  if (name.length < 3) return 'Names need at least 3 characters.'
  if (name.length > 20) return 'Names can be at most 20 characters.'
  if (!SHAPE.test(name)) return 'Use letters, numbers, and single spaces only.'
  return null
}

/**
 * 'claimed' — the name is now yours.
 * 'taken'   — 23505, someone holds it (case-insensitively).
 * 'invalid' — 23514: the database refused a name validateUsername accepted,
 *             which means the two have drifted. That is our bug, not the user's.
 * 'retry'   — anything else. Unlike a daily submission, a claim is safe to
 *             repeat, so an unfamiliar failure defaults to letting them try again.
 */
export type ClaimResult = 'claimed' | 'taken' | 'invalid' | 'retry'

export function classifyClaimError(err: { code?: string } | null): ClaimResult {
  if (!err) return 'claimed'
  if (err.code === '23505') return 'taken'
  if (err.code === '23514') return 'invalid'
  return 'retry'
}
