import type { Solve } from './types'
import { formatMs } from './format'
import { averageOf, best, bestAverage, sessionMean, stdDev, subXRate } from './stats'

/** The averages cubers actually read, in the order they read them. */
const WINDOWS = [5, 12, 50, 100, 1000] as const

/**
 * Current and best for every average, as one table.
 *
 * A table rather than a stack of label/value rows: the comparison people make
 * is "how does this session's ao12 compare to my best ao12", and that only
 * reads if the two numbers sit in adjacent columns.
 */
export function StatsPane({ solves, goalMs }: { solves: Solve[]; goalMs: number | null }) {
  const subX = goalMs !== null ? subXRate(solves, goalMs) : null

  return (
    <div className="stats-pane">
      <table className="figures">
        <thead>
          <tr>
            <th />
            <th>current</th>
            <th>best</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>single</th>
            <td>{last(solves)}</td>
            <td className="hi">{cell(best(solves))}</td>
          </tr>
          {WINDOWS.map((n) => (
            <tr key={n}>
              <th>ao{n}</th>
              <td>{cell(averageOf(solves, n))}</td>
              <td className="hi">{cell(bestAverage(solves, n))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="figures secondary">
        <tbody>
          <tr>
            <th>solves</th>
            <td>{solves.length}</td>
          </tr>
          <tr>
            <th>mean</th>
            <td>{cell(sessionMean(solves))}</td>
          </tr>
          <tr>
            <th>deviation</th>
            <td>{cell(stdDev(solves))}</td>
          </tr>
          {goalMs !== null && (
            <tr title={subX ? `${subX.under} of ${subX.total} solves, DNFs included` : undefined}>
              <th>sub-{formatMs(goalMs).replace(/\.00$/, '')}</th>
              <td>{subX ? `${Math.round(subX.rate * 100)}%` : '—'}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** The most recent solve, which is what "current single" means. */
function last(solves: Solve[]): string {
  return solves.length === 0 ? '—' : formatMs(solves[0].timeMs)
}

/**
 * undefined = not enough solves for this window, null = the value is a DNF.
 * Both print as a dash rather than claiming a failed solve.
 */
function cell(v: number | null | undefined): string {
  return v == null ? '—' : formatMs(v)
}
