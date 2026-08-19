import { useEffect, useState } from 'react'
import type { EventId } from './types'
import { formatMs } from './format'
import { parityTypes, sortParity, type ParityId } from './parity'

/**
 * Asks which parities occurred, as one prompt covering every parity the event
 * can have. Number keys toggle, enter confirms -- it appears after every solve,
 * so it has to be answerable without leaving the keyboard.
 */
export function ParityPrompt({
  event,
  timeMs,
  onAnswer,
}: {
  event: EventId
  timeMs: number
  onAnswer: (parity: ParityId[]) => void
}) {
  const types = parityTypes(event)
  const [picked, setPicked] = useState<ParityId[]>([])

  const toggle = (id: ParityId) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Swallow space so it can't fall through and arm the timer.
      if (e.code === 'Space') {
        e.preventDefault()
        return
      }
      const n = Number(e.key)
      if (n >= 1 && n <= types.length) {
        e.preventDefault()
        toggle(types[n - 1].id)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onAnswer(sortParity(picked))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onAnswer([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="modal-backdrop">
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>parity?</h2>
          <span className="note">{formatMs(timeMs)}</span>
        </div>

        <div className="parity-options">
          {types.map((t, i) => (
            <button
              key={t.id}
              className={`parity-option ${picked.includes(t.id) ? 'on' : ''}`}
              onClick={() => toggle(t.id)}
            >
              <kbd>{i + 1}</kbd>
              <span>
                <strong>{t.label}</strong>
                <small>{t.hint}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="modal-actions">
          <span className="note">
            {picked.length === 0 ? 'nothing selected — saves as no parity' : `${picked.length} selected`}
          </span>
          <button className="primary" onClick={() => onAnswer(sortParity(picked))} autoFocus>
            save {picked.length === 0 ? 'no parity' : ''}
          </button>
        </div>
        <p className="note kbd-hint">
          press <kbd>1</kbd>–<kbd>{types.length}</kbd> to toggle, <kbd>enter</kbd> to save
        </p>
      </div>
    </div>
  )
}
