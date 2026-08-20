import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * Null when the project is not configured, which is a supported state: the
 * app runs local-only and hides sign-in, so a clone without a Supabase
 * project still works.
 *
 * The anon key is public by design -- it identifies the project, not a user,
 * and Row Level Security is what protects the data.
 */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null

export const syncConfigured = supabase !== null
