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
 * Terminal SQLSTATEs: the server has definitively refused this submission and
 * will refuse it forever.
 *
 * - CS001: already submitted. The first write won.
 * - P0001: every business-logic rejection `submit_daily` raises ('not signed
 *   in', 'unknown penalty', 'time_ms must be positive', 'no attempt: reveal
 *   the scramble first', 'submitted time exceeds elapsed time since reveal').
 *   They carry no distinguishing code, but P0001 here can only come from our
 *   own function, and every condition it raises is permanent.
 *
 * Deliberately NOT a "has a code, so the server decided" rule. Plenty of codes
 * are transient -- PGRST301 (expired JWT, which happens on an ordinary timer),
 * 40001 (serialization failure), 40P01 (deadlock) -- and discarding one of
 * those destroys the user's single result for the day with no way to resubmit,
 * because the attempt row is already revealed. Retrying something doomed is
 * merely wasteful; discarding something recoverable is not recoverable. So an
 * unfamiliar error must default to retry.
 */
const TERMINAL_CODES = new Set(['CS001', 'P0001'])

/**
 * 'accepted' — the server took it.
 * 'settled'  — it was already submitted; the first write won, stop retrying.
 * 'rejected' — the server refused it permanently; retrying can never help.
 * 'retry'    — could not be delivered, or an unrecognised failure; requeue it.
 */
export function classifySubmitError(
  error: { code?: string | null; message?: string } | null,
): 'accepted' | 'settled' | 'rejected' | 'retry' {
  if (!error) return 'accepted'
  // Matched on a stable SQLSTATE rather than the message text: error wording
  // changes silently, and a missed 'settled' retries forever. The message
  // fallback stays for a server predating the custom code.
  if (error.code === 'CS001' || /already submitted/i.test(error.message ?? '')) return 'settled'
  return TERMINAL_CODES.has(error.code ?? '') ? 'rejected' : 'retry'
}

export async function submitDaily(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<'accepted' | 'settled' | 'rejected' | 'retry'> {
  if (!supabase) return 'retry'
  try {
    const { error } = await supabase.rpc('submit_daily', {
      p_event: event,
      p_time_ms: Math.round(timeMs),
      p_penalty: penalty,
    })
    return classifySubmitError(error)
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return 'retry'
  }
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
 * 'publish' — there is a best today; write it.
 * 'retract' — there is genuinely no best today; take the row off the board.
 * 'none'    — we cannot tell, so touch nothing.
 */
export type BestPlan =
  | { action: 'publish'; timeMs: number }
  | { action: 'retract' }
  | { action: 'none' }

/**
 * Decides what today's `daily_bests` row should become.
 *
 * `canRetract` is the caller asserting that `solves` is the device's COMPLETE
 * picture of today. Without it, "no best" is ambiguous: a store that has not
 * been populated from the server yet looks exactly like a day with no solves,
 * and acting on that guess is what wiped a published row off the board when
 * you signed in on a new device. Publishing is safe from a partial store --
 * a best that exists is a fact -- so only retraction is gated.
 */
export function planBestOfDay(
  solves: Solve[],
  day: string,
  { canRetract }: { canRetract: boolean },
): BestPlan {
  const best = bestOfDay(solves, day)
  if (best) return { action: 'publish', timeMs: Math.round(best.ms) }
  return canRetract ? { action: 'retract' } : { action: 'none' }
}

/**
 * Publishes the best ordinary solve of today. Derived from local state every
 * time, so deleting or DNF-ing the underlying solve corrects the row on the
 * next call with no separate retraction path.
 *
 * `canRetract` must only be true when `solves` is known to be complete for
 * today -- see planBestOfDay. It defaults to false so that a new call site
 * cannot silently acquire the destructive behaviour.
 */
export async function publishBestOfDay(
  solves: Solve[],
  event: EventId,
  { canRetract = false }: { canRetract?: boolean } = {},
): Promise<void> {
  if (!supabase) return
  const day = utcDay(Date.now())
  const plan = planBestOfDay(solves, day, { canRetract })
  if (plan.action === 'none') return

  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return

  if (plan.action === 'retract') {
    // Unpublished rather than deleted. The board selects on `published`, so
    // this takes the row off it just as a delete did, but it is reversible,
    // it leaves the previous time in place for the owner to see, and it keeps
    // the hard delete out of a codebase whose stated rule is soft deletes.
    // An update matching no row is a harmless no-op.
    await supabase.from('daily_bests')
      .update({ published: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('event', event).eq('utc_day', day)
    return
  }

  const { data: profile } = await supabase
    .from('profiles').select('opted_in').eq('user_id', userId).maybeSingle()

  // daily_bests has no `scramble` column: it used to leak the day's shared
  // scramble to any anon-key holder (a challenge result is stored locally as
  // an ordinary solve carrying that scramble, and this was writing it into a
  // world-readable table), which would have let anyone read the scramble
  // before committing, practise it, and post a cold time -- voiding the
  // whole reveal-is-the-commitment design. The column is now dropped from
  // the schema, so there is nothing to write here.
  await supabase.from('daily_bests').upsert({
    user_id: userId,
    event,
    utc_day: day,
    time_ms: plan.timeMs,
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

/**
 * Whether today's opt-in setting is already spoken for. `submit_daily` freezes
 * `published` at submission time, so once any attempt is in, the setting can no
 * longer describe today's board and the UI stops offering to change it.
 *
 * No event filter: an attempt row can only exist for an event that had a
 * scramble to reveal, which is exactly the challenge events.
 *
 * Returns null when we could not tell (no session, or the query failed).
 * REVISION: this used to fail open (return false) on a query error, on the
 * theory that the worst case was a toggle whose effect was already moot for
 * today. That was wrong -- the real cost of guessing false is a user who
 * believes they have opted out when they have not, because the toggle stayed
 * enabled while we could not actually confirm today's state. Callers must
 * treat null as "not yet known", not as "not submitted", and if we cannot
 * even read this, a write would very likely fail too.
 */
export async function hasSubmittedToday(): Promise<boolean | null> {
  if (!supabase) return null
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return null

  const { data, error } = await supabase
    .from('daily_attempts')
    .select('user_id')
    .eq('user_id', userId)
    .eq('utc_day', utcDay(Date.now()))
    .not('submitted_at', 'is', null)
    .limit(1)

  if (error) return null

  return (data ?? []).length > 0
}
