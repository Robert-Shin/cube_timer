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

export function saveSolves(solves: Solve[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(solves))
  } catch {
    // Quota exceeded or storage disabled -- solves stay in memory this session.
  }
}
