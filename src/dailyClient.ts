import { supabase } from './supabase'
import { utcDay, bestOfDay } from './daily'
import { dropSettled, enqueue, loadQueue, saveQueue } from './dailyQueue'
import type { EventId, Penalty, Solve } from './types'

export interface BoardRow {
  /** Stable React key: usernames are not unique (everyone is 'anonymous'). */
  userId: string
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
 * 'rejected' — the server refused it permanently; retrying can never help.
 * 'retry'    — transport failure; the caller queues it.
 *
 * The mapping is a whitelist for 'retry', not a catch-all. `submit_daily`
 * raises several permanent conditions with no custom SQLSTATE ('not signed
 * in', 'unknown penalty', 'time_ms must be positive', 'no attempt: reveal the
 * scramble first', 'submitted time exceeds elapsed time since reveal') which
 * all surface as PostgREST P0001. Treating those as retryable put a doomed
 * item in the queue forever, firing one hopeless RPC per sync tick: a server
 * that answered is a server that decided, so only a failure to *reach* it can
 * be retried.
 */
export async function submitDaily(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<'accepted' | 'settled' | 'rejected' | 'retry'> {
  if (!supabase) return 'retry'
  let error
  try {
    ;({ error } = await supabase.rpc('submit_daily', {
      p_event: event,
      p_time_ms: Math.round(timeMs),
      p_penalty: penalty,
    }))
  } catch {
    // A thrown rejection is the fetch layer failing outright — never a
    // decision by the server.
    return 'retry'
  }
  if (!error) return 'accepted'
  // 'settled' means the first write won, so the queue must stop retrying.
  // Matched on a stable SQLSTATE rather than the message text: error wording
  // changes silently, and a missed 'settled' retries forever.
  if (error.code === 'CS001' || /already submitted/i.test(error.message)) return 'settled'
  // supabase-js reports a transport failure as an error with no SQLSTATE;
  // anything carrying a code came from Postgres and is a real decision.
  if (!error.code) return 'retry'
  return 'rejected'
}

/** Retries every queued submission. Safe to call on any sync tick. */
export async function flushQueue(): Promise<void> {
  let queue = loadQueue()
  if (queue.length === 0) return
  const today = utcDay(Date.now())
  for (const item of [...queue]) {
    // A queued item from an earlier UTC day is unsubmittable by construction:
    // submit_daily resolves the attempt against *today's* date, so it finds no
    // attempt and rejects permanently. Reveal at 23:58 and reconnect at 00:05
    // is enough to produce one. Drop it instead of hammering the server.
    if (item.day !== today) {
      queue = dropSettled(queue, item.event, item.day)
      continue
    }
    const outcome = await submitDaily(item.event, item.timeMs, item.penalty)
    if (outcome !== 'retry') {
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
  const best = bestOfDay(solves, day)
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
    // Never a real scramble. daily_bests is world-readable to any anon-key
    // holder (`bests_select_board` is `using (published)`), and a challenge
    // result is stored locally as an ordinary solve carrying the day's SHARED
    // scramble -- so for anyone who only does the daily, their best of the day
    // *is* the challenge solve. Publishing it would let anyone read the
    // scramble before committing, practise it, and post a cold time, which
    // voids the whole reveal-is-the-commitment design. The column is never
    // read back (fetchBoard selects user_id and time_ms only).
    scramble: '',
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
      userId: r.user_id,
      username: nameByUser.get(r.user_id) ?? 'anonymous',
      challengeMs: r.penalty === 'dnf' ? null : r.time_ms,
      challengePenalty: r.penalty as Penalty,
      bestMs: bestByUser.get(r.user_id) ?? null,
      isSelf: r.user_id === self,
    }))
    .sort((a, b) => (a.challengeMs ?? Infinity) - (b.challengeMs ?? Infinity))
}
