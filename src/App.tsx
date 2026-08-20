import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveMs, eventName, MAX_SESSIONS, type EventId, type Penalty, type Session, type Solve } from './types'
import { formatMs, formatSolve } from './format'
import { averageOf, best } from './stats'
import { newScramble } from './scramble'
import { loadStore, save, type Store } from './storage'
import { useTimer } from './useTimer'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings'
import { parseTime } from './parseTime'
import { clearBackground, loadBackground, prepareImage, saveBackground } from './background'
import { touch, tombstone } from './sync/stamp'
import { visible } from './sync/merge'
import { useSync } from './sync/engine'
import { AuthPanel } from './AuthPanel'
import { syncConfigured } from './supabase'
import { Histogram } from './charts/Histogram'
import { PracticeCalendar } from './charts/PracticeCalendar'
import { TrendChart } from './charts/TrendChart'
import { ImportDialog } from './ImportDialog'
import { SessionManager } from './SessionManager'
import { SolveDetail } from './SolveDetail'
import { ParityPrompt } from './ParityPrompt'
import { ParityBreakdown } from './ParityBreakdown'
import { hasParity, parityTags, type ParityId } from './parity'
import { StatsPane } from './StatsPane'
import { suggestGoal } from './stats'

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
  const [showBand, setShowBand] = useState(true)
  const [calendarScope, setCalendarScope] = useState<'session' | 'all'>('session')
  const [toast, setToast] = useState('')
  const [showAuth, setShowAuth] = useState(false)
  // Solve awaiting a parity answer; it is already recorded, so a reload
  // during the prompt keeps the time and simply leaves parity unset.
  const [pendingParity, setPendingParity] = useState<string | null>(null)
  const typedInput = useRef<HTMLInputElement>(null)
  const settingsPanel = useRef<HTMLElement>(null)
  const settingsBtn = useRef<HTMLButtonElement>(null)
  const [background, setBackground] = useState<string | null>(null)

  // Tombstoned rows stay in the store so their deletion can propagate, but
  // they must never reach the UI or the statistics.
  const liveSessions = useMemo(() => visible(store.sessions), [store.sessions])
  const liveSolves = useMemo(() => visible(store.solves), [store.solves])

  const session = liveSessions.find((s) => s.id === store.activeId) ?? liveSessions[0]

  // Newest first, so stats windows are just slices from the front.
  const solves = useMemo(
    () => liveSolves.filter((s) => s.sessionId === session.id),
    [liveSolves, session.id],
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of liveSolves) out[s.sessionId] = (out[s.sessionId] ?? 0) + 1
    return out
  }, [liveSolves])

  useEffect(() => {
    if (!save(store) && store.solves.length > 0) {
      setToast("Couldn't save — browser storage is full")
    }
  }, [store])

  const sync = useSync(store, setStore)

  // The blob URL is owned by this component: whatever it points at must be
  // revoked when it is replaced, or every change leaks the previous photo.
  useEffect(() => {
    let url: string | null = null
    loadBackground().then((blob) => {
      if (!blob) return
      url = URL.createObjectURL(blob)
      setBackground(url)
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [])

  const chooseBackground = async (file: File) => {
    try {
      const blob = await prepareImage(file)
      await saveBackground(blob)
      setBackground((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
    } catch {
      flash("couldn't read that image")
    }
  }

  const removeBackground = async () => {
    await clearBackground().catch(() => {})
    setBackground((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }

  useEffect(() => saveSettings(settings), [settings])

  useEffect(() => {
    // 'system' removes the attribute so prefers-color-scheme decides.
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  useEffect(() => {
    if (settings.inputMode === 'typing' && tab === 'timer') typedInput.current?.focus()
  }, [settings.inputMode, tab, session.id])

  // Settings is a panel, not a modal, so it dismisses like one: click away or
  // press Escape. The toggle button is excluded, or its own click would close
  // and immediately reopen.
  useEffect(() => {
    if (!showSettings) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (settingsPanel.current?.contains(target) || settingsBtn.current?.contains(target)) return
      setShowSettings(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSettings(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showSettings])

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
            updatedAt: Date.now(),
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
    showSessions ||
    importing ||
    detailId !== null ||
    showSettings ||
    showAuth ||
    pendingParity !== null
  const { state, display } = useTimer(record, !typing && !modalOpen)

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault()
    const ms = parseTime(typed)
    if (ms === null) return
    record(ms)
    setTyped('')
    // Stay in the field so a session of old times can be entered without
    // reaching for the mouse between each one.
    typedInput.current?.focus()
  }

  const setPenalty = (id: string, penalty: Penalty) =>
    setStore((prev) => ({
      ...prev,
      solves: prev.solves.map((s) => (s.id === id ? touch(s, { penalty }) : s)),
    }))

  const deleteSolve = (id: string) =>
    setStore((prev) => ({
      ...prev,
      solves: prev.solves.map((s) => (s.id === id ? tombstone(s) : s)),
    }))

  const clearSession = () => {
    if (solves.length && confirm(`Delete all ${solves.length} solves in "${session.name}"?`))
      setStore((prev) => ({
        ...prev,
        solves: prev.solves.map((s) => (s.sessionId === session.id ? tombstone(s) : s)),
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
    flash(`Imported ${imported.length} solves into ${sessions.length} sessions`)
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  // An unset goal falls back to a suggestion from the data, so the rate is
  // useful before anyone opens the session manager.
  const goal = session.goalMs ?? suggestGoal(solves)
  const parityEvent = hasParity(session.event)
  // Tags only make sense while tracking is on: with it off, older solves would
  // keep showing parity that new solves silently never record.
  const showParityTags = settings.trackParity && parityEvent
  const pending = pendingParity ? liveSolves.find((s) => s.id === pendingParity) : null
  const detail = detailId ? solves.find((s) => s.id === detailId) : null
  const latest = solves[0]
  // The single fastest solve in the session: the one result worth colouring.
  const pbId = useMemo(() => {
    let bestId: string | null = null
    let bestMs = Infinity
    for (const s of solves) {
      if (s.penalty === 'dnf') continue
      const ms = effectiveMs(s)
      if (ms !== null && ms < bestMs) {
        bestMs = ms
        bestId = s.id
      }
    }
    return bestId
  }, [solves])

  return (
    <div className={`app state-${state} tab-${tab}`}>
      <header className="dimmable">
        {/* Left: identity and the things you reach for rarely. */}
        <div className="brand">
          <div className="wordmark">
            <svg className="mark" viewBox="0 0 32 22" aria-hidden="true">
              <path className="curve" d="M1 18C9 18 12.5 3 16 3s7 15 15 15z" />
              <path className="axis" d="M1 19.3h30" />
            </svg>
            <span>Cube Stats</span>
          </div>
          <div className="util">
            <button className="ghost" onClick={() => setImporting(true)}>
              Import
            </button>
            {syncConfigured && (
              <button className="ghost" onClick={() => setShowAuth(true)}>
                {sync.email ? (
                  <>
                    <i className={`sync-dot ${sync.state}`} /> Account
                  </>
                ) : (
                  'Sign in'
                )}
              </button>
            )}
            <button ref={settingsBtn} className="ghost" onClick={() => setShowSettings((v) => !v)}>
              Settings
            </button>
          </div>
        </div>

        {/* Right: what you actually operate. */}
        <div className="header-actions">
          <div className="session-pick">
            <select
              value={session.id}
              onChange={(e) => setStore((prev) => ({ ...prev, activeId: e.target.value }))}
              aria-label="Session"
            >
              {liveSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {eventName(s.event)} ({counts[s.id] ?? 0})
                </option>
              ))}
            </select>
            <button className="ghost small manage" onClick={() => setShowSessions(true)}>
              Manage
            </button>
          </div>
          <div className="seg tabs">
            <button className={tab === 'timer' ? 'active' : ''} onClick={() => setTab('timer')}>
              Timer
            </button>
            <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>
              Stats
            </button>
          </div>
        </div>
      </header>

      {showSettings && (
        <section className="panel settings dimmable" ref={settingsPanel}>
          <div className="panel-head">
            <div className="head-left">
              <h2>Settings</h2>
              <button className="ghost small" onClick={() => setSettings(DEFAULT_SETTINGS)}>
                Reset
              </button>
            </div>
            <button
              className="ghost small close"
              onClick={() => setShowSettings(false)}
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          <div className="setting">
            <div>
              <strong>Time entry</strong>
              <p>Use the space-bar stopwatch, or type times in by hand.</p>
            </div>
            <div className="seg">
              <button className={!typing ? 'active' : ''} onClick={() => update('inputMode', 'timer')}>
                Timer
              </button>
              <button className={typing ? 'active' : ''} onClick={() => update('inputMode', 'typing')}>
                Typing
              </button>
            </div>
          </div>

          <div className="setting">
            <div>
              <strong>Theme</strong>
              <p>Follow the system setting, or pick one.</p>
            </div>
            <div className="seg">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  className={settings.theme === t ? 'active' : ''}
                  onClick={() => update('theme', t)}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
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
              <strong>Background</strong>
              <p>
                A photo behind the timer. Stored on this device only, never synced. The dim keeps
                the time readable over it.
              </p>
            </div>
            <div className="bg-controls">
              <label className="file-button">
                {background ? 'Replace' : 'Choose photo'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) chooseBackground(file)
                    e.target.value = ''
                  }}
                />
              </label>
              {background && (
                <>
                  <label className="ctrl">
                    dim
                    <input
                      type="range"
                      min={0}
                      max={0.95}
                      step={0.05}
                      value={settings.backgroundDim}
                      onChange={(e) => update('backgroundDim', Number(e.target.value))}
                      aria-label="Background dim"
                    />
                  </label>
                  <button className="ghost small" onClick={removeBackground}>
                    Remove
                  </button>
                </>
              )}
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

      <main className="workspace">
        <aside className="pane pane-left dimmable">
          <StatsPane solves={solves} goalMs={goal} />
        </aside>

        <section
          className={`stage${background ? ' has-bg' : ''}`}
          style={
            background
              ? ({
                  '--stage-photo': `url("${background}")`,
                  '--stage-dim': String(settings.backgroundDim),
                } as React.CSSProperties)
              : undefined
          }
        >
          {tab === 'timer' ? (
            <>
              <p className="scramble dimmable">
                {scrambling ? 'Generating scramble…' : scramble}
                <button className="ghost small refresh" onClick={() => nextScramble(session.event)}>
                  ↻
                </button>
              </p>

              {typing ? (
                <form className="typed dimmable" onSubmit={submitTyped}>
                  <input
                    ref={typedInput}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="1234"
                    aria-label="Enter solve time"
                    inputMode="numeric"
                    autoFocus
                  />
                  <button type="submit" disabled={parseTime(typed) === null}>
                    Add
                  </button>
                </form>
              ) : (
                <div className="timer">
                  {settings.hideTimeWhileSolving && state === 'running' ? 'solving' : formatMs(display)}
                </div>
              )}
              <p className="hint dimmable">
                {typing
                  ? parseTime(typed) !== null
                    ? formatMs(parseTime(typed)!)
                    : typed.trim() === ''
                      ? 'Type it as it reads: 1234 → 12.34, 12345 → 1:23.45'
                      : 'Not a time'
                  : state === 'idle'
                    ? 'Hold space to start'
                    : state === 'running'
                      ? ''
                      : 'Release to go'}
              </p>
              <div className="readout dimmable">
                <span>
                  ao5 <strong>{fmt(averageOf(solves, 5))}</strong>
                </span>
                <span>
                  ao12 <strong>{fmt(averageOf(solves, 12))}</strong>
                </span>
                <span>
                  best <strong>{fmtStat(best(solves))}</strong>
                </span>
              </div>
            </>
          ) : (
        <div className="stats-view dimmable">
          <section className="panel">
            <div className="panel-head">
              <h2>Distribution · {session.name}</h2>
              <label className="ctrl">
                Bucket
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
            <PracticeCalendar solves={calendarScope === 'all' ? liveSolves : solves} />
          </section>

          {parityEvent && (
            <section className="panel">
              <div className="panel-head">
                <h2>Cost of parity</h2>
              </div>
              <ParityBreakdown solves={solves} event={session.event} />
            </section>
          )}
        </div>
          )}
        </section>

        <aside className="pane pane-right dimmable">
          <div className="panel-head">
            <h2>Solves</h2>
            {solves.length > 0 && (
              <button className="ghost small" onClick={clearSession}>
                Clear
              </button>
            )}
          </div>
          {solves.length === 0 && <p className="empty">No solves yet</p>}
          <ol className="solves">
            {solves.map((s, i) => (
              <li
                key={s.id}
                className={`${s.id === latest?.id ? 'latest' : ''} ${s.id === pbId ? 'pb' : ''}`}
              >
                <button className="solve-open" onClick={() => setDetailId(s.id)}>
                  <span className="idx">{solves.length - i}.</span>
                  <span className="time">{formatSolve(s)}</span>
                  {s.id === pbId && solves.length > 1 && <span className="tag pb-tag">PB</span>}
                </button>
                {showParityTags &&
                  parityTags(session.event, s.parity).map((t) => (
                    <span key={t.id} className={`tag parity-tag p-${t.id}`} title={t.title}>
                      {t.label}
                    </span>
                  ))}
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
                  <button className="del" onClick={() => deleteSolve(s.id)}>×</button>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </main>

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
          slotsLeft={MAX_SESSIONS - liveSessions.length}
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
              solves: prev.solves.map((s) => (s.id === detail.id ? touch(s, { parity }) : s)),
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
              solves: prev.solves.map((s) => (s.id === pending.id ? touch(s, { parity }) : s)),
            }))
            setPendingParity(null)
            if (typing) requestAnimationFrame(() => typedInput.current?.focus())
          }}
        />
      )}
      {showAuth && (
        <AuthPanel
          state={sync.state}
          email={sync.email}
          error={sync.error}
          lastSyncedAt={sync.lastSyncedAt}
          onSignIn={sync.signIn}
          onSignOut={sync.signOut}
          onSyncNow={sync.syncNow}
          onClose={() => setShowAuth(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

/**
 * For averages, where the two empty cases mean different things:
 * undefined = not enough solves yet, null = the average itself is a DNF.
 */
function fmt(v: number | null | undefined): string {
  return v === undefined ? '—' : formatMs(v)
}

/**
 * For plain statistics, where null means "no data" rather than DNF. Passing
 * those through formatMs would print DNF for an empty session, claiming every
 * solve failed when there are no solves at all.
 */
function fmtStat(v: number | null | undefined): string {
  return v == null ? '—' : formatMs(v)
}
