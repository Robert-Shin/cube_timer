import { useState } from 'react'
import { EVENTS, MAX_SESSIONS, type EventId, type Session } from './types'
import { disciplineKey, disciplineLabel, eventDiscipline, parseDiscipline } from './discipline'
import { defaultSessionName, deleteSession, sessionsOf, type Store } from './storage'
import { parseTime } from './parseTime'
import { touch } from './sync/stamp'
import { formatMs } from './format'

/**
 * Manages the logs of ONE discipline, not every session in the app.
 *
 * The event dropdown that used to sit on every row is gone. It was the whole
 * reason "is a session a log or a puzzle?" had no answer -- and it let a
 * session full of 3x3 solves be re-pointed at 4x4 by a stray scroll. Which
 * discipline a session belongs to is now set when it is created, and changed
 * only by the deliberate Move control below.
 */
export function SessionManager({
  store,
  discipline,
  counts,
  onChange,
  onClose,
}: {
  store: Store
  discipline: string
  counts: Record<string, number>
  onChange: (next: Store) => void
  onClose: () => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)

  const parsed = parseDiscipline(discipline)
  const label = parsed ? disciplineLabel(parsed) : discipline
  const mine = sessionsOf(store, discipline)
  const liveTotal = store.sessions.filter((s) => !s.deleted).length
  const full = liveTotal >= MAX_SESSIONS

  // Every edit bumps updatedAt, or the change would lose the next
  // reconciliation and silently revert.
  const patch = (id: string, fields: Partial<Session>) =>
    onChange({
      ...store,
      sessions: store.sessions.map((s) => (s.id === id ? touch(s, fields) : s)),
    })

  // No name is asked for: one is generated and can be edited in place. Having
  // to invent a name before timing was the other half of what made creating a
  // session a chore.
  const add = () => {
    if (full) return
    const at = Date.now()
    const session: Session = {
      id: crypto.randomUUID(),
      name: defaultSessionName(discipline, at),
      discipline,
      createdAt: at,
      updatedAt: at,
    }
    onChange({
      ...store,
      sessions: [...store.sessions, session],
      activeByDiscipline: { ...store.activeByDiscipline, [discipline]: session.id },
    })
  }

  const remove = (id: string) => {
    onChange(deleteSession(store, id))
    setConfirming(null)
  }

  const move = (id: string, key: string) => {
    patch(id, { discipline: key })
    setMoving(null)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{label} sessions</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="session-list">
          {mine.map((s) => (
            <div key={s.id} className="session-row">
              <input
                className="name-input"
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
                aria-label="Session name"
              />
              <input
                className="goal-input"
                defaultValue={s.goalMs ? formatMs(s.goalMs) : ''}
                placeholder="Goal"
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

              {moving === s.id ? (
                <select
                  autoFocus
                  defaultValue=""
                  aria-label="Move to"
                  onChange={(e) => e.target.value && move(s.id, e.target.value)}
                  onBlur={() => setMoving(null)}
                >
                  <option value="" disabled>
                    Move to…
                  </option>
                  {EVENTS.filter((ev) => ev.id !== discipline).map((ev) => (
                    <option key={ev.id} value={disciplineKey(eventDiscipline(ev.id as EventId))}>
                      {ev.name}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="ghost small" onClick={() => setMoving(s.id)}>
                  Move
                </button>
              )}

              {confirming === s.id ? (
                <button className="danger small" onClick={() => remove(s.id)}>
                  Delete {counts[s.id] ?? 0} solves?
                </button>
              ) : (
                <button className="ghost small" onClick={() => setConfirming(s.id)}>
                  Delete
                </button>
              )}
            </div>
          ))}
          {mine.length === 0 && (
            <p className="note">
              No {label} sessions yet — your first solve starts one.
            </p>
          )}
        </div>

        <div className="session-add">
          <button className="primary" onClick={add} disabled={full}>
            New {label} session
          </button>
        </div>
        <p className="note">
          {liveTotal} of {MAX_SESSIONS} sessions across all disciplines
          {full ? ' — delete one to add another' : ''}
        </p>
      </div>
    </div>
  )
}
