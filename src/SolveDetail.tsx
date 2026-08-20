import type { EventId, Penalty, Solve } from './types'
import { effectiveMs } from './types'
import { formatMs } from './format'
import { parityTypes, sortParity, type ParityId } from './parity'

/** Full record of one solve, including the scramble it was set with. */
export function SolveDetail({
  solve,
  ordinal,
  event,
  onPenalty,
  onParity,
  onDelete,
  onClose,
}: {
  solve: Solve
  ordinal: number
  event: EventId
  onPenalty: (penalty: Penalty) => void
  onParity: (parity: ParityId[]) => void
  onDelete: () => void
  onClose: () => void
}) {
  const types = parityTypes(event)
  const current = solve.parity ?? []
  const toggle = (id: ParityId) =>
    onParity(
      sortParity(current.includes(id) ? current.filter((p) => p !== id) : [...current, id]),
    )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Solve {ordinal}</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="detail-time">{formatMs(effectiveMs(solve))}</div>
        <p className="note">
          {new Date(solve.createdAt).toLocaleString()}
          {solve.penalty !== 'none' && ` · raw ${formatMs(solve.timeMs)}`}
        </p>

        <h3 className="detail-label">Scramble</h3>
        {solve.scramble ? (
          <p className="detail-scramble">{solve.scramble}</p>
        ) : (
          <p className="note">No scramble recorded for this solve</p>
        )}

        {types.length > 0 && (
          <>
            <h3 className="detail-label">
              Parity{solve.parity === undefined ? ' (not recorded)' : ''}
            </h3>
            <div className="seg">
              {types.map((t) => (
                <button
                  key={t.id}
                  className={current.includes(t.id) ? 'active' : ''}
                  onClick={() => toggle(t.id)}
                >
                  {t.label}
                </button>
              ))}
              <button
                className={solve.parity !== undefined && current.length === 0 ? 'active' : ''}
                onClick={() => onParity([])}
              >
                none
              </button>
            </div>
          </>
        )}

        <div className="modal-actions">
          <div className="seg">
            <button
              className={solve.penalty === 'plus2' ? 'active' : ''}
              onClick={() => onPenalty(solve.penalty === 'plus2' ? 'none' : 'plus2')}
            >
              +2
            </button>
            <button
              className={solve.penalty === 'dnf' ? 'active' : ''}
              onClick={() => onPenalty(solve.penalty === 'dnf' ? 'none' : 'dnf')}
            >
              DNF
            </button>
          </div>
          <button className="danger" onClick={onDelete}>
            Delete solve
          </button>
        </div>
      </div>
    </div>
  )
}
