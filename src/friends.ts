import { supabase } from './supabase'
import type { EventId, Penalty, Solve } from './types'

export type FriendState = 'pending' | 'accepted'

export interface FriendshipRow {
  requester: string
  addressee: string
  state: FriendState
}

export interface Partitioned {
  /** user ids of accepted friends, whichever side sent the request */
  accepted: string[]
  /** user ids who have asked to befriend me and are waiting on me */
  incoming: string[]
  /** user ids I have asked, still waiting on them */
  outgoing: string[]
}

/**
 * One flat list of rows becomes the three lists the UI renders. Which bucket a
 * row lands in depends on which column holds `selfId`, which is exactly the
 * kind of off-by-one that is invisible in a UI and obvious in a test.
 */
export function partitionFriendships(rows: FriendshipRow[], selfId: string): Partitioned {
  const out: Partitioned = { accepted: [], incoming: [], outgoing: [] }
  for (const r of rows) {
    const iAmRequester = r.requester === selfId
    const other = iAmRequester ? r.addressee : r.requester
    if (r.state === 'accepted') out.accepted.push(other)
    else if (iAmRequester) out.outgoing.push(other)
    else out.incoming.push(other)
  }
  return out
}

/**
 * 'sent'          — the request is in.
 * 'no-such-user'  — the name resolved to nobody with a profile.
 * 'already'       — a row for this pair already exists, in either direction.
 * 'retry'         — anything else. Deliberately the default: reporting a
 *                   confident wrong reason ("no such user" for an expired
 *                   JWT) sends the user chasing a typo that isn't there.
 */
export function classifyRequestError(
  error: { code?: string | null; message?: string } | null,
): 'sent' | 'no-such-user' | 'already' | 'retry' {
  if (!error) return 'sent'
  if (error.code === '23503') return 'no-such-user'
  if (error.code === '23505') return 'already'
  return 'retry'
}

export interface FriendProfileView {
  days: { day: string; solves: number; bestMs: number | null }[]
  total: number
  bestMs: number | null
  /** Newest first, matching what stats.ts averageOf expects. */
  recentMs: (number | null)[]
}

/**
 * Consecutive days with at least one solve, counting back from `today`.
 *
 * `today` is not required to have a solve yet: the day is still in progress,
 * so an empty today does not zero the streak the moment the UTC date rolls
 * over. Instead, when today is empty the count starts from yesterday --
 * if yesterday was active, the streak is reported as still alive (pending
 * today's first solve); if yesterday was also empty, the streak is
 * genuinely 0. Once the walk starts, it stops at the first missing day,
 * counting only unbroken consecutive days from that point.
 *
 * Pure and given `today` explicitly (rather than reading Date.now() itself)
 * so it stays trivially testable -- same shape as bestOfDay/utcDay in
 * daily.ts, which take the day as data instead of a clock.
 */
export function currentStreak(
  days: { day: string; solves: number }[],
  today: string,
): number {
  const active = new Set(days.filter((d) => d.solves > 0).map((d) => d.day))

  let cursor = active.has(today) ? today : addUtcDays(today, -1)
  let count = 0
  while (active.has(cursor)) {
    count++
    cursor = addUtcDays(cursor, -1)
  }
  return count
}

/** Shifts a 'YYYY-MM-DD' string by `n` UTC days, wrapping months/years correctly. */
function addUtcDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Resolves a username to a user id, then inserts a pending request. */
export async function sendRequest(username: string) {
  if (!supabase) return 'retry' as const
  try {
    const { data: auth } = await supabase.auth.getUser()
    const me = auth.user?.id
    if (!me) return 'retry' as const

    // Case-insensitive, mirroring the profiles_username_lower unique index:
    // 'Glen' and 'glen' cannot both exist, so ilike matches at most one row.
    const { data: found, error: lookupError } = await supabase
      .from('profiles').select('user_id').ilike('username', username.trim()).maybeSingle()
    if (lookupError) return 'retry' as const
    if (!found) return 'no-such-user' as const

    const { error } = await supabase
      .from('friendships')
      .insert({ requester: me, addressee: found.user_id, state: 'pending' })
    return classifyRequestError(error)
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return 'retry' as const
  }
}

