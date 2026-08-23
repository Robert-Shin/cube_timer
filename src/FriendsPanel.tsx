import { useCallback, useEffect, useState } from 'react'
import { listFriends, respond, sendRequest, unfriend, type Partitioned } from './friends'

const MESSAGES: Record<string, string> = {
  'no-such-user': 'No user with that name.',
  already: 'You have already sent a request, or you are already friends.',
  retry: 'Could not send that request. Try again.',
}

export function FriendsPanel({
  onOpen,
}: {
  onOpen: (userId: string, username: string) => void
}) {
  const [data, setData] = useState<{ partitioned: Partitioned; names: Map<string, string> } | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const next = await listFriends()
    setData(next)
  }, [])

  useEffect(() => {
    let live = true
    listFriends().then((d) => live && setData(d))
    return () => {
      live = false
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const outcome = await sendRequest(name)
    setBusy(false)
    if (outcome === 'sent') {
      setName('')
      setNote(null)
      await refresh()
    } else {
      setNote(MESSAGES[outcome])
    }
  }

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
                <button onClick={async () => { await respond(id, true); await refresh() }}>
                  Accept
                </button>
                <button onClick={async () => { await respond(id, false); await refresh() }}>
                  Decline
                </button>
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
              <button onClick={async () => { await unfriend(id); await refresh() }}>
                Remove
              </button>
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
