import { useEffect, useMemo, useState } from 'react'
import type { EventId, Solve } from './types'
import { BUCKET_OPTIONS, suggestBucket } from './analysis'
import { Histogram } from './charts/Histogram'
import { PracticeCalendar } from './charts/PracticeCalendar'
import { TrendChart } from './charts/TrendChart'
import { ParityBreakdown } from './ParityBreakdown'

/**
 * How the panels below are set up to draw: the four view choices plus the
 * bucket width.
 *
 * Held by the PARENT, not by StatsView, because StatsView is rendered inside
 * a tab ternary and unmounts whenever another tab is shown. Owning this state
 * itself would silently throw away a hand-picked bucket, a changed rolling
 * window, an unticked band and the calendar scope on every visit to the timer.
 * Each parent calls useStatsViewState() at its own level, so App's copy
 * outlives the tab switch and a friend's page still gets an independent one.
 */
export interface StatsViewState {
  bucketChoice: number | null
  setBucketChoice: (ms: number) => void
  distSplit: boolean
  setDistSplit: (v: boolean) => void
  rollWindow: number
  setRollWindow: (n: number) => void
  showBand: boolean
  setShowBand: (v: boolean) => void
  calendarScope: 'session' | 'all'
  setCalendarScope: (s: 'session' | 'all') => void
}

/**
 * `resetKey` identifies the set of solves being shown -- App passes the
 * session id, NOT its name: renaming a session must not throw away a width
 * chosen by hand.
 */
export function useStatsViewState(resetKey: string): StatsViewState {
  // null = follow the data's spread (see suggestBucket). A width chosen by
  // hand sticks until the session changes, at which point the spread it was
  // chosen for is gone and auto takes over again.
  const [bucketChoice, setBucketChoice] = useState<number | null>(null)
  // Distribution view on events that have parity: one curve for every solve,
  // or one per parity category overlaid. Ignored on events without parity,
  // where there is only ever one curve to draw.
  const [distSplit, setDistSplit] = useState(true)
  const [rollWindow, setRollWindow] = useState(50)
  const [showBand, setShowBand] = useState(true)
  const [calendarScope, setCalendarScope] = useState<'session' | 'all'>('session')

  useEffect(() => setBucketChoice(null), [resetKey])

  return {
    bucketChoice,
    setBucketChoice,
    distSplit,
    setDistSplit,
    rollWindow,
    setRollWindow,
    showBand,
    setShowBand,
    calendarScope,
    setCalendarScope,
  }
}

/**
 * The stats tab for one set of solves: distribution, improvement over time,
 * practice calendar, and -- on events that have parity -- its cost.
 *
 * `calendarSolves` is a separate prop rather than something derived from
 * `solves`, because the "All sessions" scope needs solves this panel is not
 * otherwise showing. A caller with no wider set (a friend's page) passes the
 * same array for both, which makes the toggle a no-op rather than a lie.
 */
export function StatsView({
  solves,
  calendarSolves,
  title,
  event,
  showParity,
  state,
}: {
  solves: Solve[]
  calendarSolves: Solve[]
  title: string
  event: EventId
  showParity: boolean
  state: StatsViewState
}) {
  const {
    bucketChoice,
    setBucketChoice,
    distSplit,
    setDistSplit,
    rollWindow,
    setRollWindow,
    showBand,
    setShowBand,
    calendarScope,
    setCalendarScope,
  } = state

  const bucketMs = useMemo(() => bucketChoice ?? suggestBucket(solves), [bucketChoice, solves])

  return (
    <div className="stats-view dimmable">
      <section className="panel">
        <div className="panel-head">
          <h2>Distribution · {title}</h2>
          <div className="ctrl-group">
            {showParity && (
              <div className="seg">
                <button className={!distSplit ? 'active' : ''} onClick={() => setDistSplit(false)}>
                  All solves
                </button>
                <button className={distSplit ? 'active' : ''} onClick={() => setDistSplit(true)}>
                  By parity
                </button>
              </div>
            )}
            <label className="ctrl">
              Bucket
              <select value={bucketMs} onChange={(e) => setBucketChoice(Number(e.target.value))}>
                {BUCKET_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {BUCKET_LABELS[ms]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <Histogram
          solves={solves}
          bucketMs={bucketMs}
          splitByParity={showParity && distSplit}
          event={event}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Improvement over time</h2>
          <div className="ctrl-group">
            <label className="ctrl">
              <input
                type="checkbox"
                checked={showBand}
                onChange={(e) => setShowBand(e.target.checked)}
              />
              Percentile band
            </label>
            <label className="ctrl">
              Window
              <select value={rollWindow} onChange={(e) => setRollWindow(Number(e.target.value))}>
                <option value={5}>5</option>
                <option value={12}>12</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={500}>500</option>
              </select>
            </label>
          </div>
        </div>
        <TrendChart solves={solves} window={rollWindow} showBand={showBand} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Practice</h2>
          <div className="seg">
            <button
              className={calendarScope === 'session' ? 'active' : ''}
              onClick={() => setCalendarScope('session')}
            >
              This session
            </button>
            <button
              className={calendarScope === 'all' ? 'active' : ''}
              onClick={() => setCalendarScope('all')}
            >
              All sessions
            </button>
          </div>
        </div>
        <PracticeCalendar solves={calendarScope === 'all' ? calendarSolves : solves} />
      </section>

      {showParity && (
        <section className="panel">
          <div className="panel-head">
            <h2>Cost of parity</h2>
          </div>
          <ParityBreakdown solves={solves} event={event} />
        </section>
      )}
    </div>
  )
}

/** Bucket widths as they read in the picker. */
const BUCKET_LABELS: Record<number, string> = {
  50: '0.05s',
  100: '0.1s',
  250: '0.25s',
  500: '0.5s',
  1000: '1s',
}
