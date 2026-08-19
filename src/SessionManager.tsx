import { useState } from 'react'
import { EVENTS, MAX_SESSIONS, type EventId, type Session } from './types'
import type { Store } from './storage'
import { parseTime } from './parseTime'
import { formatMs } from './format'

/**
 * csTimer-style session management: any number of named sessions up to the
 * cap, each bound to a WCA event, so two 3x3 sessions can coexist.
 */
export function SessionManager({
  store,
  counts,
  onChange,
  onClose,
}: {
  store: Store
  counts: Record<string, number>
  onChange: (next: Store) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [event, setEvent] = useState<EventId>('333')
  const [confirming, setConfirming] = useState<string | null>(null)

  const full = store.sessions.length >= MAX_SESSIONS

  const patch = (id: string, fields: Partial<Session>) =>
    onChange({
      ...store,
      sessions: store.sessions.map((s) => (s.id === id ? { ...s, ...fields } : s)),
    })

  const add = () => {
    if (full) return
    const session: Session = {
      id: crypto.randomUUID(),
      name: name.trim() || EVENTS.find((e) => e.id === event)!.name,
      event,
      createdAt: Date.now(),
    }
    onChange({ ...store, sessions: [...store.sessions, session], activeId: session.id })
    setName('')
  }

  const remove = (id: string) => {
    const sessions = store.sessions.filter((s) => s.id !== id)
    onChange({
      sessions,
      solves: store.solves.filter((s) => s.sessionId !== id),
      activeId: store.activeId === id ? sessions[0].id : store.activeId,
    })
    setConfirming(null)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>sessions</h2>
          <button className="ghost small" onClick={onClose}>
            close
          </button>
        </div>

        <div className="session-list">
          {store.sessions.map((s) => (
            <div key={s.id} className="session-row">
              <input
                className="name-input"
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
                aria-label="Session name"
              />
              <select
                value={s.event}
                onChange={(e) => patch(s.id, { event: e.target.value as EventId })}
                aria-label="Event"
              >
                {EVENTS.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
              <input
                className="goal-input"
                defaultValue={s.goalMs ? formatMs(s.goalMs) : ''}
                placeholder="goal"
                aria-label="Sub-X goal"
                title="Target time for the sub-X rate, e.g. 12 or 1:00"
                onBlur={(e) => {
                  const text = e.target.value.trim()
                  const ms = text === '' ? undefined : (parseTime(text) ?? undefined)
                  patch(s.id, { goalMs: ms })
                  e.target.value = ms ? formatMs(ms) : ''
                }}
              />
              <span className="count">{counts[s.id] ?? 0}</span>
              {confirming === s.id ? (
                <button className="danger small" onClick={() => remove(s.id)}>
                  delete {counts[s.id] ?? 0} solves?
                </button>
              ) : (
                <button
                  className="ghost small"
                  disabled={store.sessions.length <= 1}
                  title={store.sessions.length <= 1 ? 'the last session cannot be deleted' : ''}
                  onClick={() => setConfirming(s.id)}
                >
                  delete
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="session-add">
          <input
            placeholder="new session name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            aria-label="New session name"
          />
          <select value={event} onChange={(e) => setEvent(e.target.value as EventId)}>
            {EVENTS.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={add} disabled={full}>
            add
          </button>
        </div>
        <p className="note">
          {store.sessions.length} of {MAX_SESSIONS} sessions
          {full ? ' — delete one to add another' : ''}
        </p>
      </div>
    </div>
  )
}
