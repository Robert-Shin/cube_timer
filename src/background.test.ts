import { describe, expect, it } from 'vitest'
import { fitWithin } from './background'

describe('fitWithin', () => {
  it('scales a landscape photo down by its longest side', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 })
  })

  it('scales a portrait photo down by its longest side', () => {
    expect(fitWithin(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 })
  })

  it('never upscales: a small image is left exactly as it is', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(2000, 1000, 2000)).toEqual({ width: 2000, height: 1000 })
  })

  it('returns whole pixels, since canvas dimensions cannot be fractional', () => {
    const { width, height } = fitWithin(1999, 1101, 1000)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(height)).toBe(true)
    expect(width).toBe(1000)
  })

  it('keeps a degenerate image usable rather than collapsing it to zero', () => {
    expect(fitWithin(4000, 1, 2000).height).toBe(1)
  })
})
