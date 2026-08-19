import { useMemo, useState } from 'react'
import type { Solve } from '../types'
import { trend } from '../analysis'
import { formatMs } from '../format'
import { useWidth } from './useWidth'

const HEIGHT = 300
const PAD = { top: 14, right: 12, bottom: 34, left: 52 }

/**
 * Every solve in chronological order with a trailing rolling mean over it.
 * Both series are times in the same unit, so they share one y-axis -- never a
 * second scale.
 */
export function TrendChart({ solves, window }: { solves: Solve[]; window: number }) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)

  const points = useMemo(() => trend(solves, window), [solves, window])
  const finished = useMemo(
    () => points.filter((p) => p.timeMs !== null) as { index: number; timeMs: number }[],
    [points],
  )

  const plotW = Math.max(80, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom

  const scales = useMemo(() => {
    if (finished.length === 0) return null
    const times = finished.map((p) => p.timeMs)
    // Clip the top at the 99th percentile so a few disasters don't flatten
    // everything else; outliers still draw, pinned to the edge.
    const sorted = [...times].sort((a, b) => a - b)
    const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]
    const lo = sorted[0]
    const pad = (hi - lo) * 0.08 || 1000
    const max = hi + pad
    return {
      min: Math.max(0, lo - pad),
      max,
      n: points.length,
      clipped: times.filter((t) => t > max).length,
    }
  }, [finished, points.length])

  if (!scales) {
    return (
      <div className="chart-empty" ref={ref}>
        no finished solves yet
      </div>
    )
  }

  const x = (i: number) => PAD.left + ((i - 1) / Math.max(1, scales.n - 1)) * plotW
  const y = (ms: number) => {
    const frac = (ms - scales.min) / (scales.max - scales.min)
    return PAD.top + plotH - Math.min(1, Math.max(0, frac)) * plotH
  }

  const line = points
    .filter((p) => p.rollingMs !== null)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.index).toFixed(1)},${y(p.rollingMs!).toFixed(1)}`)
    .join(' ')

  const yTicks = timeTicks(scales.min, scales.max)
  const active = hover !== null ? points[hover] : null

  // Nearest-point lookup from the pointer's x position.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - box.left - PAD.left) / plotW
    const i = Math.round(frac * (scales.n - 1))
    setHover(i >= 0 && i < scales.n ? i : null)
  }

  return (
    <div className="chart" ref={ref}>
      <div className="legend">
        <span>
          <i className="swatch dot" /> individual solves
        </span>
        <span>
          <i className="swatch line" /> rolling mean of {window}
        </span>
        {scales.clipped > 0 && (
          <span className="dim">
            {scales.clipped} slower {scales.clipped === 1 ? 'solve' : 'solves'} above the axis
          </span>
        )}
      </div>

      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Solve times over time with a rolling mean of ${window}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.left - 8} y={y(t)} className="tick" textAnchor="end" dy="0.32em">
              {formatMs(t)}
            </text>
          </g>
        ))}

        {/* Raw solves sit under the mean so the trend stays readable. */}
        <g className="dots">
          {finished.map((p) => (
            <circle
              key={p.index}
              cx={x(p.index)}
              cy={y(p.timeMs)}
              r={finished.length > 800 ? 1.3 : 2.2}
              // Pinned to the top edge rather than plotted at their true
              // height -- flagged so they don't read as real values there.
              className={p.timeMs > scales.max ? 'clipped' : undefined}
            />
          ))}
        </g>

        <path d={line} className="rolling" />

        {active && (
          <>
            <line
              x1={x(active.index)}
              x2={x(active.index)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              className="crosshair"
            />
            {active.timeMs !== null && (
              <circle cx={x(active.index)} cy={y(active.timeMs)} r={4} className="marker" />
            )}
          </>
        )}

        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          className="axis"
        />
        <text x={PAD.left} y={HEIGHT - 12} className="tick">
          1
        </text>
        <text x={PAD.left + plotW} y={HEIGHT - 12} className="tick" textAnchor="end">
          {scales.n}
        </text>
      </svg>

      {active && (
        <div
          className="tooltip"
          style={{ left: Math.min(width - 150, Math.max(0, x(active.index) - 75)), top: 4 }}
        >
          <strong>{active.timeMs === null ? 'DNF' : formatMs(active.timeMs)}</strong>
          <span>solve #{active.index}</span>
          {active.rollingMs !== null && <span>mean {formatMs(active.rollingMs)}</span>}
          <span className="dim">{new Date(active.at).toLocaleDateString()}</span>
        </div>
      )}
    </div>
  )
}

/** Ticks on round time values (1s, 2s, 5s, 10s, …). */
function timeTicks(min: number, max: number): number[] {
  const span = max - min
  const steps = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
  const step = steps.find((s) => span / s <= 6) ?? 600000
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t)
  return ticks
}
