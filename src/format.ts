import type { Solve } from './types'
import { effectiveMs } from './types'

/** 12345 -> "12.34", 65432 -> "1:05.43" */
export function formatMs(ms: number | null): string {
  if (ms === null) return 'DNF'
  const totalCs = Math.floor(ms / 10)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const sec = totalSec % 60
  const min = Math.floor(totalSec / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return min > 0 ? `${min}:${pad(sec)}.${pad(cs)}` : `${sec}.${pad(cs)}`
}

/** Adds the trailing "+" that convention uses to mark a +2 solve. */
export function formatSolve(s: Solve): string {
  const t = formatMs(effectiveMs(s))
  return s.penalty === 'plus2' ? `${t}+` : t
}
