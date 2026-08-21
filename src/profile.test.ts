import { describe, expect, it } from 'vitest'
import { classifyClaimError, normalizeUsername, validateUsername } from './profile'

describe('normalizeUsername', () => {
  it('trims the ends and collapses interior runs', () => {
    expect(normalizeUsername('  Rob   Shin  ')).toBe('Rob Shin')
  })

  it('leaves a single interior space alone', () => {
    expect(normalizeUsername('Rob Shin')).toBe('Rob Shin')
  })

  it('reduces an all-whitespace name to empty, which validation then rejects', () => {
    expect(normalizeUsername('    ')).toBe('')
  })
})

describe('validateUsername', () => {
  it('accepts the boundaries', () => {
    expect(validateUsername('abc')).toBeNull()
    expect(validateUsername('a'.repeat(20))).toBeNull()
    expect(validateUsername('Rob Shin 3')).toBeNull()
  })

  it('rejects one character either side of the boundaries', () => {
    expect(validateUsername('ab')).not.toBeNull()
    expect(validateUsername('a'.repeat(21))).not.toBeNull()
  })

  it('rejects punctuation and emoji', () => {
    for (const bad of ['rob-shin', 'rob_shin', 'rob.shin', 'rob!', '🧊cuber']) {
      expect(validateUsername(bad), bad).not.toBeNull()
    }
  })

  it('rejects whitespace the normalizer would have removed', () => {
    // Defence in depth: these are unreachable via normalizeUsername, but they
    // are exactly what the database constraint refuses, and the two must agree.
    for (const bad of [' rob', 'rob ', 'rob  shin', '']) {
      expect(validateUsername(bad), JSON.stringify(bad)).not.toBeNull()
    }
  })
})

describe('classifyClaimError', () => {
  it('treats no error as claimed', () => {
    expect(classifyClaimError(null)).toBe('claimed')
  })

  it('reads a unique violation as the name being taken', () => {
    expect(classifyClaimError({ code: '23505' })).toBe('taken')
  })

  it('reads a check violation as client and server validation having drifted', () => {
    expect(classifyClaimError({ code: '23514' })).toBe('invalid')
  })

  it('retries anything unfamiliar', () => {
    // Same reasoning as classifySubmitError: an unknown failure is far more
    // likely transient than a permanent refusal, and a claim is safe to repeat.
    expect(classifyClaimError({ code: 'PGRST301' })).toBe('retry')
    expect(classifyClaimError({})).toBe('retry')
  })
})
