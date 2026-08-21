import { supabase } from './supabase'
import { utcDay, bestOfDay } from './daily'
import { dropSettled, enqueue, loadQueue, saveQueue } from './dailyQueue'
import type { EventId, Penalty, Solve } from './types'

export interface BoardRow {
  username: string
  challengeMs: number | null
  challengePenalty: Penalty
  bestMs: number | null
  isSelf: boolean
}

export interface Reveal {
  scramble: string
  revealedAt: string
  submitted: boolean
}

/**
 * Commits to today's attempt and returns the scramble. Reveal *is* the
 * commitment: there is no way to read the scramble without the attempt row
 * existing, which is what makes one-attempt enforceable.
 */
export async function revealDaily(event: EventId): Promise<Reveal> {
  if (!supabase) throw new Error('not configured')
  const { data, error } = await supabase.rpc('reveal_daily', { p_event: event })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('no scramble has been generated for today yet')
  return { scramble: row.scramble, revealedAt: row.revealed_at, submitted: row.submitted }
}

/**
 * 'accepted' — the server took it.
 * 'settled'  — it was already submitted; the first write won, stop retrying.
 * 'retry'    — transport failure; the caller queues it.
 */
export async function submitDaily(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<'accepted' | 'settled' | 'retry'> {
  if (!supabase) return 'retry'
  const { error } = await supabase.rpc('submit_daily', {
    p_event: event,
    p_time_ms: Math.round(timeMs),
    p_penalty: penalty,
  })
  if (!error) return 'accepted'
  // 'settled' means the first write won, so the queue must stop retrying.
  // Matched on a stable SQLSTATE rather than the message text: error wording
  // changes silently, and a missed 'settled' retries forever.
  if (error.code === 'CS001' || /already submitted/i.test(error.message)) return 'settled'
  return 'retry'
}

/** Retries every queued submission. Safe to call on any sync tick. */
export async function flushQueue(): Promise<void> {
  let queue = loadQueue()
  if (queue.length === 0) return
  for (const item of [...queue]) {
    const outcome = await submitDaily(item.event, item.timeMs, item.penalty)
    if (outcome === 'accepted' || outcome === 'settled') {
      queue = dropSettled(queue, item.event, item.day)
    }
  }
  saveQueue(queue)
}

/** Records a result locally-first, then tries the network. */
export async function recordChallengeResult(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<void> {
  const day = utcDay(Date.now())
  const outcome = await submitDaily(event, timeMs, penalty)
  if (outcome === 'retry') {
    saveQueue(enqueue(loadQueue(), { event, day, timeMs, penalty }))
  }
}

/**
 * Publishes the best ordinary solve of today. Derived from local state every
 * time, so deleting or DNF-ing the underlying solve corrects the row on the
 * next call with no separate retraction path.
 */
export async function publishBestOfDay(solves: Solve[], event: EventId): Promise<void> {
  if (!supabase) return
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return

  const day = utcDay(Date.now())
  const best = bestOfDay(solves, event, day)
  const { data: profile } = await supabase
    .from('profiles').select('opted_in').eq('user_id', userId).maybeSingle()

  if (!best) {
    await supabase.from('daily_bests')
      .delete().eq('user_id', userId).eq('event', event).eq('utc_day', day)
    return
  }

  await supabase.from('daily_bests').upsert({
    user_id: userId,
    event,
    utc_day: day,
    time_ms: Math.round(best.ms),
    scramble: best.solve.scramble,
    updated_at: new Date().toISOString(),
    published: profile?.opted_in ?? false,
  })
}

export async function fetchBoard(event: EventId, day: string): Promise<BoardRow[]> {
  if (!supabase) return []
  const { data: auth } = await supabase.auth.getUser()
  const self = auth.user?.id ?? null

  const [attempts, bests] = await Promise.all([
    supabase
      .from('daily_attempts')
      .select('user_id, time_ms, penalty')
      .eq('event', event)
      .eq('utc_day', day)
      .eq('published', true)
      .not('submitted_at', 'is', null),
    supabase
      .from('daily_bests')
      .select('user_id, time_ms')
      .eq('event', event)
      .eq('utc_day', day)
      .eq('published', true),
  ])

  const rows = attempts.data ?? []
  if (rows.length === 0) return []

  // Usernames come from a second query rather than an embedded select:
  // daily_attempts has no foreign key to profiles -- both reference
  // auth.users -- so PostgREST cannot embed one in the other. It also lets a
  // user who has never claimed a username still appear on the board.
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, username')
    .in(
      'user_id',
      rows.map((r) => r.user_id),
    )

  const nameByUser = new Map((profiles ?? []).map((p) => [p.user_id, p.username]))
  const bestByUser = new Map((bests.data ?? []).map((r) => [r.user_id, r.time_ms]))

  return rows
    .map((r) => ({
      username: nameByUser.get(r.user_id) ?? 'anonymous',
      challengeMs: r.penalty === 'dnf' ? null : r.time_ms,
      challengePenalty: r.penalty as Penalty,
      bestMs: bestByUser.get(r.user_id) ?? null,
      isSelf: r.user_id === self,
    }))
    .sort((a, b) => (a.challengeMs ?? Infinity) - (b.challengeMs ?? Infinity))
}
