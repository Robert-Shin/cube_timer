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
