import { supabase } from './supabase'
import type { EventId } from './types'

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

/** Resolves a username to a user id, then inserts a pending request. */
export async function sendRequest(username: string) {
  if (!supabase) return 'retry' as const
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
}

/** Accept or decline. Declining deletes the row -- there is no rejected state. */
export async function respond(requesterId: string, accept: boolean): Promise<boolean> {
  if (!supabase) return false
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
}

/** Removes the friendship from either side, in whichever direction it was sent. */
export async function unfriend(otherUserId: string): Promise<boolean> {
  if (!supabase) return false
  const { data: auth } = await supabase.auth.getUser()
  const me = auth.user?.id
  if (!me) return false
  const { error } = await supabase
    .from('friendships').delete()
    .or(`and(requester.eq.${me},addressee.eq.${otherUserId}),` +
        `and(requester.eq.${otherUserId},addressee.eq.${me})`)
  return !error
}

/** Every friendship I am part of, plus the usernames to render them with. */
export async function listFriends() {
  if (!supabase) return null
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
  event: EventId,
  sinceDays: number,
): Promise<FriendProfileView | null> {
  if (!supabase) return null
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)

  const [cal, stats] = await Promise.all([
    supabase.rpc('friend_calendar', { p_user: userId, p_event: event, p_since: since }),
    supabase.rpc('friend_stats', { p_user: userId, p_event: event }),
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
}
