/**
 * The `profiles` table: who you are on the board, and whether you want to be on
 * it. Kept apart from dailyClient.ts, which owns the daily tables.
 */

import { useCallback, useEffect, useState } from 'react'
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
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
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

  const reload = useCallback(async () => {
    try {
      const p = await fetchProfile()
      setProfile(p)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!email) {
      setProfile(null)
      setLoading(false)
      setFailed(false)
      return
    }
    let live = true
    setLoading(true)
    fetchProfile()
      .then((p) => {
        if (!live) return
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
