import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  effectiveMs,
  eventName,
  EVENTS,
  MAX_SESSIONS,
  type Penalty,
  type Session,
  type Solve,
} from './types'
import {
  disciplineEvents,
  disciplineKey,
  disciplineLabel,
  eventDiscipline,
  parseDiscipline,
  soleEvent,
  type Discipline,
} from './discipline'
import { formatMs, formatSolve } from './format'
import { averageOf, best } from './stats'
import { newScrambles } from './scramble'
import {
  activeSessionOf,
  commitDraft,
  createRelaySession,
  defaultSessionName,
  loadStore,
  relayKeys,
  save,
  type Store,
} from './storage'
import { useTimer } from './useTimer'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings'
import { parseTime } from './parseTime'
import { clearBackground, loadBackground, prepareImage, saveBackground } from './background'
import { touch, tombstone } from './sync/stamp'
import { visible } from './sync/merge'
import { useSync } from './sync/engine'
import { AuthPanel } from './AuthPanel'
import { FriendsPanel } from './FriendsPanel'
import { FriendProfile } from './FriendProfile'
import { claimUsername, setOptIn, shouldClaimUsername, useProfile } from './profile'
import { hasSubmittedToday } from './dailyClient'
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
import { DailyChallenge } from './DailyChallenge'
import { RelayBuilder } from './RelayBuilder'

