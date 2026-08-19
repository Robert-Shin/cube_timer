import { useMemo, useState } from 'react'
import type { Solve } from '../types'
import { histogram } from '../analysis'
import { formatMs } from '../format'
import { useWidth } from './useWidth'

const HEIGHT = 260
const PAD = { top: 12, right: 12, bottom: 34, left: 44 }

/**
 * Distribution of solve times in fixed-width bins. One series, so no legend --
 * the heading names it.
 */
export function Histogram({ solves, bucketMs }: { solves: Solve[]; bucketMs: number }) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)

  const buckets = useMemo(() => histogram(solves, bucketMs), [solves, bucketMs])

  if (buckets.length === 0) {
    return (
      <div className="chart-empty" ref={ref}>
        no finished solves yet
      </div>
    )
  }

  const plotW = Math.max(80, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const maxCount = Math.max(...buckets.map((b) => b.count))
  const barW = plotW / buckets.length

  const x = (i: number) => PAD.left + i * barW
  const y = (c: number) => PAD.top + plotH - (c / maxCount) * plotH

  // Aim for ~6 ticks, snapped to whole buckets.
  const tickEvery = Math.max(1, Math.round(buckets.length / 6))
  const yTicks = niceTicks(maxCount)
  const active = hover !== null ? buckets[hover] : null

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Distribution of solve times">
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(t)}
              y2={y(t)}
              className="grid"
            />
            <text x={PAD.left - 8} y={y(t)} className="tick" textAnchor="end" dy="0.32em">
              {t}
            </text>
          </g>
        ))}

        {buckets.map((b, i) => {
          const h = (b.count / maxCount) * plotH
          return (
            <rect
              key={b.startMs}
              x={x(i)}
              y={y(b.count)}
              // 2px surface gap between bars; never negative on narrow bins.
              width={Math.max(0.5, barW - 2)}
              height={Math.max(0, h)}
              rx={Math.min(4, barW / 2)}
              className={hover === i ? 'bar bar-on' : 'bar'}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}

        {buckets.map((b, i) =>
          i % tickEvery === 0 ? (
            <text
              key={b.startMs}
              x={x(i) + barW / 2}
              y={HEIGHT - 12}
              className="tick"
              textAnchor="middle"
            >
              {formatMs(b.startMs)}
            </text>
          ) : null,
        )}

        <line
          x1={PAD.left}
          x2={PAD.left + plotW}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          className="axis"
        />
      </svg>

      {active && (
        <div
          className="tooltip"
          style={{
            left: Math.min(width - 130, Math.max(0, x(hover!) + barW / 2 - 65)),
            top: 4,
          }}
        >
          <strong>{active.count}</strong> {active.count === 1 ? 'solve' : 'solves'}
          <span>
            {formatMs(active.startMs)} – {formatMs(active.startMs + active.widthMs)}
          </span>
        </div>
      )}
    </div>
  )
}

/** Whole-number ticks -- counts are never fractional. */
function niceTicks(max: number): number[] {
  const target = 4
  const raw = Math.max(1, max / target)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const ticks: number[] = []
  for (let t = 0; t <= max; t += step) ticks.push(t)
  return ticks
}
