import type { EventId, Penalty } from './types'

/**
 * A challenge result recorded locally but not yet accepted by the server.
 *
 * The attempt row already exists server-side by the time anything is queued,
 * so a retry can always complete. An "already submitted" rejection is a
 * success from the queue's point of view: the first write won.
 */
export interface PendingSubmission {
  event: EventId
  day: string
  timeMs: number
  penalty: Penalty
}

const KEY = 'cube-timer.daily-queue.v1'

/** One attempt means one result, so an existing entry is never replaced. */
export function enqueue(
  queue: PendingSubmission[],
  item: PendingSubmission,
): PendingSubmission[] {
  const exists = queue.some((q) => q.event === item.event && q.day === item.day)
  return exists ? queue : [...queue, item]
}

export function dropSettled(
  queue: PendingSubmission[],
  event: EventId,
  day: string,
): PendingSubmission[] {
  return queue.filter((q) => !(q.event === event && q.day === day))
}

export function loadQueue(): PendingSubmission[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as PendingSubmission[]) : []
  } catch {
    return []
  }
}

export function saveQueue(queue: PendingSubmission[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue))
  } catch {
    // A lost queue costs one unsubmitted result, never a lost solve: the
    // solve itself is already in the store.
  }
}
