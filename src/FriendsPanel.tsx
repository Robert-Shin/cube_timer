import { useCallback, useEffect, useRef, useState } from 'react'
import { listFriends, respond, sendRequest, unfriend, type Partitioned } from './friends'

const MESSAGES: Record<string, string> = {
  'no-such-user': 'No user with that name.',
  already: 'You have already sent a request, or you are already friends.',
  retry: 'Could not send that request. Try again.',
}

const ACCEPT_FAILED = 'Could not accept that request. Try again.'
const DECLINE_FAILED = 'Could not decline that request. Try again.'
const REMOVE_FAILED = 'Could not remove that friend. Try again.'

export function FriendsPanel({
  onOpen,
}: {
  onOpen: (userId: string, username: string) => void
}) {
  const [data, setData] = useState<{ partitioned: Partitioned; names: Map<string, string> } | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Keyed by the other user's id -- a request row and a friend row for the
  // same person never coexist, so one id is enough to guard both "in
  // flight" and "last action failed" per row.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map())

  // Consulted by every await-then-setState path below, not just the initial
  // load: this panel lives inside a closeable modal, so a close mid-request
  // is a real path, not a hypothetical one.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const next = await listFriends()
    if (mounted.current) setData(next)
  }, [])

  useEffect(() => {
    listFriends().then((d) => {
      if (mounted.current) setData(d)
    })
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const outcome = await sendRequest(name)
    if (!mounted.current) return
    setBusy(false)
    if (outcome === 'sent') {
      setName('')
      setNote(null)
      await refresh()
    } else {
      setNote(MESSAGES[outcome])
    }
  }

  const clearRowError = (id: string) => {
    setRowErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  const setRowError = (id: string, msg: string) => {
    setRowErrors((prev) => new Map(prev).set(id, msg))
  }

  const withRowBusy = async (id: string, action: () => Promise<boolean>, failMsg: string) => {
    if (busyIds.has(id)) return
    setBusyIds((prev) => new Set(prev).add(id))
    const ok = await action()
    if (!mounted.current) return
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (ok) {
      clearRowError(id)
      await refresh()
    } else {
      setRowError(id, failMsg)
    }
  }

  const handleRespond = (id: string, accept: boolean) =>
    withRowBusy(id, () => respond(id, accept), accept ? ACCEPT_FAILED : DECLINE_FAILED)

  const handleUnfriend = (id: string) => withRowBusy(id, () => unfriend(id), REMOVE_FAILED)

  if (data === null) return <p className="note">Loading friends…</p>

  const { partitioned: p, names } = data
  const label = (id: string) => names.get(id) ?? 'unknown'

  return (
    <section className="friends">
      <form onSubmit={submit}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="username"
          aria-label="Friend's username"
        />
        <button type="submit" disabled={busy || !name.trim()}>
          Send request
        </button>
      </form>
      {note && <p className="error">{note}</p>}

      {p.incoming.length > 0 && (
        <>
          <h3>Requests</h3>
          <ul>
            {p.incoming.map((id) => (
              <li key={id}>
                {label(id)}
                <button disabled={busyIds.has(id)} onClick={() => handleRespond(id, true)}>
                  Accept
                </button>
                <button disabled={busyIds.has(id)} onClick={() => handleRespond(id, false)}>
                  Decline
                </button>
                {rowErrors.get(id) && <p className="error">{rowErrors.get(id)}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Friends</h3>
      {p.accepted.length === 0 ? (
        <p className="empty">No friends yet. Add someone by their username.</p>
      ) : (
        <ul>
          {p.accepted.map((id) => (
            <li key={id}>
              <button className="link" onClick={() => onOpen(id, label(id))}>
                {label(id)}
              </button>
              <button disabled={busyIds.has(id)} onClick={() => handleUnfriend(id)}>
                Remove
              </button>
              {rowErrors.get(id) && <p className="error">{rowErrors.get(id)}</p>}
            </li>
          ))}
        </ul>
      )}

      {p.outgoing.length > 0 && (
        <p className="note">Waiting on: {p.outgoing.map(label).join(', ')}</p>
      )}
    </section>
  )
}
