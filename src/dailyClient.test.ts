import { describe, expect, it } from 'vitest'
import { classifySubmitError } from './dailyClient'

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
