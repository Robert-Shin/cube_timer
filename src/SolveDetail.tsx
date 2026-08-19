import type { Penalty, Solve } from './types'
import { effectiveMs } from './types'
import { formatMs } from './format'

/** Full record of one solve, including the scramble it was set with. */
export function SolveDetail({
  solve,
  ordinal,
  onPenalty,
  onDelete,
  onClose,
}: {
  solve: Solve
  ordinal: number
  onPenalty: (penalty: Penalty) => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>solve {ordinal}</h2>
          <button className="ghost small" onClick={onClose}>
            close
          </button>
        </div>

        <div className="detail-time">{formatMs(effectiveMs(solve))}</div>
        <p className="note">
          {new Date(solve.createdAt).toLocaleString()}
          {solve.penalty !== 'none' && ` · raw ${formatMs(solve.timeMs)}`}
        </p>

        <h3 className="detail-label">scramble</h3>
        {solve.scramble ? (
          <p className="detail-scramble">{solve.scramble}</p>
        ) : (
          <p className="note">no scramble recorded for this solve</p>
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
            delete solve
          </button>
        </div>
      </div>
    </div>
  )
}
