import { describe, expect, it } from 'vitest'
import {
  classifyClaimError,
  normalizeUsername,
  shouldClaimUsername,
  validateUsername,
} from './profile'

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

describe('shouldClaimUsername', () => {
  const NAMED = { username: 'Rob', optedIn: false }

  // Every combination of the four inputs, because this predicate alone decides
  // whether the app force-opens a modal with no Close button and disables the
  // timer behind it. The nonsense rows (loading and failed together, a profile
  // while still loading) are here too, so a refactor that reorders the clauses
  // cannot quietly change them either.
  const cases: Array<[string, Parameters<typeof shouldClaimUsername>[0], boolean]> = [
    ['signed out', { email: null, loading: false, failed: false, profile: null }, false],
    ['signed out, still loading', { email: null, loading: true, failed: false, profile: null }, false],
    ['signed out after a failure', { email: null, loading: false, failed: true, profile: null }, false],
    ['signed out with a stale profile', { email: null, loading: false, failed: false, profile: NAMED }, false],
    ['signed out, loading and failed', { email: null, loading: true, failed: true, profile: null }, false],
    ['signed out, loading with a profile', { email: null, loading: true, failed: false, profile: NAMED }, false],
    ['signed out, failed with a profile', { email: null, loading: false, failed: true, profile: NAMED }, false],
    ['signed out, every flag set', { email: null, loading: true, failed: true, profile: NAMED }, false],

    // The one true case: we know they are signed in, and we know they have no name.
    ['signed in with no name yet', { email: 'a@b.c', loading: false, failed: false, profile: null }, true],

    ['signed in, still loading', { email: 'a@b.c', loading: true, failed: false, profile: null }, false],
    ['signed in with a name', { email: 'a@b.c', loading: false, failed: false, profile: NAMED }, false],
    ['signed in, loading with a stale profile', { email: 'a@b.c', loading: true, failed: false, profile: NAMED }, false],
    ['signed in, load failed and nothing to show', { email: 'a@b.c', loading: false, failed: true, profile: null }, false],
    ['signed in, load failed with a name already', { email: 'a@b.c', loading: false, failed: true, profile: NAMED }, false],
    ['signed in, failed while loading', { email: 'a@b.c', loading: true, failed: true, profile: null }, false],
    ['signed in, failed while loading with a profile', { email: 'a@b.c', loading: true, failed: true, profile: NAMED }, false],
  ]

  for (const [label, input, expected] of cases) {
    it(`${expected ? 'gates' : 'does not gate'}: ${label}`, () => {
      expect(shouldClaimUsername(input)).toBe(expected)
    })
  }

  it('never gates on a load failure, however it fails', () => {
    // The regression this pins: fetchProfile once collapsed an offline auth
    // call into null, so a signed-in user who already had a name looked exactly
    // like one who had never claimed, and was trapped in the gate with Sign out
    // as the only way out. `failed` must beat an absent profile, always.
    for (const profile of [null, NAMED]) {
      expect(shouldClaimUsername({ email: 'a@b.c', loading: false, failed: true, profile })).toBe(
        false,
      )
    }
  })
})
