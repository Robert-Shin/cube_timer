import { useMemo, useState } from 'react'
import type { Solve } from '../types'
import { calendarDays, dayKey } from '../analysis'
import { formatMs } from '../format'

const CELL = 13
const GAP = 3
const TOP = 18
const LEFT = 28
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

/**
 * Solves per day for one calendar year, as a week-per-column grid. Shade is a
 * single-hue sequential ramp -- magnitude is one variable, so it gets one hue
 * going light to dark, never a set of unrelated colors.
 */
export function PracticeCalendar({ solves }: { solves: Solve[] }) {
  const days = useMemo(() => calendarDays(solves), [solves])

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const s of solves) set.add(new Date(s.createdAt).getFullYear())
    return [...set].sort((a, b) => b - a)
  }, [solves])

  const [year, setYear] = useState<number | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; key: string } | null>(null)

  if (years.length === 0) return <p className="empty">no solves yet</p>

  const shown = year !== null && years.includes(year) ? year : years[0]

  // Grid starts on the Sunday on or before Jan 1, so weeks line up as columns.
  const jan1 = new Date(shown, 0, 1)
  const start = new Date(shown, 0, 1 - jan1.getDay())
  const dec31 = new Date(shown, 11, 31)
  const weeks = Math.ceil((dec31.getTime() - start.getTime()) / (7 * 86400000)) + 1

  // Quartiles of active days, not a share of the busiest day: one marathon
  // session would otherwise push every ordinary day to the faintest step.
  const counts = [...days.values()].map((d) => d.count).sort((a, b) => a - b)
  const thresholds = [0.25, 0.5, 0.75].map((q) => counts[Math.floor((counts.length - 1) * q)])
  const width = LEFT + weeks * (CELL + GAP)
  const height = TOP + 7 * (CELL + GAP)

  const cells: React.ReactElement[] = []
  const monthLabels: React.ReactElement[] = []

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d)
      if (date.getFullYear() !== shown) continue

      const key = dayKey(date.getTime())
      const day = days.get(key)
      const cx = LEFT + w * (CELL + GAP)
      const cy = TOP + d * (CELL + GAP)

      // First column containing the 1st of a month labels that month.
      if (date.getDate() === 1) {
        monthLabels.push(
          <text key={`m${key}`} x={cx} y={TOP - 6} className="cal-label">
            {MONTHS[date.getMonth()]}
          </text>,
        )
      }

      cells.push(
        <rect
          key={key}
          x={cx}
          y={cy}
          width={CELL}
          height={CELL}
          rx={3}
          className={`cal-cell l${day ? level(day.count, thresholds) : 0}`}
          onMouseEnter={() => setHover({ x: cx, y: cy, key })}
          onMouseLeave={() => setHover(null)}
        />,
      )
    }
  }

  const active = hover ? days.get(hover.key) : null
  const total = [...days.values()]
    .filter((d) => d.date.startsWith(String(shown)))
    .reduce((n, d) => n + d.count, 0)
  const activeDays = [...days.keys()].filter((k) => k.startsWith(String(shown))).length

  return (
    <div className="chart calendar">
      <div className="cal-head">
        <span className="note">
          {total} solves on {activeDays} days in {shown}
        </span>
        {years.length > 1 && (
          <select value={shown} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="cal-scroll">
        <svg width={width} height={height} role="img" aria-label={`Solves per day in ${shown}`}>
          {DAY_LABELS.map((label, i) =>
            label ? (
              <text key={label} x={0} y={TOP + i * (CELL + GAP) + CELL - 3} className="cal-label">
                {label}
              </text>
            ) : null,
          )}
          {monthLabels}
          {cells}
        </svg>
      </div>

      <div className="cal-legend">
        <span className="note">less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`cal-swatch l${l}`} />
        ))}
        <span className="note">more</span>
      </div>

      {hover && (
        <div className="tooltip" style={{ left: Math.max(0, hover.x - 60), top: hover.y + 22 }}>
          <strong>{active ? `${active.count} ${active.count === 1 ? 'solve' : 'solves'}` : 'no solves'}</strong>
          <span>{new Date(hover.key + 'T12:00:00').toLocaleDateString()}</span>
          {active?.meanMs != null && <span>mean {formatMs(active.meanMs)}</span>}
        </div>
      )}
    </div>
  )
}

/** Four filled steps, split at the quartiles of days you actually practised. */
function level(count: number, thresholds: number[]): number {
  if (count <= 0) return 0
  if (count <= thresholds[0]) return 1
  if (count <= thresholds[1]) return 2
  if (count <= thresholds[2]) return 3
  return 4
}
