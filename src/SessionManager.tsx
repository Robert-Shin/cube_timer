import { useState } from 'react'
import { EVENTS, MAX_SESSIONS, SESSION_COLORS, type EventId, type Session } from './types'
import type { Store } from './storage'
import { parseTime } from './parseTime'
import { touch, tombstone } from './sync/stamp'
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

  // Tombstoned sessions still sit in the store; they are not shown and do
  // not consume a slot.
  const live = store.sessions.filter((s) => !s.deleted)
  const full = live.length >= MAX_SESSIONS

  // Every edit bumps updatedAt, or the change would lose the next
  // reconciliation and silently revert.
  const patch = (id: string, fields: Partial<Session>) =>
    onChange({
      ...store,
      sessions: store.sessions.map((s) => (s.id === id ? touch(s, fields) : s)),
    })

  const add = () => {
    if (full) return
    const session: Session = {
      id: crypto.randomUUID(),
      name: name.trim() || EVENTS.find((e) => e.id === event)!.name,
      event,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    onChange({ ...store, sessions: [...store.sessions, session], activeId: session.id })
    setName('')
  }

  const remove = (id: string) => {
    if (live.length <= 1) return
    // Tombstones, not removal: a row deleted outright is invisible to another
    // device, which would resurrect it on the next pull.
    const sessions = store.sessions.map((s) => (s.id === id ? tombstone(s) : s))
    const remaining = sessions.filter((s) => !s.deleted)
    onChange({
      sessions,
      solves: store.solves.map((s) => (s.sessionId === id ? tombstone(s) : s)),
      activeId: store.activeId === id ? remaining[0].id : store.activeId,
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
          {live.map((s) => (
            <div key={s.id} className="session-row">
              <input
                className="name-input"
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
                aria-label="Session name"
              />
              <span className="swatch-picker">
                {SESSION_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch-dot ${(s.color ?? 1) === c ? 'on' : ''}`}
                    style={{ background: `var(--s${c})` }}
                    aria-label={`Accent ${c}`}
                    onClick={() => patch(s.id, { color: c })}
                  />
                ))}
              </span>
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
                  disabled={live.length <= 1}
                  title={live.length <= 1 ? 'the last session cannot be deleted' : ''}
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
          {live.length} of {MAX_SESSIONS} sessions
          {full ? ' — delete one to add another' : ''}
        </p>
      </div>
    </div>
  )
}
