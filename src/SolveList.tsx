import { formatSolve } from './format'
import { parityTags } from './parity'
import type { EventId, Penalty, Solve } from './types'

/**
 * The list of solves, newest first. The four handlers are optional: a list
 * rendered for someone else's solves (a friend's page) passes none of them
 * and is read-only, while the markup and CSS stay shared with the editable
 * one.
 */
export function SolveList({
  solves,
  event,
  pbId,
  latestId,
  showParityTags,
  onOpen,
  onPenalty,
  onDelete,
  onClear,
}: {
  solves: Solve[]
  event: EventId
  pbId: string | null
  latestId: string | null
  showParityTags: boolean
  onOpen?: (id: string) => void
  onPenalty?: (id: string, penalty: Penalty) => void
  onDelete?: (id: string) => void
  onClear?: () => void
}) {
  return (
    <aside className="pane pane-right dimmable">
      <div className="panel-head">
        <h2>Solves</h2>
        {onClear && solves.length > 0 && (
          <button className="ghost small" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {solves.length === 0 && <p className="empty">No solves yet</p>}
      <ol className="solves">
        {solves.map((s, i) => {
          // The same spans either way, so one rule set styles both; only the
          // element around them changes, and the static one has nothing to
          // click.
          const row = (
            <>
              <span className="idx">{solves.length - i}.</span>
              <span className="time">{formatSolve(s)}</span>
              {s.id === pbId && solves.length > 1 && <span className="tag pb-tag">PB</span>}
            </>
          )
          return (
            <li
              key={s.id}
              className={`${s.id === latestId ? 'latest' : ''} ${s.id === pbId ? 'pb' : ''}`}
            >
              {onOpen ? (
                <button className="solve-open" onClick={() => onOpen(s.id)}>
                  {row}
                </button>
              ) : (
                <div className="solve-open static">{row}</div>
              )}
              {showParityTags &&
                parityTags(event, s.parity).map((t) => (
                  <span key={t.id} className={`tag parity-tag p-${t.id}`} title={t.title}>
                    {t.label}
                  </span>
                ))}
              {onPenalty && onDelete && (
                <span className="actions">
                  <button
                    className={s.penalty === 'plus2' ? 'on' : ''}
                    onClick={() => onPenalty(s.id, s.penalty === 'plus2' ? 'none' : 'plus2')}
                  >
                    +2
                  </button>
                  <button
                    className={s.penalty === 'dnf' ? 'on' : ''}
                    onClick={() => onPenalty(s.id, s.penalty === 'dnf' ? 'none' : 'dnf')}
                  >
                    DNF
                  </button>
                  <button className="del" onClick={() => onDelete(s.id)}>
                    ×
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
