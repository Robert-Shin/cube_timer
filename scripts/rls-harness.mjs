#!/usr/bin/env node
/**
 * Adversarial Row Level Security harness.
 *
 * The anon key ships in the browser bundle, so RLS is the entire boundary
 * between one user's solves and everyone else. These assertions are written
 * from the attacker's side: two real accounts, ordinary anon-key clients,
 * and no privileged access except to create the accounts themselves.
 *
 * Every account this run creates is tracked and deleted in a `finally`, so a
 * mid-run failure -- a real RLS regression, a transient network error, a bug
 * -- still cleans up instead of orphaning throwaway accounts in the live
 * Supabase project.
 *
 *   npm run rls
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

function readEnv(file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // Reported below.
  }
  return out
}

const env = { ...readEnv(new URL('../.env.local', import.meta.url).pathname), ...process.env }
const URL_ = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY

if (!URL_ || !ANON || !SERVICE) {
  console.error(
    'Missing configuration. .env.local needs VITE_SUPABASE_URL,\n' +
      'VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.\n\n' +
      'The service_role key is admin-level: it belongs only in .env.local\n' +
      '(gitignored) and must NOT be given a VITE_ prefix, or Vite would\n' +
      'inline it into the public bundle.',
  )
  process.exit(1)
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

// Every account this run creates, so cleanup deletes exactly those and never
// enumerates or touches anyone else's account.
const createdUserIds = []

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push([true, label])
  } catch (e) {
    results.push([false, `${label} — ${e.message}`])
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/** A throwaway confirmed account plus a client authenticated as it. */
async function asUser(email) {
  const password = randomUUID()
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error
  // Tracked immediately: even if sign-in below throws, the account still
  // gets deleted by the top-level finally.
  createdUserIds.push(data.user.id)
  const client = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { client, userId: data.user.id, email }
}

async function expectEmpty(label, query) {
  await check(label, async () => {
    const { data, error } = await query
    // RLS filters rather than errors on select: an empty set is the pass.
    assert(!error || error.code === 'PGRST116', `unexpected error ${error?.message}`)
    assert((data ?? []).length === 0, `leaked ${(data ?? []).length} row(s)`)
  })
}

async function expectError(label, query) {
  await check(label, async () => {
    const { error } = await query
    assert(!!error, 'expected the write to be rejected, but it succeeded')
  })
}

async function expectOneRow(label, query) {
  await check(label, async () => {
    const { data, error } = await query
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected exactly 1 row, got ${(data ?? []).length}`)
  })
}

try {
  const stamp = Date.now()
  const a = await asUser(`rls-a-${stamp}@example.test`)
  const b = await asUser(`rls-b-${stamp}@example.test`)

  // A owns one session and one solve.
  const sessionId = randomUUID()
  const solveId = randomUUID()
  const nowIso = new Date().toISOString()
  await a.client
    .from('sessions')
    .insert({ id: sessionId, user_id: a.userId, name: 'harness', event: '333', created_at: nowIso, updated_at: nowIso })
    .throwOnError()
  await a.client
    .from('solves')
    .insert({ id: solveId, user_id: a.userId, session_id: sessionId, scramble: 'R U', time_ms: 12340, created_at: nowIso, updated_at: nowIso })
    .throwOnError()

  // Positive control, checked first: without this, a filter that wrongly
  // returns empty for everyone would still pass the cross-user assertions
  // below for the wrong reason.
  await expectOneRow("A can read her own session", a.client.from('sessions').select('*').eq('id', sessionId))
  await expectOneRow("A can read her own solve", a.client.from('solves').select('*').eq('id', solveId))

  await expectEmpty("B cannot read A's solves", b.client.from('solves').select('*').eq('user_id', a.userId))
  await expectEmpty("B cannot read A's sessions", b.client.from('sessions').select('*').eq('user_id', a.userId))
  await expectError(
    "B cannot write a solve attributed to A",
    b.client.from('solves').insert({ id: randomUUID(), user_id: a.userId, session_id: sessionId, scramble: 'x', time_ms: 1, created_at: nowIso, updated_at: nowIso }),
  )
} finally {
  // Removing the users cascades to their rows. Runs even on a thrown setup
  // or assertion error, so a failed run never orphans accounts.
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId)
  }
}

let failed = 0
for (const [ok, label] of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failed++
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`)
process.exit(failed ? 1 : 0)
