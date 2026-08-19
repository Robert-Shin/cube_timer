import { useMemo, useState } from 'react'
import type { EventId, Solve } from '../types'
import { histogram } from '../analysis'
import { formatMs } from '../format'
import { useWidth } from './useWidth'

const HEIGHT = 280
const PAD = { top: 12, right: 12, bottom: 34, left: 44 }

/**
 * Distribution of solve times in fixed-width bins, optionally stacked by
 * parity category so the shift each parity causes is visible in place.
 */
export function Histogram({
  solves,
  bucketMs,
  splitByParity = false,
  event,
}: {
  solves: Solve[]
  bucketMs: number
  splitByParity?: boolean
  event: EventId
}) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)

  const { buckets, series } = useMemo(
    () => histogram(solves, bucketMs, splitByParity, event),
    [solves, bucketMs, splitByParity, event],
  )

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

  const tickEvery = Math.max(1, Math.round(buckets.length / 6))
  const yTicks = niceTicks(maxCount)
  const active = hover !== null ? buckets[hover] : null
  const barPx = Math.max(0.5, barW - 2)

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s, i) => (
            <span key={s.key}>
              <i className={`swatch box s${i + 1}`} /> {s.label} ({s.count})
            </span>
          ))}
        </div>
      )}

      <svg width={width} height={HEIGHT} role="img" aria-label="Distribution of solve times">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.left - 8} y={y(t)} className="tick" textAnchor="end" dy="0.32em">
              {t}
            </text>
          </g>
        ))}

        {buckets.map((b, i) => {
          if (b.count === 0) return null

          // Unsplit: one bar. Split: segments stacked from the baseline up,
          // in the shared series order so colors mean the same thing in
          // every bin.
          const segments =
            series.length > 1
              ? series.map((s) => ({ key: s.key, n: b.parts[s.key] ?? 0 }))
              : [{ key: 'all', n: b.count }]

          let acc = 0
          return (
            <g
              key={b.startMs}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Full-height hit area: thin bars are hard to hover. */}
              <rect x={x(i)} y={PAD.top} width={barW} height={plotH} fill="transparent" />
              {segments.map((seg, si) => {
                if (seg.n === 0) return null
                const h = (seg.n / maxCount) * plotH
                const yTop = PAD.top + plotH - ((acc + seg.n) / maxCount) * plotH
                acc += seg.n
                return (
                  <rect
                    key={seg.key}
                    x={x(i)}
                    y={yTop}
                    width={barPx}
                    // 2px surface gap between stacked segments, but never
                    // shrink a segment out of existence.
                    height={Math.max(0.5, h - (si > 0 ? 2 : 0))}
                    rx={Math.min(4, barW / 2)}
                    className={`bar s${series.length > 1 ? si + 1 : 1} ${hover === i ? 'bar-on' : ''}`}
                  />
                )
              })}
            </g>
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

      {active && active.count > 0 && (
        <div
          className="tooltip"
          style={{ left: Math.min(width - 150, Math.max(0, x(hover!) + barW / 2 - 75)), top: 4 }}
        >
          <strong>
            {active.count} {active.count === 1 ? 'solve' : 'solves'}
          </strong>
          <span>
            {formatMs(active.startMs)} – {formatMs(active.startMs + active.widthMs)}
          </span>
          {series.length > 1 &&
            series.map((s, i) =>
              active.parts[s.key] ? (
                <span key={s.key} className="tip-row">
                  <i className={`swatch box s${i + 1}`} /> {s.label}: {active.parts[s.key]}
                </span>
              ) : null,
            )}
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