/** Accept or decline. Declining deletes the row -- there is no rejected state. */
export async function respond(requesterId: string, accept: boolean): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data: auth } = await supabase.auth.getUser()
    const me = auth.user?.id
    if (!me) return false

    const q = accept
      ? supabase.from('friendships').update({ state: 'accepted' })
          .eq('requester', requesterId).eq('addressee', me)
      : supabase.from('friendships').delete()
          .eq('requester', requesterId).eq('addressee', me)
    const { error } = await q
    return !error
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return false
  }
}

/** Removes the friendship from either side, in whichever direction it was sent. */
export async function unfriend(otherUserId: string): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data: auth } = await supabase.auth.getUser()
    const me = auth.user?.id
    if (!me) return false
    const { error } = await supabase
      .from('friendships').delete()
      .or(`and(requester.eq.${me},addressee.eq.${otherUserId}),` +
          `and(requester.eq.${otherUserId},addressee.eq.${me})`)
    return !error
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return false
  }
}

/** Every friendship I am part of, plus the usernames to render them with. */
export async function listFriends() {
  if (!supabase) return null
  try {
    const { data: auth } = await supabase.auth.getUser()
    const me = auth.user?.id
    if (!me) return null

    // No filter needed: the friend_select policy already restricts this to rows
    // I am part of. Filtering again client-side would only hide a policy bug.
    const { data, error } = await supabase.from('friendships').select('requester, addressee, state')
    if (error) return null

    const partitioned = partitionFriendships((data ?? []) as FriendshipRow[], me)
    const ids = [...partitioned.accepted, ...partitioned.incoming, ...partitioned.outgoing]
    const names = new Map<string, string>()
    if (ids.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles').select('user_id, username').in('user_id', ids)
      for (const p of profiles ?? []) names.set(p.user_id, p.username)
    }
    return { partitioned, names }
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return null
  }
}

/**
 * Both aggregate calls, assembled into one view model.
 *
 * Returning null means the calls failed. An EMPTY result is NOT null: it means
 * this friend has no solves for this event, which is a legitimate state. The
 * caller must distinguish those by the friendship it already listed rather
 * than by inferring from emptiness -- reading "no rows" as "no access" is the
 * same mistake class as reading an empty local store as "no best today".
 */
export async function friendProfile(
  userId: string,
  sessionId: string,
  sinceDays: number,
): Promise<FriendProfileView | null> {
  if (!supabase) return null
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)

  try {
    const [cal, stats] = await Promise.all([
      supabase.rpc('friend_calendar', { p_user: userId, p_session: sessionId, p_since: since }),
      supabase.rpc('friend_stats', { p_user: userId, p_session: sessionId }),
    ])
    if (cal.error || stats.error) return null

    const row = stats.data?.[0]
    return {
      days: (cal.data ?? []).map((d: { day: string; solves: number; day_best: number | null }) => ({
        day: d.day,
        solves: d.solves,
        bestMs: d.day_best,
      })),
      total: row?.total ?? 0,
      bestMs: row?.best_ms ?? null,
      // -1 is the DNF sentinel friend_stats encodes, because an int[] cannot
      // carry null through PostgREST reliably. averageOf expects null.
      recentMs: (row?.recent_ms ?? []).map((n: number) => (n === -1 ? null : n)),
    }
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server. Promise.all rejects as soon as either RPC's
    // fetch fails, e.g. offline/DNS/TLS -- distinct from `cal.error` /
    // `stats.error`, which is the server responding with a decision.
    return null
  }
}

export interface FriendSessionView {
  id: string
  name: string
  /** Discipline key -- see discipline.ts. */
  discipline: string
  solves: number
}

/**
 * The friend's sessions, busiest-first by recency, for the profile's picker.
 *
 * Null is reserved for a genuine failure; an empty array is the ordinary
 * "this friend has no solves" state. Conflating the two is the mistake this
 * codebase has made before -- see friendDaily's three-outcome comment below.
 */
