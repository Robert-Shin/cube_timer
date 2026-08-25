import { useCallback, useEffect, useRef, useState } from 'react'

export type TimerState = 'idle' | 'holding' | 'ready' | 'running'

/** How long space must be held before the timer arms, as on a StackMat. */
const HOLD_MS = 300

/**
 * Space-bar timer. The displayed time is driven by requestAnimationFrame, but
 * the recorded result is a single subtraction of two performance.now() reads,
 * so a dropped frame can never corrupt a solve.
 *
 * `boundaries` is how many leg boundaries to collect before the final stop --
 * N-1 for an N-leg relay, and 0 (the default) for an ordinary solve, which
 * keeps the "any key stops" behaviour untouched.
 */
export function useTimer(
  onStop: (elapsedMs: number, splits: number[]) => void,
  enabled = true,
  boundaries = 0,
) {
  const [state, setState] = useState<TimerState>('idle')
  const [display, setDisplay] = useState(0)
  // Which leg is being solved, 0-based. Surfaced so the timer can show
  // "leg 2 of 4"; meaningless and ignored when boundaries is 0.
  const [leg, setLeg] = useState(0)

  const startRef = useRef(0)
  const splitsRef = useRef<number[]>([])
  const holdTimer = useRef<number | undefined>(undefined)
  const rafRef = useRef<number | undefined>(undefined)
  // Kept in a ref so the key handlers, bound once, always see current state.
  const stateRef = useRef<TimerState>('idle')
  const legRef = useRef(0)
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop
  // Always the newest `boundaries`, updated every render -- mirrors
  // onStopRef above. Only start() may read this; nothing else should, or it
  // reintroduces the mid-solve-retarget bug that boundariesRef exists to
  // prevent (see below).
  const latestBoundaries = useRef(boundaries)
  latestBoundaries.current = boundaries
  // Snapshotted from latestBoundaries.current inside start(), NOT assigned
  // here on every render: this must stay fixed for the length of a solve, or
  // a discipline change mid-solve (the <select> is clickable while running)
  // would retarget an in-flight solve's leg count out from under it. A
  // change to `boundaries` only takes effect on the next call to start(),
  // i.e. the next solve. Collapsing this back into one ref reintroduces that
  // bug; keeping `boundaries` itself out of start()'s deps (see below) is
  // what keeps start() referentially stable so the key-binding effect never
  // re-runs mid-solve.
  const boundariesRef = useRef(boundaries)

  const set = useCallback((s: TimerState) => {
    stateRef.current = s
    setState(s)
  }, [])

  const tick = useCallback(() => {
    setDisplay(performance.now() - startRef.current)
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const start = useCallback(() => {
    startRef.current = performance.now()
    splitsRef.current = []
    legRef.current = 0
    setLeg(0)
    setDisplay(0)
    // Fixed for the life of this solve -- see the comment on the ref.
    // Sourced from latestBoundaries, not the `boundaries` parameter, so that
    // `boundaries` never enters start()'s deps: pulling it in would change
    // start()'s identity on every discipline change, tearing down and
    // rebuilding the key-binding effect below (which lists `start` as a
    // dep) mid-solve -- cancelling the running rAF chain with nothing to
    // restart it, freezing the on-screen clock until the next start().
    boundariesRef.current = latestBoundaries.current
    set('running')
    rafRef.current = requestAnimationFrame(tick)
  }, [set, tick])

  /**
   * Records a leg boundary without stopping the clock. Always builds a new
   * array rather than pushing in place: stop() hands splitsRef.current
   * straight to onStop, so mutating it after that call would keep growing
   * the array the caller already has.
   */
  const split = useCallback(() => {
    splitsRef.current = [...splitsRef.current, performance.now() - startRef.current]
    legRef.current += 1
    setLeg(legRef.current)
  }, [])

  const stop = useCallback(() => {
    const elapsed = performance.now() - startRef.current
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    setDisplay(elapsed)
    set('idle')
    onStopRef.current(elapsed, splitsRef.current)
  }, [set])

  useEffect(() => {
    if (!enabled) return
    const down = (e: KeyboardEvent) => {
      // Don't hijack typing in inputs.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return

      // Held space auto-repeats, and every repeat scrolls the page unless it
      // is cancelled too -- so preventDefault comes before the repeat guard.
      if (e.code === 'Space') e.preventDefault()
      if (e.repeat) return

      if (stateRef.current === 'running') {
        e.preventDefault()
        // Every press before the last one closes a leg; the final press
        // stops. With boundaries = 0 the first press stops, exactly as
        // before relays existed.
        if (legRef.current < boundariesRef.current) split()
        else stop()
        return
      }
      if (e.code !== 'Space' || stateRef.current !== 'idle') return
      set('holding')
      // The previous solve's time stays on screen through the hold and the
      // ready state; start() is what clears it. Zeroing here instead would
      // wipe the result you just posted the moment you begin the next hold,
      // which is exactly when you are still reading it.
      holdTimer.current = window.setTimeout(() => set('ready'), HOLD_MS)
    }

    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      e.preventDefault()
      window.clearTimeout(holdTimer.current)
      if (stateRef.current === 'ready') start()
      else if (stateRef.current === 'holding') set('idle') // released too early
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.clearTimeout(holdTimer.current)
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    }
  }, [enabled, set, start, stop, split])

  useEffect(() => {
    if (!enabled) {
      // Only an in-flight solve is thrown away. A finished time stays on
      // screen, because the usual reason the timer is disabled right after a
      // stop is a modal about the solve that just ended -- clearing here
      // would blank the result before it could be read.
      if (stateRef.current !== 'idle') setDisplay(0)
      set('idle')
    }
  }, [enabled, set])

  return { state, display, leg }
}
