import { useEffect, useMemo, useState } from 'react'
import type { EventId, Solve } from '../types'
import { histogram } from '../analysis'
import { formatMs } from '../format'
import { useWidth } from './useWidth'

const HEIGHT = 280
const PAD = { top: 12, right: 12, bottom: 34, left: 44 }

/**
 * Distribution of solve times in fixed-width bins.
 *
 * With `splitByParity` the parity categories are drawn as separate curves
 * overlaid on a shared baseline rather than stacked. Stacking answers "how
 * many solves in this bin, and of what kind" -- but the question parity
 * tracking exists to answer is "does this parity shift my times", and that is
 * a comparison of *shapes*. A stacked segment starts wherever the segment
 * below it ended, so no two categories share a baseline and their shapes
 * cannot be compared at all. Every curve here starts at zero.
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
  // Series keys the reader has picked out of the pile. Empty is the resting
  // state, where every curve is drawn at the same low strength; once anything
  // is picked, the rest recede so the comparison is between the picks.
  const [highlit, setHighlit] = useState<ReadonlySet<string>>(new Set())

  const { buckets, series } = useMemo(
    () => histogram(solves, bucketMs, splitByParity, event),
    [solves, bucketMs, splitByParity, event],
  )

  // Switching event or session replaces the categories entirely, so a
  // highlight held over from the old ones would silently dim everything.
  const seriesIds = series.map((s) => s.key).join('|')
  useEffect(() => setHighlit(new Set()), [seriesIds])

  if (buckets.length === 0) {
    return (
      <div className="chart-empty" ref={ref}>
        no finished solves yet
      </div>
    )
  }

  const overlaid = series.length > 1
  const plotW = Math.max(80, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  // Overlaid curves are scaled to the tallest single category, not to the
  // combined total: scaling to the total would squash every curve into the
  // bottom of the plot, which is the flattening this view exists to undo.
  const maxCount = overlaid
    ? Math.max(1, ...buckets.flatMap((b) => series.map((s) => b.parts[s.key] ?? 0)))
    : Math.max(...buckets.map((b) => b.count))
  const barW = plotW / buckets.length

  const x = (i: number) => PAD.left + i * barW
  const y = (c: number) => PAD.top + plotH - (c / maxCount) * plotH

  const tickEvery = Math.max(1, Math.round(buckets.length / 6))
  const yTicks = niceTicks(maxCount)
  const active = hover !== null ? buckets[hover] : null
  const barPx = Math.max(0.5, barW - 2)

  return (
    <div className="chart" ref={ref}>
      {overlaid && (
        <div className="legend legend-toggles">
          {series.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={highlit.has(s.key)}
              className={highlit.has(s.key) ? 'on' : highlit.size > 0 ? 'off' : ''}
              onClick={() =>
                setHighlit((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(s.key)) next.add(s.key)
                  return next
                })
              }
            >
              <i className={`swatch box s${i + 1}`} /> {s.label} ({s.count})
            </button>
          ))}
          {highlit.size > 0 && (
            <button type="button" className="legend-clear" onClick={() => setHighlit(new Set())}>
              Show all evenly
            </button>
          )}
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

        {overlaid
          ? // Highlighted curves are drawn last so they sit on top of the
            // ones they are being compared against. The colour index is the
            // series' own position, never its position in this order --
            // repainting a curve because it was picked would break the one
            // thing the legend promises.
            series
              .map((s, si) => ({ s, si }))
              .sort((a, b) => Number(highlit.has(a.s.key)) - Number(highlit.has(b.s.key)))
              .map(({ s, si }) => {
                const path = stepPath(
                  buckets.map((b) => b.parts[s.key] ?? 0),
                  x,
                  y,
                  PAD.top + plotH,
                )
                const emphasis = highlit.has(s.key) ? 'dist-on' : highlit.size > 0 ? 'dist-off' : ''
                // Fill and outline are one path each: the translucent fill is
                // what lets a curve behind another still be read, and the
                // opaque outline is what keeps its own shape legible where
                // three fills have piled up.
                return (
                  <g key={s.key} className={emphasis}>
                    <path d={path} className={`dist-area s${si + 1}`} />
                    <path d={path} className={`dist-line s${si + 1}`} />
                  </g>
                )
              })
          : buckets.map((b, i) =>
              b.count === 0 ? null : (
                <rect
                  key={b.startMs}
                  x={x(i)}
                  y={y(b.count)}
                  width={barPx}
                  height={PAD.top + plotH - y(b.count)}
                  rx={Math.min(4, barW / 2)}
                  className={`bar s1 ${hover === i ? 'bar-on' : ''}`}
                />
              ),
            )}

        {/* Hit areas last, so they sit above the marks. Full plot height,
            because thin bars and thin curves are both hard to hover. */}
        {buckets.map((b, i) => (
          <rect
            key={b.startMs}
            x={x(i)}
            y={PAD.top}
            width={barW}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}

        {hover !== null && (
          <line
            x1={x(hover) + barW / 2}
            x2={x(hover) + barW / 2}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="crosshair"
          />
        )}

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
          {overlaid &&
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

/**
 * A closed step outline over the counts: flat across each bin's full width,
 * vertical at the edges, and returning along the baseline so it can be filled.
 * Drawn as steps rather than a smoothed line because a histogram bin is an
 * interval, and a curve through bin centres invents times between them.
 */
function stepPath(
  counts: number[],
  x: (i: number) => number,
  y: (c: number) => number,
  baseY: number,
): string {
  const parts = [`M ${x(0)} ${baseY}`]
  counts.forEach((c, i) => {
    parts.push(`L ${x(i)} ${y(c)}`, `L ${x(i + 1)} ${y(c)}`)
  })
  parts.push(`L ${x(counts.length)} ${baseY}`, 'Z')
  return parts.join(' ')
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
