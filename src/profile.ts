/**
 * The `profiles` table: who you are on the board, and whether you want to be on
 * it. Kept apart from dailyClient.ts, which owns the daily tables.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

/** Mirrors the `profiles_username_format` check constraint in schema.sql. */
const SHAPE = /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/

/** What the user typed, tidied: the ends trimmed, interior runs collapsed. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * An error to show, or null if the name is good. Deliberately duplicates the
 * database constraint rather than trusting it: the constraint is the authority,
 * but a round trip is a poor way to tell someone their name is too short.
 */
export function validateUsername(name: string): string | null {
  if (name.length < 3) return 'Names need at least 3 characters.'
  if (name.length > 20) return 'Names can be at most 20 characters.'
  if (!SHAPE.test(name)) return 'Use letters, numbers, and single spaces only.'
  return null
}

/**
 * 'claimed' — the name is now yours.
 * 'taken'   — 23505, someone holds it (case-insensitively).
 * 'invalid' — 23514: the database refused a name validateUsername accepted,
 *             which means the two have drifted. That is our bug, not the user's.
 * 'retry'   — anything else. Unlike a daily submission, a claim is safe to
 *             repeat, so an unfamiliar failure defaults to letting them try again.
 */
export type ClaimResult = 'claimed' | 'taken' | 'invalid' | 'retry'

export function classifyClaimError(err: { code?: string } | null): ClaimResult {
  if (!err) return 'claimed'
  if (err.code === '23505') return 'taken'
  if (err.code === '23514') return 'invalid'
  return 'retry'
}

export interface Profile {
  username: string
  optedIn: boolean
}

/**
 * Throws on a genuine query error (expired JWT, network blip, RLS misconfiguration).
 * Returns null if not signed in, or if signed in but no profile row exists yet.
 * Returns Profile if a username has been claimed.
 */
export async function fetchProfile(): Promise<Profile | null> {
  if (!supabase) return null
  // getSession, not getUser, and for the same reason sync/engine.ts uses it:
  // getSession reads the cached session locally, while getUser is a network
  // round trip that on a fetch failure resolves to a null user instead of
  // throwing. Offline that would look identical to "signed in with no name
  // yet" -- and that state opens a gate whose only exit is Sign out.
  const { data: auth } = await supabase.auth.getSession()
  const userId = auth.session?.user.id
  if (!userId) return null

  const { data, error } = await supabase
    .from('profiles')
    .select('username, opted_in')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  if (!data?.username) return null
  return { username: data.username, optedIn: data.opted_in ?? false }
}

/**
 * Claims a name, and renames on a row that already exists. `opted_in` is
 * deliberately absent from the payload: on conflict PostgREST updates only the
 * columns given, so a rename preserves the opt-in rather than silently
 * resetting it to the column default.
 */
export async function claimUsername(name: string): Promise<ClaimResult> {
  if (!supabase) return 'retry'
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return 'retry'

  const { error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, username: name }, { onConflict: 'user_id' })

  return classifyClaimError(error)
}

/** True on success. The caller keeps its old state on false. */
export async function setOptIn(value: boolean): Promise<boolean> {
  if (!supabase) return false
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return false

  const { error } = await supabase
    .from('profiles')
    .update({ opted_in: value })
    .eq('user_id', userId)

  return !error
}

/**
 * The outcome of the panel's opt-in toggle, which is more than the write
 * succeeding: opt-in is future-only, so the handler re-checks today's
 * submission state immediately before writing and may refuse.
 *
 * 'saved'   — written, and the profile reloaded.
 * 'locked'  — something is already frozen for today, so the setting cannot
 *             honestly move until tomorrow.
 * 'unknown' — today's state could not be confirmed; refusing is the safe
 *             default, since a flip we cannot justify may misrepresent the board.
 * 'failed'  — the write itself did not land.
 */
export type OptInResult = 'saved' | 'locked' | 'unknown' | 'failed'

/**
 * Whether the claim gate is up: a signed-in user with no name has not finished
 * signing in, so the panel force-opens with no Close button and the timer is
 * held. It is the riskiest condition in the feature -- every input must be
 * genuinely known -- so it lives here as one pure function rather than being
 * spelled out inline in both App and AuthPanel.
 *
 * `failed` is the load that could not tell us anything, and it must NOT gate:
 * stranding someone who already has a username behind a modal whose only exit
 * is Sign out is worse than briefly showing them a retry.
 */
export function shouldClaimUsername({
  email,
  loading,
  failed,
  profile,
}: {
  email: string | null
  loading: boolean
  failed: boolean
  profile: Profile | null
}): boolean {
  return Boolean(email) && !loading && !failed && !profile
}

/**
 * Loads the signed-in user's profile, and reloads it after a write.
 *
 * `fetchProfile` throws on a genuine query error (expired JWT, network blip,
 * RLS misconfiguration) rather than returning null for it — null is reserved
 * for "signed in with no name yet" or "not signed in", which is exactly the
 * state that opens the claim gate. So a thrown error is caught here and
 * surfaced as `failed`, never collapsed into `profile === null`: a network
 * blip must not strand someone who already has a username in a gate whose
 * only way out is Sign out.
 */
export function useProfile(email: string | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // Mirrors `profile` for the reload path, which needs to know whether there
  // is already something good on screen without taking `profile` as a
  // dependency and rebuilding the callback on every load.
  const loaded = useRef<Profile | null>(null)

  const reload = useCallback(async () => {
    try {
      const p = await fetchProfile()
      loaded.current = p
      setProfile(p)
      setFailed(false)
    } catch {
      // A refresh that fails after a successful write must not replace a
      // working account panel with an error. `failed` means "there is nothing
      // to show", not "the last request failed".
      if (!loaded.current) setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!email) {
      loaded.current = null
      setProfile(null)
      setLoading(false)
      setFailed(false)
      return
    }
    let live = true
    // A different account's profile is not this one's: drop it before the
    // fetch, or a failure here would leave the previous user's name on screen.
    loaded.current = null
    setProfile(null)
    setLoading(true)
    fetchProfile()
      .then((p) => {
        if (!live) return
        loaded.current = p
        setProfile(p)
        setFailed(false)
        setLoading(false)
      })
      .catch(() => {
        if (!live) return
        setFailed(true)
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [email])

  return { profile, loading, failed, reload }
}
