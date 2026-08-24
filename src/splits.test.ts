import { describe, expect, it } from 'vitest'
import { legDurations } from './splits'

describe('legDurations', () => {
  it('turns cumulative boundaries into per-leg durations', () => {
    // Three boundaries + the final stop = a four-leg relay.
    expect(legDurations([5000, 12000, 30000], 55000)).toEqual([5000, 7000, 18000, 25000])
  })

  it('gives a single leg when there are no boundaries', () => {
    expect(legDurations([], 9000)).toEqual([9000])
  })

  it('is null when splits were never recorded', () => {
    // undefined is "not tracked", which is NOT the same as [] ("tracked, one
    // leg"). Collapsing the two would invent a leg that was never timed.
    expect(legDurations(undefined, 9000)).toBeNull()
  })

  it('does not mutate the array it is given', () => {
    const splits = [1000, 2000]
    legDurations(splits, 3000)
    expect(splits).toEqual([1000, 2000])
  })
})
