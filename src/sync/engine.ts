import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, syncConfigured } from '../supabase'
import type { Store } from '../storage'
import { mergeRows, dirtyRows, newestFirst } from './merge'
import { rowToSession, rowToSolve, sessionToRow, solveToRow } from './rows'

export type SyncState = 'disabled' | 'signed-out' | 'idle' | 'syncing' | 'error'

/** Postgres upserts are cheap but not free; batch rather than one call per row. */
const BATCH = 500
/** Quiet period after a change before pushing, so a burst of solves is one call. */
const DEBOUNCE_MS = 2500

interface Cursors {
  pushedAt: number
  pulledAt: number
}

const cursorKey = (userId: string) => `cube-timer.sync.${userId}`

function readCursors(userId: string): Cursors {
  try {
    const raw = localStorage.getItem(cursorKey(userId))
    return raw ? (JSON.parse(raw) as Cursors) : { pushedAt: 0, pulledAt: 0 }
  } catch {
    return { pushedAt: 0, pulledAt: 0 }
  }
}

function writeCursors(userId: string, c: Cursors): void {
  try {
    localStorage.setItem(cursorKey(userId), JSON.stringify(c))
  } catch {
    // Losing the cursor only costs a redundant full push next time.
  }
}

/**
 * Reconciles the local store with Supabase in the background.
 *
 * Local is always authoritative for reads, so a failed sync is a non-event:
 * nothing is lost and the attempt is retried. Recording a solve never waits
 * on the network.
 */
export function useSync(store: Store, applyRemote: (next: Store) => void) {
  const [state, setState] = useState<SyncState>(syncConfigured ? 'signed-out' : 'disabled')
  const [email, setEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  // The store changes on every keystroke-ish event; a ref keeps the sync
  // callback stable so it is not torn down and rebuilt constantly.
  const storeRef = useRef(store)
  storeRef.current = store
  const applyRef = useRef(applyRemote)
  applyRef.current = applyRemote
  const userId = useRef<string | null>(null)
  const running = useRef(false)

  const sync = useCallback(async () => {
    if (!supabase || !userId.current || running.current) return
    running.current = true
    setState('syncing')
    setError(null)

    const uid = userId.current
    try {
      const cursors = readCursors(uid)
      const local = storeRef.current

      // --- push local changes -------------------------------------------
      const sessions = dirtyRows(local.sessions, cursors.pushedAt)
      const solves = dirtyRows(local.solves, cursors.pushedAt)

      // Sessions first: solves reference them by foreign key.
      for (let i = 0; i < sessions.length; i += BATCH) {
        const chunk = sessions.slice(i, i + BATCH).map((s) => sessionToRow(s, uid))
        const { error: e } = await supabase.from('sessions').upsert(chunk)
        if (e) throw e
      }
      for (let i = 0; i < solves.length; i += BATCH) {
        const chunk = solves.slice(i, i + BATCH).map((s) => solveToRow(s, uid))
        const { error: e } = await supabase.from('solves').upsert(chunk)
        if (e) throw e
      }

      const pushedAt = Math.max(
        cursors.pushedAt,
        ...sessions.map((s) => s.updatedAt),
        ...solves.map((s) => s.updatedAt),
        0,
      )

      // --- pull remote changes ------------------------------------------
      const since = new Date(cursors.pulledAt).toISOString()
      const [remoteSessions, remoteSolves] = await Promise.all([
        supabase.from('sessions').select('*').gt('updated_at', since),
        supabase.from('solves').select('*').gt('updated_at', since),
      ])
      if (remoteSessions.error) throw remoteSessions.error
      if (remoteSolves.error) throw remoteSolves.error

      const pulledSessions = (remoteSessions.data ?? []).map(rowToSession)
      const pulledSolves = (remoteSolves.data ?? []).map(rowToSolve)

      if (pulledSessions.length || pulledSolves.length) {
        const current = storeRef.current
        const merged = {
          sessions: mergeRows(current.sessions, pulledSessions),
          solves: newestFirst(mergeRows(current.solves, pulledSolves)),
          activeId: current.activeId,
        }
        // A pull can arrive for a session this device has never seen; make
        // sure the active id still points at something live.
        const live = merged.sessions.filter((s) => !s.deleted)
        if (live.length > 0 && !live.some((s) => s.id === merged.activeId)) {
          merged.activeId = live[0].id
        }
        applyRef.current(merged)
      }

      const pulledAt = Math.max(
        cursors.pulledAt,
        ...pulledSessions.map((s) => s.updatedAt),
        ...pulledSolves.map((s) => s.updatedAt),
        0,
      )

      writeCursors(uid, { pushedAt, pulledAt })
      setLastSyncedAt(Date.now())
      setState('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sync failed')
      setState('error')
    } finally {
      running.current = false
    }
  }, [])

  // --- auth session tracking ------------------------------------------
  useEffect(() => {
    if (!supabase) return
    const adopt = (session: Session | null) => {
      userId.current = session?.user.id ?? null
      setEmail(session?.user.email ?? null)
      if (session) {
        setState('idle')
        void sync()
      } else {
        setState('signed-out')
      }
    }
    void supabase.auth.getSession().then(({ data }) => adopt(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => adopt(session))
    return () => data.subscription.unsubscribe()
  }, [sync])

  // --- triggers --------------------------------------------------------
  useEffect(() => {
    if (!syncConfigured) return
    const onFocus = () => void sync()
    const onOnline = () => void sync()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
    }
  }, [sync])

  // Debounced push after local changes settle.
  useEffect(() => {
    if (!userId.current) return
    const t = setTimeout(() => void sync(), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [store, sync])

  const signIn = useCallback(async (address: string) => {
    if (!supabase) return { error: 'sync is not configured' }
    const { error: e } = await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: window.location.origin },
    })
    return { error: e?.message ?? null }
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    // Local data stays on the device; it just stops syncing.
    userId.current = null
    setState('signed-out')
  }, [])

  return { state, email, error, lastSyncedAt, signIn, signOut, syncNow: sync }
}