export default function App() {
  const [store, setStore] = useState<Store>(() => loadStore())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [scrambles, setScrambles] = useState<string[]>([])
  const [scrambling, setScrambling] = useState(true)
  const [typed, setTyped] = useState('')
  const [tab, setTab] = useState<'timer' | 'stats' | 'daily'>('timer')
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
  const [showFriends, setShowFriends] = useState(false)
  const [buildingRelay, setBuildingRelay] = useState(false)
  const [openFriend, setOpenFriend] = useState<{ id: string; name: string } | null>(null)
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

  const discipline = store.activeDiscipline

  // A discipline you have never timed has no session yet -- picking one must
  // not write an empty log that then syncs to every other device. So App
  // holds a DRAFT: a real Session with a real id, memoised on the discipline
  // key so it is stable across renders, committed to the store together with
  // the first solve. Keeping it non-null here is deliberate; every read of
  // session.id/.name/.goalMs below would otherwise need a null branch.
  //
  // Keyed on store.sessions as well as the discipline, not the discipline
  // alone: after the last session of a discipline is deleted, a draft held
  // over from before would still carry the id that session was TOMBSTONED
  // under. Committing it would write a live row whose id already has a
  // tombstone, and the tombstone -- being newer -- would win the next
  // reconciliation and silently delete the solve. A fresh id per session
  // change costs one uuid and closes that.
  const draft = useMemo<Session>(() => {
    const at = Date.now()
    return {
      id: crypto.randomUUID(),
      name: defaultSessionName(discipline, at),
      discipline,
      createdAt: at,
      updatedAt: at,
    }
  }, [discipline, store.sessions])

  const stored = activeSessionOf(store, discipline)
  const session = stored ?? draft
  const isDraft = stored === undefined

  // The live sessions of this discipline. The switcher only renders when
  // there is more than one -- the second axis appears exactly when it is
  // being used, and stays out of the way otherwise.
  const siblings = useMemo(
    () => liveSessions.filter((s) => s.discipline === discipline),
    [liveSessions, discipline],
  )

  const parsedDiscipline = useMemo(
    () => parseDiscipline(discipline) ?? eventDiscipline('333'),
    [discipline],
  )
  const legs = disciplineEvents(parsedDiscipline)

  // Every relay in the store, offered in the discipline picker. Recomputed
  // off the whole store (not just liveSessions) since relayKeys already
  // skips tombstones itself.
  const relays = useMemo(() => relayKeys(store), [store])

  // Deleting the last session of a relay removes it from `relays` above (it
  // has no live session left to be found by) without touching
  // activeDiscipline, which still names it. Without this, the picker below
  // would have no <option> matching `discipline` and render blank -- with
  // the stage still generating scrambles and timing into a relay draft the
  // header no longer shows or lets you navigate away from cleanly. Render it
  // as its own option so the select always has a match; it drops out of the
  // list on its own once a solve is recorded and it rejoins `relays`.
  const orphanRelay =
    discipline.startsWith('relay:') && !relays.includes(discipline)
      ? parseDiscipline(discipline)
      : null

  // The event a relay falls back to when it has no single sole event. Every
  // reader of `event` below that would misfire on that fallback (parity, the
  // daily challenge) guards itself with `legs.length === 1` rather than
  // trusting this value alone.
  const event = soleEvent(parsedDiscipline) ?? '333'

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
  const {
    profile,
    loading: profileLoading,
    failed: profileFailed,
    reload: reloadProfile,
  } = useProfile(sync.email)

  // Same predicate AuthPanel gates on, so the panel that opens here is
  // guaranteed to be the one with no Close button — and vice versa.
  const gateActive = shouldClaimUsername({
    email: sync.email,
    loading: profileLoading,
    failed: profileFailed,
    profile,
  })
  useEffect(() => {
    if (gateActive) {
      setShowAuth(true)
      // Otherwise a friends panel left open before the gate reappeared (e.g.
      // switching accounts) would silently pop back up the moment the gate
      // clears, with no button press behind it.
      setShowFriends(false)
    }
  }, [gateActive])

  // Whether opting in/out would actually change today's board. null means
  // "not yet known" (still loading, or the check failed) and the toggle
  // stays locked until it resolves to true or false -- defaulting to enabled
  // would let a flip land before we know whether it is safe. A network call,
  // so fetched only when the panel is open with a claimed profile, not on
  // every render.
  const [submittedToday, setSubmittedToday] = useState<boolean | null>(null)
  // Keyed on whether there is a profile at all, never on the object: every
  // successful rename or toggle produces a fresh object, and re-running this
  // would blank the label back to "could not be confirmed" and grey the switch
  // for a round trip immediately after the write that just worked.
  const hasProfile = profile !== null
  useEffect(() => {
    if (!showAuth || !hasProfile) return
    let live = true
    setSubmittedToday(null)
    hasSubmittedToday().then((v) => {
      if (live) setSubmittedToday(v)
    })
    return () => {
      live = false
    }
  }, [showAuth, hasProfile])

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

  // Bumped on every call and captured in the closure below, so a call that
  // switched discipline mid-flight (relay -> 3x3 while the relay's four
  // random-state solvers are still loading) can tell its own result is
  // stale and drop it -- otherwise the slow relay promise resolving last
  // would overwrite the single scramble already showing, and `record` would
  // join all four legs into the recorded solve's scramble field.
  const scrambleRequest = useRef(0)
  const nextScramble = useCallback((d: Discipline) => {
    const requestId = ++scrambleRequest.current
    setScrambling(true)
    newScrambles(d)
      .then((result) => {
        if (requestId !== scrambleRequest.current) return
        setScrambles(result)
      })
      .catch(() => {
        if (requestId !== scrambleRequest.current) return
        setScrambles(['scramble failed to generate'])
      })
      .finally(() => {
        if (requestId === scrambleRequest.current) setScrambling(false)
      })
  }, [])

  useEffect(() => nextScramble(parsedDiscipline), [parsedDiscipline, nextScramble])

  // Splits are collected only when the setting is on AND the discipline is
  // actually a relay -- a single-event solve never grows a boundaries array.
  const trackingSplits = settings.trackSplits && legs.length > 1
  // N-1 boundaries for N legs; the final stop is the solve's own timeMs.
  const boundaries = trackingSplits ? legs.length - 1 : 0

  /** Single path for recording a solve, whether timed or typed. */
  const record = useCallback(
    // No default for `splits`: a default of [] would make every caller that
    // omits it (typed entry; useTimer stopping a solve begun before
    // trackSplits was toggled on) write "recorded, no boundaries" for a
    // solve that was never split, indistinguishable from a real 1-boundary-
    // short relay. Store it only when it was actually collected.
    (timeMs: number, splits?: number[]) => {
      const id = crypto.randomUUID()
      // legs.length === 1 is the guard, NOT hasParity(event): `event` is the
      // '333' fallback for a relay, so hasParity would say true.
      const asking = settings.trackParity && legs.length === 1 && hasParity(event)
      const solve: Solve = {
        id,
        sessionId: session.id,
        // Legs newline-joined; their order is recoverable from the session's
        // discipline, so this needs no extra column.
        scramble: scrambles.join('\n'),
        timeMs,
        penalty: 'none' as Penalty,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // Events without parity record [] -- definitively none, not
        // unknown -- so they never show up as untracked.
        ...(asking ? {} : { parity: [] as ParityId[] }),
        // undefined, not [], when untracked -- the distinction the column
        // and legDurations both depend on. `splits` is undefined only from
        // typed entry, which never passes it -- useTimer's stop() always
        // hands back an array. The length check catches the other stale
        // case: useTimer snapshots `boundaries` at start(), so a solve begun
        // before trackSplits flipped on stops with a splits array sized to
        // the OLD boundaries (0), while `boundaries` here has already moved
        // to the new value by the time this closure runs at stop. Without
        // the length check that mismatch would still store `[]` against a
        // solve nothing was ever collected for.
        ...(trackingSplits && splits !== undefined && splits.length === boundaries
          ? { splits }
          : {}),
      }
      // A draft session becomes real here, written in the same update as the
      // solve that justifies it. The solve already carries the draft's id, so
      // the two cannot disagree.
      setStore((prev) =>
        isDraft
          ? commitDraft(prev, session, solve)
          : { ...prev, solves: [solve, ...prev.solves] },
      )
      if (asking) setPendingParity(id)
      nextScramble(parsedDiscipline)
    },
    [
      session,
      isDraft,
      event,
      scrambles,
      trackingSplits,
      boundaries,
      parsedDiscipline,
      nextScramble,
      settings.trackParity,
    ],
  )

  const typing = settings.inputMode === 'typing'
  // Modals own the keyboard while open, or space would fire a phantom solve.
  const modalOpen =
    showSessions ||
    importing ||
    detailId !== null ||
    showSettings ||
    showAuth ||
    showFriends ||
    buildingRelay ||
    pendingParity !== null
  const { state, display, leg } = useTimer(
    record,
    tab === 'timer' && !typing && !modalOpen,
    boundaries,
  )

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
    setStore((prev) => {
      const first = sessions[0]
      return {
        ...prev,
        sessions: [...prev.sessions, ...sessions],
        // Imported solves carry their original timestamps, so re-sort the
        // whole list newest-first rather than just prepending them.
        solves: [...imported, ...prev.solves].sort((a, b) => b.createdAt - a.createdAt),
        // Land on the first imported session, and remember it as that
        // discipline's active log so switching away and back returns to it.
        activeDiscipline: first ? first.discipline : prev.activeDiscipline,
        activeByDiscipline: first
          ? { ...prev.activeByDiscipline, [first.discipline]: first.id }
          : prev.activeByDiscipline,
      }
    })
    setImporting(false)
    flash(`Imported ${imported.length} solves into ${sessions.length} sessions`)
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  // An unset goal falls back to a suggestion from the data, so the rate is
  // useful before anyone opens the session manager.
  const goal = session.goalMs ?? suggestGoal(solves)
  const parityEvent = hasParity(event)
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
            {/* Same signed-in-and-past-the-gate predicate that decides whether
                FriendsPanel/FriendProfile may render below -- see the comment
                there. Reusing it here, rather than inventing a second "may
                use friends" check, keeps the button and the gate from ever
                disagreeing. */}
            {sync.email && !gateActive && (
              <button className="ghost" onClick={() => setShowFriends(true)}>
                Friends
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
            {/* The primary axis: what you are practising. Sessions nest
                inside it. */}
            <select
              value={discipline}
              onChange={(e) => {
                // The sentinel opens the builder; it must never be written
                // into activeDiscipline. Once the builder closes, `discipline`
                // (still the last real value) is what this select renders
                // again -- it never gets a chance to display the sentinel's
                // label.
                if (e.target.value === '__new_relay__') {
                  setBuildingRelay(true)
                  return
                }
                setStore((prev) => ({ ...prev, activeDiscipline: e.target.value }))
              }}
              aria-label="Discipline"
            >
              {EVENTS.map((ev) => (
                <option key={ev.id} value={disciplineKey(eventDiscipline(ev.id))}>
                  {ev.name}
                </option>
              ))}
              {relays.map((key) => {
                const d = parseDiscipline(key)
                return (
                  <option key={key} value={key}>
                    {d ? disciplineLabel(d) : key}
                  </option>
                )
              })}
              {orphanRelay && (
                <option value={discipline}>{disciplineLabel(orphanRelay)}</option>
              )}
              <option value="__new_relay__">New relay…</option>
            </select>
            {/* Only when this discipline actually has more than one log --
                otherwise the control is dead weight on every screen. */}
            {siblings.length > 1 && (
              <select
                value={session.id}
                onChange={(e) =>
                  setStore((prev) => ({
                    ...prev,
                    activeByDiscipline: {
                      ...prev.activeByDiscipline,
                      [discipline]: e.target.value,
                    },
                  }))
                }
                aria-label="Session"
              >
                {siblings.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({counts[s.id] ?? 0})
                  </option>
                ))}
              </select>
            )}
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
            {syncConfigured && (
              <button className={tab === 'daily' ? 'active' : ''} onClick={() => setTab('daily')}>
                Daily
              </button>
            )}
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
              <strong>Split tracking</strong>
              <p>Tap between puzzles in a relay to record per-leg splits.</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.trackSplits}
                onChange={(e) => update('trackSplits', e.target.checked)}
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
              <div className="scramble dimmable">
                {scrambling ? (
                  <p className="scramble-leg">
                    Generating scramble…
                    <button
                      className="ghost small refresh"
                      onClick={() => nextScramble(parsedDiscipline)}
                    >
                      ↻
                    </button>
                  </p>
                ) : (
                  scrambles.map((text, i) => (
                    <p key={i} className="scramble-leg">
                      {legs.length > 1 && <span className="leg-label">{eventName(legs[i])}</span>}
                      {text}
                      {/* Kept inline in the last leg's <p>, not a sibling of the
                          <p>s -- a sibling forms its own line box under a block
                          <p>, dropping onto its own centred row below the
                          scramble instead of trailing the text as it did before
                          disciplines landed (and still does here, for the
                          single-leg case that is all the UI can reach today). */}
                      {i === scrambles.length - 1 && (
                        <button
                          className="ghost small refresh"
                          onClick={() => nextScramble(parsedDiscipline)}
                        >
                          ↻
                        </button>
                      )}
                    </p>
                  ))
                )}
              </div>

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
              {trackingSplits && (
                // Always mounted while tracking splits, not conditionally
                // rendered on `state === 'running'`: that would mount and
                // unmount the line every start/stop, shifting the centred
                // stage each time. `invisible` keeps its height reserved
                // instead.
                <p className={`note leg-indicator${state === 'running' ? '' : ' invisible'}`}>
                  Leg {leg + 1} of {legs.length}
                </p>
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
          ) : tab === 'stats' ? (
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
            <PracticeCalendar solves={calendarScope === 'all' ? liveSolves : solves} />
          </section>

          {legs.length === 1 && parityEvent && (
            <section className="panel">
              <div className="panel-head">
                <h2>Cost of parity</h2>
              </div>
              <ParityBreakdown solves={solves} event={event} />
            </section>
          )}
        </div>
          ) : legs.length > 1 ? (
            <p className="empty">
              There is no daily challenge for a relay. Pick a single puzzle to take part.
            </p>
          ) : (
            <DailyChallenge
              // Remounted per event: reveal/result live in DailyChallenge's
              // state, and the session dropdown stays live on this tab. Without
              // a key, switching session mid-attempt would leave the previous
              // event's scramble on screen with an armed timer, writing that
              // scramble into the new session and submitting against an event
              // that was never revealed.
              key={event}
              event={event}
              paused={modalOpen}
              onRecord={(timeMs, scrambleUsed) => {
                // An ordinary local solve: no new column on `solves`, because
                // the attempt row server-side is the authoritative record of
                // the challenge.
                setStore((prev) => ({
                  ...prev,
                  solves: [
                    {
                      id: crypto.randomUUID(),
                      sessionId: session.id,
                      scramble: scrambleUsed,
                      timeMs,
                      penalty: 'none' as Penalty,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      // [] means "measured as none", so it must not be claimed
                      // when parity is being tracked but was never asked --
                      // that would bias the no-parity mean. Same rule as the
                      // ordinary record() path.
                      ...(settings.trackParity && hasParity(event)
                        ? {}
                        : { parity: [] as ParityId[] }),
                    },
                    ...prev.solves,
                  ],
                }))
              }}
            />
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
                  parityTags(event, s.parity).map((t) => (
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
          discipline={discipline}
          counts={counts}
          onChange={setStore}
          onClose={() => setShowSessions(false)}
        />
      )}
      {buildingRelay && (
        <RelayBuilder
          slotsLeft={MAX_SESSIONS - liveSessions.length}
          onCreate={(events) => {
            setStore((prev) => createRelaySession(prev, events))
            setBuildingRelay(false)
          }}
          onClose={() => setBuildingRelay(false)}
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
          event={event}
          // `detail` is looked up from `solves`, which is already filtered to
          // the active session -- so the active discipline is correct here.
          // If that filter is ever widened, this needs to look up the
          // solve's own session's discipline instead.
          discipline={discipline}
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
      {pending && legs.length === 1 && (
        <ParityPrompt
          event={event}
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
          profile={profile}
          profileLoading={profileLoading}
          profileFailed={profileFailed}
          onSignIn={sync.signIn}
          onSignOut={sync.signOut}
          onSyncNow={sync.syncNow}
          onClose={() => setShowAuth(false)}
          onClaim={async (name) => {
            const result = await claimUsername(name)
            if (result === 'claimed') await reloadProfile()
            return result
          }}
          submittedToday={submittedToday}
          onReload={reloadProfile}
          onSetOptIn={async (value) => {
            // The lock is re-checked here, not just when the panel opened: a
            // submission queued offline can flush on a sync tick while the
            // panel sits open, freezing `published` from the opt-in as it was.
            // A flip after that would leave the name on the ranked board while
            // the UI claimed otherwise. Refuse on anything but a definite no.
            const settled = await hasSubmittedToday()
            setSubmittedToday(settled)
            if (settled !== false) return settled === null ? 'unknown' : 'locked'

            const ok = await setOptIn(value)
            if (ok) await reloadProfile()
            return ok ? 'saved' : 'failed'
          }}
        />
      )}
      {/* Same signed-in predicate as AuthPanel (see the comment at line ~89),
          plus a check that the claim gate isn't showing: friendships have a
          foreign key to profiles(user_id), so a user with no claimed
          username can neither befriend nor be found by anyone, and the gate
          is deliberately inescapable while active. Also gated on showFriends,
          the same way AuthPanel is gated on showAuth -- a way in (the header
          button above) and a way out (each panel's Close/Back). */}
      {showFriends &&
        sync.email &&
        !gateActive &&
        (openFriend ? (
          <FriendProfile
            userId={openFriend.id}
            username={openFriend.name}
            onClose={() => setOpenFriend(null)}
          />
        ) : (
          <FriendsPanel
            onOpen={(id, name) => setOpenFriend({ id, name })}
            onClose={() => {
              setShowFriends(false)
              setOpenFriend(null)
            }}
          />
        ))}
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
