import { useCallback, useEffect, useRef, useState } from 'react'

export type TimerState = 'idle' | 'holding' | 'ready' | 'running'

/** How long space must be held before the timer arms, as on a StackMat. */
const HOLD_MS = 300

/**
 * Space-bar timer. The displayed time is driven by requestAnimationFrame, but
 * the recorded result is a single subtraction of two performance.now() reads,
 * so a dropped frame can never corrupt a solve.
 */
export function useTimer(onStop: (elapsedMs: number) => void, enabled = true) {
  const [state, setState] = useState<TimerState>('idle')
  const [display, setDisplay] = useState(0)

  const startRef = useRef(0)
  const holdTimer = useRef<number | undefined>(undefined)
  const rafRef = useRef<number | undefined>(undefined)
  // Kept in a ref so the key handlers, bound once, always see current state.
  const stateRef = useRef<TimerState>('idle')
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop

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
    setDisplay(0)
    set('running')
    rafRef.current = requestAnimationFrame(tick)
  }, [set, tick])

  const stop = useCallback(() => {
    const elapsed = performance.now() - startRef.current
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    setDisplay(elapsed)
    set('idle')
    onStopRef.current(elapsed)
  }, [set])

  useEffect(() => {
    if (!enabled) return
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return
      // Don't hijack typing in inputs.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return

      if (stateRef.current === 'running') {
        e.preventDefault()
        stop()
        return
      }
      if (e.code !== 'Space' || stateRef.current !== 'idle') return
      e.preventDefault()
      set('holding')
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
  }, [enabled, set, start, stop])

  useEffect(() => {
    if (!enabled) {
      set('idle')
      setDisplay(0)
    }
  }, [enabled, set])

  return { state, display }
}
