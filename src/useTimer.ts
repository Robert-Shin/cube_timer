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
  // Snapshotted in start(), not assigned here on every render: this must
  // stay fixed for the length of a solve, or a discipline change mid-solve
  // (the <select> is clickable while running) would retarget an in-flight
  // solve's leg count out from under it. Assigning here would apply the
  // change immediately instead of from the next solve.
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
    boundariesRef.current = boundaries
    set('running')
    rafRef.current = requestAnimationFrame(tick)
  }, [set, tick, boundaries])

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
      // Clear the previous solve as soon as the hold begins, so the next
      // scramble is never read against a stale time.
      setDisplay(0)
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
      set('idle')
      setDisplay(0)
    }
  }, [enabled, set])

  return { state, display, leg }
}
