import { useCallback, useEffect, useMemo, useState } from 'react'
import { eventName, MAX_SESSIONS, type EventId, type Penalty, type Session, type Solve } from './types'
import { formatMs, formatSolve } from './format'
import { averageOf, best, bestAverage, sessionMean } from './stats'
import { newScramble } from './scramble'
import { loadStore, save, type Store } from './storage'
import { useTimer } from './useTimer'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings'
import { parseTime } from './parseTime'
import { Histogram } from './charts/Histogram'
import { TrendChart } from './charts/TrendChart'
import { ImportDialog } from './ImportDialog'
import { SessionManager } from './SessionManager'
import { SolveDetail } from './SolveDetail'
import { ParityPrompt } from './ParityPrompt'
import { ParityBreakdown } from './ParityBreakdown'
import { hasParity, type ParityId } from './parity'
import { stdDev } from './stats'

export default function App() {
  const [store, setStore] = useState<Store>(() => loadStore())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [scramble, setScramble] = useState('')
  const [scrambling, setScrambling] = useState(true)
  const [typed, setTyped] = useState('')
  const [tab, setTab] = useState<'timer' | 'stats'>('timer')
  const [showSettings, setShowSettings] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [importing, setImporting] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [bucketMs, setBucketMs] = useState(100)
  const [rollWindow, setRollWindow] = useState(50)
  const [toast, setToast] = useState('')
  // Solve awaiting a parity answer; it is already recorded, so a reload
  // during the prompt keeps the time and simply leaves parity unset.
  const [pendingParity, setPendingParity] = useState<string | null>(null)

  const session = store.sessions.find((s) => s.id === store.activeId) ?? store.sessions[0]

  // Newest first, so stats windows are just slices from the front.
  const solves = useMemo(
    () => store.solves.filter((s) => s.sessionId === session.id),
    [store.solves, session.id],
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of store.solves) out[s.sessionId] = (out[s.sessionId] ?? 0) + 1
    return out
  }, [store.solves])

  useEffect(() => {
    if (!save(store) && store.solves.length > 0) {
      setToast("couldn't save — browser storage is full")
    }
  }, [store])

  useEffect(() => saveSettings(settings), [settings])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  const nextScramble = useCallback((eventId: EventId) => {
    setScrambling(true)
    newScramble(eventId)
      .then(setScramble)
      .catch(() => setScramble('scramble failed to generate'))
      .finally(() => setScrambling(false))
  }, [])

  useEffect(() => nextScramble(session.event), [session.event, nextScramble])

  /** Single path for recording a solve, whether timed or typed. */
  const record = useCallback(
    (timeMs: number) => {
      const id = crypto.randomUUID()
      const asking = settings.trackParity && hasParity(session.event)
      setStore((prev) => ({
        ...prev,
        solves: [
          {
            id,
            sessionId: session.id,
            scramble,
            timeMs,
            penalty: 'none' as Penalty,
            createdAt: Date.now(),
            // Events without parity record [] -- definitively none, not
            // unknown -- so they never show up as untracked.
            ...(asking ? {} : { parity: [] as ParityId[] }),
          },
          ...prev.solves,
        ],
      }))
      if (asking) setPendingParity(id)
      nextScramble(session.event)
    },
    [session.id, session.event, scramble, nextScramble, settings.trackParity],
  )

  const typing = settings.inputMode === 'typing'
  // Modals own the keyboard while open, or space would fire a phantom solve.
  const modalOpen =
    showSessions || importing || detailId !== null || showSettings || pendingParity !== null
  const { state, display } = useTimer(record, !typing && !modalOpen)

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault()
    const ms = parseTime(typed)
    if (ms === null) return
    record(ms)
    setTyped('')
  }

  const setPenalty = (id: string, penalty: Penalty) =>
    setStore((prev) => ({
      ...prev,
      solves: prev.solves.map((s) => (s.id === id ? { ...s, penalty } : s)),
    }))

  const deleteSolve = (id: string) =>
    setStore((prev) => ({ ...prev, solves: prev.solves.filter((s) => s.id !== id) }))

  const clearSession = () => {
    if (solves.length && confirm(`Delete all ${solves.length} solves in "${session.name}"?`))
      setStore((prev) => ({
        ...prev,
        solves: prev.solves.filter((s) => s.sessionId !== session.id),
      }))
  }

  const handleImport = (sessions: Session[], imported: Solve[]) => {
    setStore((prev) => ({
      sessions: [...prev.sessions, ...sessions],
      // Imported solves carry their original timestamps, so re-sort the whole
      // list newest-first rather than just prepending them.
      solves: [...imported, ...prev.solves].sort((a, b) => b.createdAt - a.createdAt),
      activeId: sessions[0]?.id ?? prev.activeId,
    }))
    setImporting(false)
    flash(`imported ${imported.length} solves into ${sessions.length} sessions`)
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  const parityEvent = hasParity(session.event)
  const pending = pendingParity ? store.solves.find((s) => s.id === pendingParity) : null
  const detail = detailId ? solves.find((s) => s.id === detailId) : null
  const latest = solves[0]

  return (
    <div className={`app state-${state}`}>
      <header>
        <div className="session-pick">
          <select
            value={session.id}
            onChange={(e) => setStore((prev) => ({ ...prev, activeId: e.target.value }))}
            aria-label="Session"
          >
            {store.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {eventName(s.event)} ({counts[s.id] ?? 0})
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => setShowSessions(true)}>
            manage
          </button>
        </div>

        <div className="header-actions">
          <div className="seg">
            <button className={tab === 'timer' ? 'active' : ''} onClick={() => setTab('timer')}>
              timer
            </button>
            <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>
              stats
            </button>
          </div>
          <button className="ghost" onClick={() => setImporting(true)}>
            import
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
              <button className={!typing ? 'active' : ''} onClick={() => update('inputMode', 'timer')}>
                timer
              </button>
              <button className={typing ? 'active' : ''} onClick={() => update('inputMode', 'typing')}>
                typing
              </button>
            </div>
          </div>

          <div className="setting">
            <div>
              <strong>Parity tracking</strong>
              <p>
                Ask which parities occurred after each solve, on 4x4–7x7. Statistics then split by
                parity so you can see what each one costs.
              </p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.trackParity}
                onChange={(e) => update('trackParity', e.target.checked)}
              />
              <span />
            </label>
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

      {tab === 'timer' && (
        <>
          <p className="scramble">
            {scrambling ? 'generating scramble…' : scramble}
            <button className="ghost small refresh" onClick={() => nextScramble(session.event)}>
              ↻
            </button>
          </p>

          {typing ? (
            <form className="typed" onSubmit={submitTyped}>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="1234"
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
              ? `type 1234 for 12.34s${parseTime(typed) !== null ? ` — ${formatMs(parseTime(typed)!)}` : ''}`
              : state === 'idle'
                ? 'hold space to start'
                : state === 'running'
                  ? ''
                  : 'release to go'}
          </p>
        </>
      )}

      {tab === 'stats' && (
        <div className="stats-view">
          <section className="panel">
            <div className="panel-head">
              <h2>distribution · {session.name}</h2>
              <label className="ctrl">
                bucket
                <select value={bucketMs} onChange={(e) => setBucketMs(Number(e.target.value))}>
                  <option value={50}>0.05s</option>
                  <option value={100}>0.1s</option>
                  <option value={250}>0.25s</option>
                  <option value={500}>0.5s</option>
                  <option value={1000}>1s</option>
                </select>
              </label>
            </div>
            <Histogram
              solves={solves}
              bucketMs={bucketMs}
              splitByParity={parityEvent}
              event={session.event}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>improvement over time</h2>
              <label className="ctrl">
                rolling mean of
                <select value={rollWindow} onChange={(e) => setRollWindow(Number(e.target.value))}>
                  <option value={5}>5</option>
                  <option value={12}>12</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={500}>500</option>
                </select>
              </label>
            </div>
            <TrendChart solves={solves} window={rollWindow} />
          </section>

          {parityEvent && (
            <section className="panel">
              <div className="panel-head">
                <h2>cost of parity</h2>
              </div>
              <ParityBreakdown solves={solves} event={session.event} />
            </section>
          )}
        </div>
      )}

      <div className="body">
        <section className="panel">
          <h2>
            {session.name} · {eventName(session.event)}
          </h2>
          <Stat label="solves" value={String(solves.length)} />
          <Stat label="best" value={fmt(best(solves))} />
          <Stat label="mean" value={fmt(sessionMean(solves))} />
          <Stat label="std dev" value={fmt(stdDev(solves))} />
          <Stat label="ao5" value={fmt(averageOf(solves, 5))} />
          <Stat label="ao12" value={fmt(averageOf(solves, 12))} />
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
          {/* Capped height: a long session must not stretch the page. */}
          <ol className="solves">
            {solves.map((s, i) => (
              <li key={s.id} className={s.id === latest?.id ? 'latest' : ''}>
                <button className="solve-open" onClick={() => setDetailId(s.id)}>
                  <span className="idx">{solves.length - i}.</span>
                  <span className="time">{formatSolve(s)}</span>
                </button>
                <span className="actions">
                  <button
                    className={s.penalty === 'plus2' ? 'on' : ''}
                    onClick={() => setPenalty(s.id, s.penalty === 'plus2' ? 'none' : 'plus2')}
                  >
                    +2
                  </button>
                  <button
                    className={s.penalty === 'dnf' ? 'on' : ''}
                    onClick={() => setPenalty(s.id, s.penalty === 'dnf' ? 'none' : 'dnf')}
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

      {showSessions && (
        <SessionManager
          store={store}
          counts={counts}
          onChange={setStore}
          onClose={() => setShowSessions(false)}
        />
      )}
      {importing && (
        <ImportDialog
          slotsLeft={MAX_SESSIONS - store.sessions.length}
          onImport={handleImport}
          onClose={() => setImporting(false)}
        />
      )}
      {detail && (
        <SolveDetail
          solve={detail}
          ordinal={solves.length - solves.indexOf(detail)}
          event={session.event}
          onPenalty={(p) => setPenalty(detail.id, p)}
          onParity={(parity) =>
            setStore((prev) => ({
              ...prev,
              solves: prev.solves.map((s) => (s.id === detail.id ? { ...s, parity } : s)),
            }))
          }
          onDelete={() => {
            deleteSolve(detail.id)
            setDetailId(null)
          }}
          onClose={() => setDetailId(null)}
        />
      )}
      {pending && (
        <ParityPrompt
          event={session.event}
          timeMs={pending.timeMs}
          onAnswer={(parity) => {
            setStore((prev) => ({
              ...prev,
              solves: prev.solves.map((s) => (s.id === pending.id ? { ...s, parity } : s)),
            }))
            setPendingParity(null)
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
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
