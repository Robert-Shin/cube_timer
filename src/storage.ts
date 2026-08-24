import { EVENTS, MAX_SESSIONS, eventName, type EventId, type Session, type Solve, type Synced } from './types'
import { disciplineKey, disciplineLabel, eventDiscipline, parseDiscipline } from './discipline'
import { now, tombstone } from './sync/stamp'
import { newestFirst } from './sync/merge'

const SOLVES = 'cube-timer.solves.v2'
const SESSIONS = 'cube-timer.sessions.v1'
/** Pre-discipline format: a single active session id, with no notion of
 *  which discipline it belonged to. Read once, to migrate. */
const LEGACY_ACTIVE = 'cube-timer.active-session.v1'
const ACTIVE_DISCIPLINE = 'cube-timer.active-discipline.v1'
const ACTIVE_BY_DISCIPLINE = 'cube-timer.active-by-discipline.v1'
/** Pre-session format: solves carried an `event` and there were no sessions. */
const LEGACY_SOLVES = 'cube-timer.solves.v1'

export interface Store {
  sessions: Session[]
  solves: Solve[]
  /** Discipline key currently being practised -- the app's primary axis. */
  activeDiscipline: string
  /**
   * Discipline key -> the session last used for it, so switching to 4x4 and
   * back restores the 4x4 log you were in rather than resetting to the first.
   * A discipline with no entry (or an entry naming a session that is gone)
   * gets a draft session; see App.
   *
   * Device-local, like the pointer it replaces: sync/engine.ts carries both
   * across a merge but never pushes them.
   */
  activeByDiscipline: Record<string, string>
}

function newSession(name: string, discipline: string): Session {
  const at = now()
  return { id: crypto.randomUUID(), name, discipline, createdAt: at, updatedAt: at }
}

/**
 * The default name for a new session: the discipline plus the day it was
 * started, e.g. '3x3 - Aug 24'. Auto-named rather than demanded up front --
 * having to invent a name before timing is half of what made creating a
 * session feel like a chore.
 */
