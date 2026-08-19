import { useCallback, useEffect, useMemo, useState } from 'react'
import { EVENTS, type EventId, type Penalty, type Solve } from './types'
import { formatMs, formatSolve } from './format'
import { averageOf, best, bestAverage, sessionMean } from './stats'
import { newScramble } from './scramble'
import { loadSolves, saveSolves } from './storage'
import { useTimer } from './useTimer'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings'
import { parseTime } from './parseTime'

export default function App() {
  const [event, setEvent] = useState<EventId>('333')
  const [scramble, setScramble] = useState('')
  const [scrambling, setScrambling] = useState(true)
  const [allSolves, setAllSolves] = useState<Solve[]>(() => loadSolves())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [typed, setTyped] = useState('')

  // Newest first, so stats windows are just slices from the front.
  const solves = useMemo(
    () => allSolves.filter((s) => s.event === event),
    [allSolves, event],
  )

  useEffect(() => saveSolves(allSolves), [allSolves])
  useEffect(() => saveSettings(settings), [settings])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  const nextScramble = useCallback((ev: EventId) => {
    setScrambling(true)
    newScramble(ev)
      .then((s) => setScramble(s))
      .catch(() => setScramble('scramble failed to generate'))
      .finally(() => setScrambling(false))
  }, [])

  useEffect(() => nextScramble(event), [event, nextScramble])

  /** Single path for recording a solve, whether timed or typed. */
  const record = useCallback(
    (timeMs: number) => {
      setAllSolves((prev) => [
        {
          id: crypto.randomUUID(),
          event,
          scramble,
          timeMs,
          penalty: 'none' as Penalty,
          createdAt: Date.now(),
        },
        ...prev,
      ])
      nextScramble(event)
    },
    [event, scramble, nextScramble],
  )

  const typing = settings.inputMode === 'typing'
  const { state, display } = useTimer(record, !typing)

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault()
    const ms = parseTime(typed)
    if (ms === null) return
    record(ms)
    setTyped('')
  }

  const setPenalty = (id: string, penalty: Penalty) =>
    setAllSolves((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, penalty: s.penalty === penalty ? 'none' : penalty } : s,
      ),
    )

  const deleteSolve = (id: string) =>
    setAllSolves((prev) => prev.filter((s) => s.id !== id))

  const clearSession = () => {
    if (solves.length && confirm(`Delete all ${solves.length} solves for this event?`))
      setAllSolves((prev) => prev.filter((s) => s.event !== event))
  }

  const latest = solves[0]
  const ao5 = averageOf(solves, 5)
  const ao12 = averageOf(solves, 12)

  return (
    <div className={`app state-${state}`}>
      <header>
        <div className="events">
          {EVENTS.map((ev) => (
            <button
              key={ev.id}
              className={ev.id === event ? 'active' : ''}
              onClick={() => setEvent(ev.id)}
            >
              {ev.name}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <button className="ghost" onClick={() => nextScramble(event)}>
            new scramble
          </button>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            settings
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="panel settings">
          <div className="panel-head">
            <h2>settings</h2>
            <button className="ghost small" onClick={() => setSettings(DEFAULT_SETTINGS)}>
              reset
            </button>
          </div>

          <div className="setting">
            <div>
              <strong>Time entry</strong>
              <p>Use the space-bar stopwatch, or type times in by hand.</p>
            </div>
            <div className="seg">
              <button
                className={!typing ? 'active' : ''}
                onClick={() => update('inputMode', 'timer')}
              >
                timer
              </button>
              <button
                className={typing ? 'active' : ''}
                onClick={() => update('inputMode', 'typing')}
              >
                typing
              </button>
            </div>
          </div>

          <div className="setting">
            <div>
              <strong>Hide time while solving</strong>
              <p>Shows "solving" instead of a running count. The time still records.</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.hideTimeWhileSolving}
                onChange={(e) => update('hideTimeWhileSolving', e.target.checked)}
              />
              <span />
            </label>
          </div>
        </section>
      )}

      <p className="scramble">{scrambling ? 'generating scramble…' : scramble}</p>

      {typing ? (
        <form className="typed" onSubmit={submitTyped}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="12.34"
            aria-label="Enter solve time"
            autoFocus
          />
          <button type="submit" disabled={parseTime(typed) === null}>
            add
          </button>
        </form>
      ) : (
        <div className="timer">
          {settings.hideTimeWhileSolving && state === 'running' ? 'solving' : formatMs(display)}
        </div>
      )}
      <p className="hint">
        {typing
          ? 'type a time like 12.34 or 1:05.43, then press enter'
          : state === 'idle'
            ? 'hold space to start'
            : state === 'running'
              ? ''
              : 'release to go'}
      </p>

      <div className="body">
        <section className="panel">
          <h2>session · {EVENTS.find((e) => e.id === event)!.name}</h2>
          <Stat label="solves" value={String(solves.length)} />
          <Stat label="best" value={fmt(best(solves))} />
          <Stat label="mean" value={fmt(sessionMean(solves))} />
          <Stat label="ao5" value={fmt(ao5)} />
          <Stat label="ao12" value={fmt(ao12)} />
          <Stat label="best ao5" value={fmt(bestAverage(solves, 5))} />
          <Stat label="best ao12" value={fmt(bestAverage(solves, 12))} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>solves</h2>
            {solves.length > 0 && (
              <button className="ghost small" onClick={clearSession}>
                clear
              </button>
            )}
          </div>
          {solves.length === 0 && <p className="empty">no solves yet</p>}
          <ol className="solves">
            {solves.map((s, i) => (
              <li key={s.id} className={s.id === latest?.id ? 'latest' : ''}>
                <span className="idx">{solves.length - i}.</span>
                <span className="time">{formatSolve(s)}</span>
                <span className="actions">
                  <button
                    className={s.penalty === 'plus2' ? 'on' : ''}
                    onClick={() => setPenalty(s.id, 'plus2')}
                  >
                    +2
                  </button>
                  <button
                    className={s.penalty === 'dnf' ? 'on' : ''}
                    onClick={() => setPenalty(s.id, 'dnf')}
                  >
                    DNF
                  </button>
                  <button onClick={() => deleteSolve(s.id)}>×</button>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  )
}

/** undefined = not enough solves yet, null = DNF. */
function fmt(v: number | null | undefined): string {
  return v === undefined ? '—' : formatMs(v)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
