import { describe, expect, it } from 'vitest'
import { classifySubmitError, planBestOfDay } from './dailyClient'
import type { Solve } from './types'

describe('classifySubmitError', () => {
  it('treats no error as accepted', () => {
    expect(classifySubmitError(null)).toBe('accepted')
  })

  it('settles an already-submitted result by code or by message', () => {
    expect(classifySubmitError({ code: 'CS001', message: 'whatever' })).toBe('settled')
    expect(classifySubmitError({ message: 'already submitted today' })).toBe('settled')
  })

  it('permanently rejects the business-logic failures submit_daily raises', () => {
    for (const message of [
      'not signed in',
      'unknown penalty',
      'time_ms must be positive',
      'no attempt: reveal the scramble first',
      'submitted time exceeds elapsed time since reveal',
    ]) {
      expect(classifySubmitError({ code: 'P0001', message })).toBe('rejected')
    }
  })

  it('retries transient failures that still carry a code', () => {
    // Losing a result is unrecoverable -- the attempt row is already revealed
    // -- so anything short of a definitive refusal must be kept.
    expect(classifySubmitError({ code: 'PGRST301', message: 'JWT expired' })).toBe('retry')
    expect(classifySubmitError({ code: '40001', message: 'serialization failure' })).toBe('retry')
    expect(classifySubmitError({ code: '40P01', message: 'deadlock detected' })).toBe('retry')
  })

  it('retries an error with no code, and any unfamiliar code', () => {
    expect(classifySubmitError({ message: 'Failed to fetch' })).toBe('retry')
    expect(classifySubmitError({ code: '', message: 'TypeError' })).toBe('retry')
    expect(classifySubmitError({ code: 'XX999', message: 'internal error' })).toBe('retry')
  })
})

describe('planBestOfDay', () => {
  const day = '2026-08-22'
  const solve = (over: Partial<Solve>): Solve =>
    ({
      id: crypto.randomUUID(),
      sessionId: 's',
      timeMs: 10_000,
      penalty: 'none',
      scramble: '',
      createdAt: Date.parse(`${day}T12:00:00Z`),
      updatedAt: Date.parse(`${day}T12:00:00Z`),
      ...over,
    }) as Solve

  it('publishes the fastest ordinary solve of the day', () => {
    const plan = planBestOfDay([solve({ timeMs: 12_000 }), solve({ timeMs: 9_500 })], day, {
      canRetract: true,
    })
    expect(plan).toEqual({ action: 'publish', timeMs: 9_500 })
  })

  it('retracts when the store is complete and the day is genuinely empty', () => {
    expect(planBestOfDay([], day, { canRetract: true })).toEqual({ action: 'retract' })
  })

  it('does nothing when there is no best and the store may not be populated', () => {
    // The new-device wipe: an empty local store is indistinguishable from "no
    // solves today", and retracting on that guess deletes a real published row.
    expect(planBestOfDay([], day, { canRetract: false })).toEqual({ action: 'none' })
  })

  it('still publishes from an incomplete store -- only retraction is destructive', () => {
    expect(planBestOfDay([solve({ timeMs: 8_000 })], day, { canRetract: false })).toEqual({
      action: 'publish',
      timeMs: 8_000,
    })
  })
})
