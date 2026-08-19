import type { Solve } from './types'

const KEY = 'cube-timer.solves.v1'

/**
 * localStorage is the source of truth for now. When Supabase sync lands this
 * becomes the offline cache and the server takes over as truth.
 */
export function loadSolves(): Solve[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Solve[]) : []
  } catch {
    return []
  }
}

/**
 * Returns false if the write failed -- almost always the ~5MB quota, which a
 * large csTimer import can reach. The caller must surface that: silently
 * dropping solves the user thinks are saved is the worst outcome here.
 */
export function saveSolves(solves: Solve[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(solves))
    return true
  } catch {
    return false
  }
}