export async function friendSessions(userId: string): Promise<FriendSessionView[] | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.rpc('friend_sessions', { p_user: userId })
    if (error) return null
    return (data ?? []).map(
      (r: { id: string; name: string; discipline: string; solves: number }) => ({
        id: r.id,
        name: r.name,
        discipline: r.discipline,
        solves: r.solves,
      }),
    )
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return null
  }
}

export interface FriendDailyView {
  /** null means a DNF, matching BoardRow.challengeMs in dailyClient.ts. */
  timeMs: number | null
}

/**
 * Today's SUBMITTED daily-challenge attempt for a friend, via friend_daily
 * (see the end of supabase/schema.sql). Deliberately ignores
 * `published`/`opted_in`: an accepted friend sees the result even when the
 * friend opted out of the public board -- that gate is `are_friends`, not
 * the board's opt-in.
 *
 * Three distinct outcomes, on purpose -- this codebase has already been bitten
 * once by conflating "no data" with "the call failed" (see
 * publishBestOfDay's canRetract comment in dailyClient.ts):
 * - null    -- the call itself failed (not configured, RPC error, or a
 *              thrown rejection). An error state, never rendered as empty.
 * - 'none'  -- the call succeeded and there is genuinely no result: not
 *              friends, no attempt today, or revealed-but-never-submitted.
 *              friend_daily conflates those on the server (all return zero
 *              rows), and none of them lets the client say anything more
 *              specific anyway, so 'none' covers all three truthfully.
 * - a view  -- the call succeeded with a submitted result.
 */
export async function friendDaily(
  userId: string,
  event: EventId,
): Promise<FriendDailyView | 'none' | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.rpc('friend_daily', { p_user: userId, p_event: event })
    if (error) return null
    const row = data?.[0]
    if (!row) return 'none'
    return { timeMs: row.penalty === 'dnf' ? null : row.time_ms }
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return null
  }
}

/** At most this many solves per session, matching friend_solves' server cap. */
export const FRIEND_SOLVE_CAP = 2000

export interface FriendSolveRow {
  /** UTC date, 'YYYY-MM-DD'. friend_solves returns a date, never a timestamp. */
  day: string
  time_ms: number
  penalty: string
}

const PENALTIES: Penalty[] = ['none', 'plus2', 'dnf']

/**
 * friend_solves rows as the `Solve` objects the charts and stats.ts already
 * consume, so a friend's ao12 is computed by the SAME function as yours and
 * the two can never disagree.
 *
 * Fields with no counterpart on the wire are filled honestly rather than
 * fabricated: there is no scramble (the server does not send one, by
 * design), and `parity` stays undefined -- "untracked", which is true, and
 * different from `[]`, which would claim it was measured as none.
 *
 * `createdAt` is midnight UTC of the solve's day, which is all the server
 * discloses. It is used only to print a date in the trend tooltip; ORDER is
 * carried by the array, not by this field, so a whole session sharing one
 * timestamp changes nothing.
 */
export function toSolves(rows: FriendSolveRow[], sessionId: string): Solve[] {
  return rows.map((r, i) => ({
    // Index-based, not crypto.randomUUID(): a stable id means React does not
    // remount every row when the list re-renders.
    id: `${sessionId}:${i}`,
    sessionId,
    scramble: '',
    timeMs: r.time_ms,
    // Never trust the string to be one of ours. An unexpected value falling
    // through as a penalty would be rendered, and 'dnf' in particular
    // changes what every average means.
    penalty: PENALTIES.includes(r.penalty as Penalty) ? (r.penalty as Penalty) : 'none',
    createdAt: Date.parse(`${r.day}T00:00:00.000Z`),
    updatedAt: 0,
  }))
}

/**
 * A friend's solves for one session, newest first.
 *
 * null is a genuine failure. An EMPTY array is not null: it means this
 * friend has no solves in this session, which is an ordinary state. Reading
 * "no rows" as "no access" is the same mistake class this file documents
 * twice already.
 */
export async function friendSolves(userId: string, sessionId: string): Promise<Solve[] | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.rpc('friend_solves', {
      p_user: userId,
      p_session: sessionId,
      p_limit: FRIEND_SOLVE_CAP,
    })
    if (error) return null
    return toSolves((data ?? []) as FriendSolveRow[], sessionId)
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return null
  }
}
