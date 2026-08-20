import type { EventId, Solve } from './types'
import { parityGroups } from './stats'
import { formatMs } from './format'

/**
 * Mean and spread per parity category, with the gap to the no-parity mean --
 * the expected cost of each parity.
 */
export function ParityBreakdown({ solves, event }: { solves: Solve[]; event: EventId }) {
  const groups = parityGroups(solves, event).filter((g) => g.finished > 0)

  if (groups.length === 0) return <p className="empty">No solves yet</p>
  if (groups.length === 1 && groups[0].key === 'untracked') {
    return <p className="empty">Turn on parity tracking in settings to break these solves down</p>
  }

  const hasClean = groups.some((g) => g.key === 'none')

  return (
    <>
      <table className="breakdown">
        <thead>
          <tr>
            <th>category</th>
            <th>n</th>
            <th>mean</th>
            <th>sd</th>
            <th>vs clean</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={g.key} className={g.key === 'untracked' ? 'muted' : ''}>
              <td>
                <i className={`swatch box s${Math.min(i + 1, 4)}`} /> {g.label}
              </td>
              <td>{g.finished}</td>
              <td>{g.mean === null ? '—' : formatMs(g.mean)}</td>
              <td>{g.sd === null ? '—' : formatMs(g.sd)}</td>
              <td className={g.deltaMs !== null && g.deltaMs > 0 ? 'slower' : ''}>
                {g.deltaMs === null ? '—' : `${g.deltaMs > 0 ? '+' : ''}${formatMs(Math.abs(g.deltaMs))}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!hasClean && (
        <p className="note">
          No clean solves recorded yet, so there's nothing to compare against
        </p>
      )}
      {groups.some((g) => g.key === 'untracked') && (
        <p className="note">
          Untracked solves were recorded before parity tracking was on. They're kept out of the
          comparison rather than counted as clean.
        </p>
      )}
    </>
  )
}
