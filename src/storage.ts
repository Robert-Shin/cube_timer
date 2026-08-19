import { EVENTS, MAX_SESSIONS, eventName, type EventId, type Session, type Solve } from './types'

const SOLVES = 'cube-timer.solves.v2'
const SESSIONS = 'cube-timer.sessions.v1'
const ACTIVE = 'cube-timer.active-session.v1'
/** Pre-session format: solves carried an `event` and there were no sessions. */
const LEGACY_SOLVES = 'cube-timer.solves.v1'

export interface Store {
  sessions: Session[]
  solves: Solve[]
  activeId: string
}

function newSession(name: string, event: EventId): Session {
  return { id: crypto.randomUUID(), name, event, createdAt: Date.now() }
}

/**
 * Loads sessions and solves, migrating the pre-session format on first run:
 * each event that had solves becomes a session named after it.
 */
export function loadStore(): Store {
  const sessions = read<Session[]>(SESSIONS)
  const solves = read<Solve[]>(SOLVES)

  if (sessions && sessions.length > 0) {
    const activeId = localStorage.getItem(ACTIVE) ?? ''
    return {
      sessions,
      solves: solves ?? [],
      // A stored id can point at a deleted session; fall back to the first.
      activeId: sessions.some((s) => s.id === activeId) ? activeId : sessions[0].id,
    }
  }

  const legacy = read<(Solve & { event?: EventId })[]>(LEGACY_SOLVES)
  if (legacy && legacy.length > 0) {
    const migrated = migrateLegacy(legacy)
    save(migrated)
    return migrated
  }

  const first = newSession('3x3', '333')
  return { sessions: [first], solves: [], activeId: first.id }
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
    const session = newSession(eventName(event), event)
    sessions.push(session)
    for (const s of found) solves.push({ ...s, sessionId: session.id })
  }

  if (sessions.length === 0) sessions.push(newSession('3x3', '333'))
  return { sessions, solves, activeId: sessions[0].id }
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
    localStorage.setItem(ACTIVE, store.activeId)
    return true
  } catch {
    return false
  }
}

export function createSession(store: Store, name: string, event: EventId): Store {
  if (store.sessions.length >= MAX_SESSIONS) return store
  const session = newSession(name.trim() || eventName(event), event)
  return { ...store, sessions: [...store.sessions, session], activeId: session.id }
}

/** Deleting a session deletes its solves -- they have nowhere else to live. */
export function deleteSession(store: Store, id: string): Store {
  if (store.sessions.length <= 1) return store
  const sessions = store.sessions.filter((s) => s.id !== id)
  return {
    sessions,
    solves: store.solves.filter((s) => s.sessionId !== id),
    activeId: store.activeId === id ? sessions[0].id : store.activeId,
  }
}
