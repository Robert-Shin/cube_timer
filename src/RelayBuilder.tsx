import { useState } from 'react'
import { EVENTS, type EventId } from './types'
import { disciplineLabel, relayDiscipline } from './discipline'

/**
 * Builds a custom relay. There are no presets: every relay is one the user
 * assembled, so this is the only way one comes into existence.
 *
 * Leg ORDER is not chosen here -- storage.ts canonicalises it -- so the
 * preview below is built the same way, and what is shown is what is stored.
 */
export function RelayBuilder({
  onCreate,
  onClose,
}: {
  onCreate: (events: EventId[]) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<EventId[]>([])

  const toggle = (id: EventId) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]))

  // Canonical order, matching createRelaySession, so the preview cannot
  // disagree with the relay that actually gets written.
  const legs = EVENTS.map((e) => e.id).filter((id) => picked.includes(id))
  const enough = legs.length >= 2

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>New relay</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="note">Pick the puzzles. You solve them back to back for one time.</p>

        <div className="relay-events">
          {EVENTS.map((ev) => (
            <label key={ev.id} className="relay-event">
              <input
                type="checkbox"
                checked={picked.includes(ev.id)}
                onChange={() => toggle(ev.id)}
              />
              {ev.name}
            </label>
          ))}
        </div>

        <p className="note">
          {enough ? disciplineLabel(relayDiscipline(legs)) : 'Pick at least two puzzles.'}
        </p>

        <button className="primary" disabled={!enough} onClick={() => onCreate(legs)}>
          Create
        </button>
      </div>
    </div>
  )
}