export function defaultSessionName(key: string, at = Date.now()): string {
  const d = parseDiscipline(key)
  const label = d ? disciplineLabel(d) : key
  const when = new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${label} - ${when}`
}

/** The live sessions of one discipline, oldest first. */
export function sessionsOf(store: Store, key: string): Session[] {
  return store.sessions.filter((s) => !s.deleted && s.discipline === key)
}

/**
 * The session to time into for a discipline, or undefined when it has none
 * yet -- the caller supplies a draft. A remembered id that no longer names a
 * live session of this discipline falls back rather than dangling.
 */
export function activeSessionOf(store: Store, key: string): Session | undefined {
  const live = sessionsOf(store, key)
  const remembered = store.activeByDiscipline[key]
  return live.find((s) => s.id === remembered) ?? live[0]
}

/**
 * Fills in sync fields on rows stored before sync existed. Their `createdAt`
 * becomes their `updatedAt`, which is truthful -- creation was the last time
 * they changed -- and keeps them older than anything edited since.
 */
function normalize<T extends Synced & { createdAt: number }>(rows: T[]): T[] {
  return rows.map((r) => (r.updatedAt === undefined ? { ...r, updatedAt: r.createdAt } : r))
}

/**
 * Loads sessions and solves, migrating the pre-session format on first run:
 * each event that had solves becomes a session named after it.
 */
export function loadStore(): Store {
  const sessions = read<Session[]>(SESSIONS)
  const solves = read<Solve[]>(SOLVES)

  if (sessions && sessions.length > 0) {
    const live = normalize(sessions).map(withDiscipline)
    return {
      sessions: live,
      // Sorted on the way in, not trusted: a store written by a version that
      // merged a sync pull without re-sorting is still on disk, and would
      // otherwise stay reversed forever.
      solves: newestFirst(normalize(solves ?? [])),
      ...loadActive(live),
    }
  }

  const legacy = read<(Solve & { event?: EventId })[]>(LEGACY_SOLVES)
  if (legacy && legacy.length > 0) {
    const migrated = migrateLegacy(legacy)
    save(migrated)
    return migrated
  }

  // A fresh install starts with no session at all: the first solve commits a
  // draft. Creating one up front would put an empty log on a brand-new device
  // and sync it to every other one.
  return { sessions: [], solves: [], activeDiscipline: '333', activeByDiscipline: {} }
}

/**
 * Sessions written before disciplines existed carry `event`. The value is
 * already a valid single-event discipline key, so this only moves the field.
 */
function withDiscipline(s: Session & { event?: string }): Session {
  if (s.discipline) return s
  const { event, ...rest } = s
  return { ...rest, discipline: event ?? '333' }
}

/**
 * Rebuilds the discipline pointers, migrating the single pre-discipline
 * `activeId` if that is all this device has: the session it names tells us
 * both which discipline was active and which of its logs to restore.
 */
function loadActive(sessions: Session[]): Pick<Store, 'activeDiscipline' | 'activeByDiscipline'> {
  const live = sessions.filter((s) => !s.deleted)
  const byDiscipline = read<Record<string, string>>(ACTIVE_BY_DISCIPLINE)
  const stored = localStorage.getItem(ACTIVE_DISCIPLINE)

  if (byDiscipline && stored) {
    return { activeDiscipline: stored, activeByDiscipline: byDiscipline }
  }

  const legacy = live.find((s) => s.id === (localStorage.getItem(LEGACY_ACTIVE) ?? ''))
  const fallback = legacy ?? live[0]
  const key = fallback?.discipline ?? '333'
  return {
    activeDiscipline: key,
    activeByDiscipline: fallback ? { [key]: fallback.id } : {},
  }
}

function migrateLegacy(legacy: (Solve & { event?: EventId })[]): Store {
  const byEvent = new Map<EventId, Solve[]>()
  for (const s of legacy) {
    const event = (s.event ?? '333') as EventId
    if (!byEvent.has(event)) byEvent.set(event, [])
    byEvent.get(event)!.push(s)
  }

  const sessions: Session[] = []
  const solves: Solve[] = []
  // Keep the canonical event order rather than insertion order.
  for (const { id: event } of EVENTS) {
    const found = byEvent.get(event)
    if (!found) continue
    const session = newSession(eventName(event), disciplineKey(eventDiscipline(event)))
    sessions.push(session)
    for (const s of found) {
      solves.push({ ...s, sessionId: session.id, updatedAt: s.createdAt })
    }
  }

  if (sessions.length === 0) sessions.push(newSession('3x3', '333'))
  const key = sessions[0].discipline
  return { sessions, solves, activeDiscipline: key, activeByDiscipline: { [key]: sessions[0].id } }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/**
 * Returns false if the write failed -- almost always the ~5MB quota, which a
 * large csTimer import can reach. The caller must surface that: silently
 * dropping solves the user thinks are saved is the worst outcome here.
 */
export function save(store: Store): boolean {
  try {
    localStorage.setItem(SESSIONS, JSON.stringify(store.sessions))
    localStorage.setItem(SOLVES, JSON.stringify(store.solves))
    localStorage.setItem(ACTIVE_DISCIPLINE, store.activeDiscipline)
    localStorage.setItem(ACTIVE_BY_DISCIPLINE, JSON.stringify(store.activeByDiscipline))
    return true
  } catch {
    return false
  }
}

export function createSession(store: Store, name: string, key: string): Store {
  if (store.sessions.filter((s) => !s.deleted).length >= MAX_SESSIONS) return store
  const session = newSession(name.trim() || defaultSessionName(key), key)
  return {
    ...store,
    sessions: [...store.sessions, session],
    activeDiscipline: key,
    activeByDiscipline: { ...store.activeByDiscipline, [key]: session.id },
  }
}

/**
 * Commits a draft session and its first solve in one write. Drafts exist so
 * that merely looking at a discipline does not leave an empty log behind on
 * every device; the session becomes real the moment it holds a solve.
 */
export function commitDraft(store: Store, draft: Session, solve: Solve): Store {
  return {
    ...store,
    sessions: [...store.sessions, draft],
    solves: [solve, ...store.solves],
    activeDiscipline: draft.discipline,
    activeByDiscipline: { ...store.activeByDiscipline, [draft.discipline]: draft.id },
  }
}

/**
 * Deleting a session tombstones it and its solves -- they have nowhere else
 * to live. Tombstones rather than removal, so the delete propagates instead
 * of being undone by a device that still holds the rows.
 */
export function deleteSession(store: Store, id: string): Store {
  const gone = store.sessions.find((s) => s.id === id)
  if (!gone || gone.deleted) return store
  const sessions = store.sessions.map((s) => (s.id === id ? tombstone(s) : s))

  // Deleting the last log of a discipline is allowed now: a draft takes over,
  // so there is always something to time into and no "the last session cannot
  // be deleted" rule to explain.
  const next = { ...store.activeByDiscipline }
  if (next[gone.discipline] === id) {
    const replacement = sessions.find(
      (s) => !s.deleted && s.discipline === gone.discipline,
    )
    if (replacement) next[gone.discipline] = replacement.id
    else delete next[gone.discipline]
  }

  return {
    ...store,
    sessions,
    solves: store.solves.map((s) => (s.sessionId === id ? tombstone(s) : s)),
    activeByDiscipline: next,
  }
}
