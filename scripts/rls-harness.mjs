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

// Sentinel event ids for daily_scrambles fixtures this run seeds directly
// (bypassing RLS via the service-role client, the way generate-scrambles.mjs
// never can). These must never collide with a real challenge event id --
// '222', '333', '444', '555', '666', '777', 'minx', 'pyram', 'skewb', 'sq1',
// 'clock' -- because reveal_daily/submit_daily are event-agnostic, so a
// sentinel exercises them exactly as well as a real event would, without any
// risk of a leftover fixture being mistaken for that day's real scramble by
// generate-scrambles.mjs's ignoreDuplicates upsert. Three distinct sentinels
// because the flow below needs three independent (event, utc_day) rows: the
// main reveal/submit path, the "no attempt yet" rejection (which must NOT
// already have an attempt from another check), and the concurrent-submission
// race.
const SENTINEL_EVENT_MAIN = '__harness_main__'
const SENTINEL_EVENT_NO_ATTEMPT = '__harness_no_attempt__'
const SENTINEL_EVENT_RACE = '__harness_race__'
// Two more sentinels for the rows this harness writes directly into
// daily_attempts / daily_bests. Seeding those with the REAL '333' on the REAL
// current utc_day put a fake row on the live 3x3 leaderboard for the duration
// of every run, and left it there permanently if cleanup below failed (which
// only warns, by design). The policies and functions are event-agnostic, so a
// sentinel exercises them exactly as well while being unreachable from any
// board query.
const SENTINEL_EVENT_SEED = '__harness_seed__'
const SENTINEL_EVENT_OPTOUT = '__harness_optout__'

// Fixture rows this run writes into daily_attempts / daily_bests / profiles.
// Deleting the throwaway accounts does cascade to all three, but the deletes
// are also done explicitly so a failed account deletion cannot strand a row.
const seededAttempts = []
const seededBests = []
const seededProfiles = []

// Every daily_scrambles row this run seeds, so cleanup can delete exactly
// those and nothing that generate-scrambles.mjs or a real user wrote.
const seededScrambles = []

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

/**
 * Claims a username for a throwaway account. friendships references
 * profiles(user_id), so without this every insert below fails on the foreign
 * key rather than on the policy under test -- which would make these
 * assertions pass for entirely the wrong reason.
 *
 * Idempotent: earlier assertions in this same run may already have seeded a
 * profile for this account (A gets one at "setup: seed a profile for A"), in
 * which case this reuses it instead of colliding with profiles_pkey.
 */
async function claimProfile(u) {
  const { data: existing, error: selectError } = await admin
    .from('profiles')
    .select('username')
    .eq('user_id', u.userId)
    .maybeSingle()
  // maybeSingle() returns no error for "zero rows" -- any error here is a
  // genuine failure (permissions, connectivity, etc.), not "not claimed
  // yet", and must not be swallowed by silently falling through to the
  // insert path below.
  if (selectError) throw selectError
  if (existing) return existing.username
  const username = `h${String(u.userId).replace(/-/g, '').slice(0, 12)}`
  const { error } = await u.client
    .from('profiles')
    .insert({ user_id: u.userId, username })
  if (error) throw error
  seededProfiles.push(u.userId)
  return username
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

// Like expectError, but for assertions whose entire point is that RLS itself
// did the rejecting -- not a table constraint that happens to fire on the
// same write. `expectError` only checks truthiness, so it cannot tell "the
// policy rejected this" from "a unique or foreign-key violation rejected
// this for an unrelated reason" -- exactly the trap that made the original
// E assertion (redirecting a pending request's addressee) pass whether or
// not the addressee clause existed, because the proposed row collided with
// an existing primary key either way. Use this wherever an RLS rejection is
// the thing under test.
async function expectRlsError(label, query) {
  await check(label, async () => {
    const { error } = await query
    assert(!!error, 'expected the write to be rejected, but it succeeded')
    const isRlsRejection =
      error.code === '42501' ||
      /row-level security|policy/i.test(error.message ?? '')
    assert(
      isRlsRejection,
      `expected a row-level-security rejection (42501), got ${error.code}: ${error.message} -- this assertion would be testing the wrong thing`,
    )
  })
}

// A revoked-EXECUTE rejection looks different from an RLS rejection: Postgres
// refuses to even start the function, so there is no query to filter down to
// zero rows -- the client gets a bare 42501 "permission denied for function
// ...". expectEmpty cannot distinguish that from "the function ran and
// correctly decided to return nothing", which is exactly how the original
// finding here went undetected: are_friends(null, p_user) is false for an
// unauthenticated caller, so friend_calendar/friend_stats already returned
// an empty array to anon even while anon could freely EXECUTE them -- an
// empty result that had nothing to do with the grant. Only a query that
// demands an error, and demands it be specifically permission-denied, proves
// EXECUTE was actually revoked.
async function expectPermissionDenied(label, query) {
  await check(label, async () => {
    const { data, error } = await query
    assert(
      !!error,
      `expected a permission-denied error, but the call succeeded with ${(data ?? []).length} row(s) -- EXECUTE was not actually revoked`,
    )
    const isPermissionDenied =
      error.code === '42501' || /permission denied for function/i.test(error.message ?? '')
    assert(
      isPermissionDenied,
      `expected a permission-denied error (42501: permission denied for function), got ${error.code}: ${error.message}`,
    )
  })
}

async function expectOneRow(label, query) {
  await check(label, async () => {
    const { data, error } = await query
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected exactly 1 row, got ${(data ?? []).length}`)
  })
}

// Preflight: confirm every table the harness depends on actually exists,
// using the service-role client so RLS (including daily_scrambles' total
// lack of a select policy) cannot masquerade as "table missing". This runs
// before any assertion and is not itself an assertion -- it does not touch
// `results`. Without it, a dropped table would make expectError/expectEmpty
// checks pass vacuously (an error either way looks like a rejection, and no
// rows either way looks like RLS filtering), so the whole suite could go
// green while actually checking nothing.
const REQUIRED_TABLES = [
  'sessions', 'solves', 'profiles',
  'daily_scrambles', 'daily_attempts', 'daily_bests',
  'friendships',
]
for (const table of REQUIRED_TABLES) {
  const { error } = await admin.from(table).select('*').limit(1)
  // PostgREST reports a table missing from its schema cache as PGRST205
  // (it never reaches raw Postgres, so the underlying 42P01 never surfaces
  // through the REST API). Any other outcome -- no error, or an error with
  // a different code -- means the table exists.
  if (error?.code === 'PGRST205') {
    console.error(`PREFLIGHT FAILED: required table "${table}" does not exist. Apply supabase/schema.sql before running the RLS harness.`)
    process.exit(1)
  }
}

// Same reasoning extended to the two challenge functions: calling them with
// the service-role client has no user session, so auth.uid() is null and
// both functions raise 'not signed in' as their very first statement --
// before either touches a row -- so this probe never writes anything. A
// missing function instead reports PGRST202 ("Could not find the function
// ... in the schema cache"), which is the only outcome that fails the
// preflight. Any other error is a business-logic error, which proves the
// function exists and ran. Without this, dropping reveal_daily or
// submit_daily would make their assertions below pass vacuously: a missing
// function also returns an error, and expectError-shaped checks can't tell
// "rejected for the reason under test" from "doesn't exist at all".
const REQUIRED_FUNCTIONS = [
  { name: 'reveal_daily', args: { p_event: '__preflight_probe__' } },
  { name: 'submit_daily', args: { p_event: '__preflight_probe__', p_time_ms: 0, p_penalty: 'none' } },
  // Probed with a random uuid: are_friends is false for it, so both return
  // no rows without touching anyone's data. Only PGRST202 (function missing)
  // fails the preflight.
  { name: 'friend_calendar', args: { p_user: '00000000-0000-0000-0000-000000000000', p_session: '00000000-0000-0000-0000-000000000000', p_since: '2000-01-01' } },
  { name: 'friend_stats', args: { p_user: '00000000-0000-0000-0000-000000000000', p_session: '00000000-0000-0000-0000-000000000000' } },
  { name: 'friend_daily', args: { p_user: '00000000-0000-0000-0000-000000000000', p_event: '__preflight_probe__' } },
  { name: 'friend_sessions', args: { p_user: '00000000-0000-0000-0000-000000000000' } },
  // Probed with a random uuid: are_friends is false for it, so this returns
  // zero rows rather than touching anyone's data.
  { name: 'friend_solves', args: {
      p_user: '00000000-0000-0000-0000-000000000000',
      p_session: '00000000-0000-0000-0000-000000000000',
      p_limit: 10,
    } },
]
for (const { name, args } of REQUIRED_FUNCTIONS) {
  const { error } = await admin.rpc(name, args)
  if (error?.code === 'PGRST202') {
    console.error(`PREFLIGHT FAILED: required function "${name}" does not exist. Apply supabase/schema.sql before running the RLS harness.`)
    process.exit(1)
  }
}

// Hoisted above the try so the finally block can see them regardless of
// where (or whether) the friend_calendar/friend_stats assertions below
// manage to run -- a mid-run throw must not strand the seeded sessions.
let friendSessionId = null
// A second session for b holding NO solves, used to prove friend_sessions
// omits empty logs. Seeded and cleaned alongside the one above.
let friendEmptySessionId = null

try {
  const stamp = Date.now()
  const a = await asUser(`rls-a-${stamp}@example.test`)
  const b = await asUser(`rls-b-${stamp}@example.test`)
  // A plain anon-key client with no session at all -- the shape of an
  // attacker who has only the public bundle and never signed in. Every
  // board-facing select policy must require auth.uid() is not null; these
  // are the assertions that catch a policy that forgot to.
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })

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

  const today = new Date().toISOString().slice(0, 10)

  await expectEmpty(
    'nobody can select daily_scrambles directly',
    b.client.from('daily_scrambles').select('*'),
  )

  // A has revealed but not submitted. Supports both the assertion right
  // below and the published-attempt assertion after it, so it gets its own
  // labelled check rather than crashing the run if the table is missing.
  await check('setup: seed a revealed attempt for A', async () => {
    await admin.from('daily_attempts').insert({
      user_id: a.userId, event: SENTINEL_EVENT_SEED, utc_day: today,
    }).throwOnError()
    seededAttempts.push({ user_id: a.userId, event: SENTINEL_EVENT_SEED, utc_day: today })
  })

  // A profile for A, so the "no email column" check below has an actual row to
  // inspect. Without one, profiles came back empty and the loop body -- the
  // only place the assertion lived -- never ran, so the check was green
  // whatever the schema exposed.
  await check('setup: seed a profile for A', async () => {
    await admin.from('profiles').insert({
      user_id: a.userId, username: `h${stamp}`, opted_in: false,
    }).throwOnError()
    seededProfiles.push(a.userId)
  })

  // A real row exists at this point (seeded just above), so either outcome
  // below is RLS/grants actually blocking it, not just "no rows to leak".
  // Unlike expectEmpty, a permission-denied error here is an ACCEPTABLE pass
  // alongside an empty result -- not a failure to relax back to expectEmpty.
  // The anon role has no column grant on profiles at all, so Postgres denies
  // the query outright rather than filtering it to zero rows via RLS; denied
  // is the stronger outcome and exactly what we want. Only rows actually
  // coming back should fail this assertion.
  await check(
    'an unauthenticated client cannot read profiles at all (empty result or permission-denied are both acceptable)',
    async () => {
      const { data, error } = await anon.from('profiles').select('*')
      if (error) {
        assert(error.code === '42501', `expected a permission-denied error, got ${error.code}: ${error.message}`)
        return
      }
      assert((data ?? []).length === 0, `leaked ${(data ?? []).length} row(s)`)
    },
  )

  await expectEmpty(
    "B cannot see A's unsubmitted attempt",
    b.client.from('daily_attempts').select('*').eq('user_id', a.userId),
  )

  await check('a published submitted attempt is visible to B', async () => {
    await admin.from('daily_attempts')
      .update({ submitted_at: new Date().toISOString(), time_ms: 9990, published: true })
      .eq('user_id', a.userId).eq('event', SENTINEL_EVENT_SEED).eq('utc_day', today)
      .throwOnError()
    const { data, error } = await b.client
      .from('daily_attempts').select('time_ms')
      .eq('user_id', a.userId).eq('event', SENTINEL_EVENT_SEED)
    assert(!error, `unexpected error ${error?.message}`)
    assert(data.length === 1 && data[0].time_ms === 9990, 'published attempt was not readable')
  })

  // This is the assertion that proves Finding A is fixed: the row above is
  // published and submitted -- exactly the board-visible shape -- yet an
  // unauthenticated client must still see nothing, because
  // attempts_select_board now requires auth.uid() is not null.
  await expectEmpty(
    'an unauthenticated client cannot read a published attempt on the board',
    anon.from('daily_attempts').select('*').eq('user_id', a.userId),
  )

  await check('an authenticated user can still read the board (fix does not break the feature)', async () => {
    const { data: attemptData, error: attemptError } = await b.client
      .from('daily_attempts').select('time_ms')
      .eq('user_id', a.userId).eq('event', SENTINEL_EVENT_SEED)
    assert(!attemptError, `attempts: unexpected error ${attemptError?.message}`)
    assert(attemptData.length === 1, 'a signed-in caller could not read a published attempt')

    const { data: profileData, error: profileError } = await b.client
      .from('profiles').select('user_id, username')
      .eq('user_id', a.userId)
    assert(!profileError, `profiles: unexpected error ${profileError?.message}`)
    assert(profileData.length === 1, 'a signed-in caller could not read profiles for the board')
  })

  // Another user's profile is not writable. RLS filters the row out rather than
  // erroring, so a silent zero-row update is the expected shape -- which is why
  // this re-reads with the service role instead of trusting the absent error.
  await check('user B cannot rename user A', async () => {
    await b.client.from('profiles').update({ username: `hijack${stamp}` }).eq('user_id', a.userId)
    const { data } = await admin.from('profiles').select('username').eq('user_id', a.userId).single()
    assert(data.username === `h${stamp}`, `A's username became ${data.username}`)
  })

  // The same boundary, on the column that actually decides board visibility:
  // username only changes a label, opted_in puts someone on a public list. A
  // policy that covered one but not the other would pass the check above.
  await check('user B cannot opt user A in', async () => {
    await b.client.from('profiles').update({ opted_in: true }).eq('user_id', a.userId)
    const { data } = await admin.from('profiles').select('opted_in').eq('user_id', a.userId).single()
    assert(data.opted_in === false, `A's opted_in became ${data.opted_in}`)
  })

  // Case-insensitive uniqueness. Written with the service role deliberately: this
  // must be the index refusing it, not client-side validation.
  await check('a name differing only in case is rejected', async () => {
    const { error } = await admin.from('profiles').insert({
      user_id: b.userId, username: `H${stamp}`, opted_in: false,
    })
    if (!error) seededProfiles.push(b.userId)
    assert(error?.code === '23505', `expected 23505, got ${error?.code ?? 'no error'}`)
  })

  await check('an ill-formed name is rejected by the check constraint', async () => {
    const { error } = await admin.from('profiles').insert({
      user_id: b.userId, username: 'no-hyphens-allowed', opted_in: false,
    })
    if (!error) seededProfiles.push(b.userId)
    assert(error?.code === '23514', `expected 23514, got ${error?.code ?? 'no error'}`)
  })

  await expectError(
    'B cannot write an attempt at all',
    b.client.from('daily_attempts').insert({ user_id: b.userId, event: SENTINEL_EVENT_SEED, utc_day: today }),
  )

  await expectError(
    'a user who has not opted in cannot publish a daily best',
    b.client.from('daily_bests').insert({
      user_id: b.userId, event: SENTINEL_EVENT_SEED, utc_day: today,
      time_ms: 8000, updated_at: new Date().toISOString(), published: true,
    }),
  )

  await check('the same row is accepted unpublished', async () => {
    const { error } = await b.client.from('daily_bests').insert({
      user_id: b.userId, event: SENTINEL_EVENT_SEED, utc_day: today,
      time_ms: 8000, updated_at: new Date().toISOString(), published: false,
    })
    assert(!error, `rejected an unpublished own-row write: ${error?.message}`)
    seededBests.push({ user_id: b.userId, event: SENTINEL_EVENT_SEED, utc_day: today })
  })

  // The negative above proves a non-opted-in user cannot publish. On its own
  // that is satisfied just as well by a broken `exists (... and p.opted_in)`
  // subquery that denies EVERYONE -- the board would be permanently empty and
  // this suite would still be all green. These two checks pin the gate down
  // from both sides.
  await check('with opted_in, a published best is accepted and visible to others', async () => {
    await admin.from('profiles').update({ opted_in: true }).eq('user_id', a.userId).throwOnError()
    const row = { user_id: a.userId, event: SENTINEL_EVENT_SEED, utc_day: today }
    const { error } = await a.client.from('daily_bests').insert({
      ...row, time_ms: 7777, updated_at: new Date().toISOString(), published: true,
    })
    assert(!error, `an opted-in user could not publish: ${error?.message}`)
    seededBests.push(row)
    const { data, error: readError } = await b.client
      .from('daily_bests').select('time_ms')
      .eq('user_id', a.userId).eq('event', SENTINEL_EVENT_SEED).eq('utc_day', today)
    assert(!readError, `unexpected error ${readError?.message}`)
    assert(data.length === 1 && data[0].time_ms === 7777, 'a published best was not visible to another user')
  })

  await expectEmpty(
    'an unauthenticated client cannot read a published best on the board',
    anon.from('daily_bests').select('*')
      .eq('user_id', a.userId).eq('event', SENTINEL_EVENT_SEED).eq('utc_day', today),
  )

  await check('withdrawing opted_in blocks the next published write', async () => {
    await admin.from('profiles').update({ opted_in: false }).eq('user_id', a.userId).throwOnError()
    const row = { user_id: a.userId, event: SENTINEL_EVENT_OPTOUT, utc_day: today }
    const { error } = await a.client.from('daily_bests').insert({
      ...row, time_ms: 6666, updated_at: new Date().toISOString(), published: true,
    })
    if (!error) seededBests.push(row)
    assert(!!error, 'published after opting back out')
  })

  await check('no query path returns an email address', async () => {
    // Each source must actually return rows, or "no email in the results" is
    // true only because there were no results -- which is how this check used
    // to pass without ever running its assertion.
    // profiles uses the explicitly granted columns, not '*': the
    // column-level grant only covers (user_id, username, opted_in), and
    // select('*') requires SELECT on every column, so '*' is denied outright
    // now -- see the dedicated assertion right after this one, which is the
    // regression test for that property.
    const sources = [
      ['profiles', await b.client.from('profiles').select('user_id, username, opted_in')],
      ['daily_attempts', await b.client.from('daily_attempts').select('*')],
      ['daily_bests', await b.client.from('daily_bests').select('*')],
    ]
    for (const [table, { data, error }] of sources) {
      assert(!error, `${table}: unexpected error ${error?.message}`)
      assert((data ?? []).length > 0, `${table} returned no rows, so this check would prove nothing`)
      for (const row of data) {
        assert(!('email' in row), `${table} exposed an email column`)
      }
    }

    // Extended to the unauthenticated client's own attempts query. This one
    // is expected to come back empty now that attempts_select_board requires
    // a signed-in caller, so it can't use the "must return rows" shape above
    // -- but if that policy ever regressed and started leaking rows again,
    // this still catches an email column riding along with them.
    const { data: anonAttempts, error: anonError } = await anon
      .from('daily_attempts').select('*')
    assert(!anonError || anonError.code === 'PGRST116', `daily_attempts (unauthenticated): unexpected error ${anonError?.message}`)
    for (const row of anonAttempts ?? []) {
      assert(!('email' in row), 'daily_attempts (unauthenticated) exposed an email column')
    }
  })

  // The regression test for phase 1: profiles is column-granted to exactly
  // (user_id, username, opted_in), so `select('*')` -- which requires SELECT
  // on every column -- must be denied even for a signed-in caller reading
  // their OWN row, which RLS alone would happily allow. This is what stops a
  // column phase 1 adds later from becoming public by default: it would need
  // its own deliberate grant to be readable at all, '*' or otherwise.
  await check('select * on profiles is denied, so a new column is not public by default', async () => {
    const { data, error } = await a.client.from('profiles').select('*').eq('user_id', a.userId)
    assert(!!error, 'select(*) on profiles succeeded -- the column grant is not restricting it')
    assert(error.code === '42501', `expected a permission-denied error, got ${error.code}: ${error.message}`)
    assert(!data, 'select(*) returned data alongside an error')
  })

  // A scramble must exist for the day before reveal can return one. Seeded
  // under a sentinel event id -- see SENTINEL_EVENT_MAIN above -- and a
  // plausibly-shaped but clearly-fake scramble string, so it can never be
  // mistaken for a real daily challenge.
  const mainFixture = { event: SENTINEL_EVENT_MAIN, utc_day: today, scramble: "R U R2 F' D2 L Uw2 __harness_fixture__" }
  await admin.from('daily_scrambles').upsert(mainFixture).throwOnError()
  seededScrambles.push(mainFixture)

  await check('reveal returns the scramble and creates the commitment', async () => {
    const { data, error } = await b.client.rpc('reveal_daily', { p_event: SENTINEL_EVENT_MAIN })
    assert(!error, `reveal failed: ${error?.message}`)
    assert(data[0].scramble === mainFixture.scramble, 'wrong scramble returned')
    assert(data[0].submitted === false, 'a fresh attempt claimed to be submitted')
  })

  await check('revealing twice is idempotent and returns the same scramble', async () => {
    const { data, error } = await b.client.rpc('reveal_daily', { p_event: SENTINEL_EVENT_MAIN })
    assert(!error, `second reveal failed: ${error?.message}`)
    assert(data[0].scramble === mainFixture.scramble, 'second reveal changed the scramble')
  })

  await check('submitting with no attempt is rejected', async () => {
    const { error } = await b.client.rpc('submit_daily', {
      p_event: SENTINEL_EVENT_NO_ATTEMPT, p_time_ms: 30000, p_penalty: 'none',
    })
    assert(!!error, 'submitted for an event that was never revealed')
  })

  await check('a time longer than the elapsed wall clock is rejected', async () => {
    const { error } = await b.client.rpc('submit_daily', {
      p_event: SENTINEL_EVENT_MAIN, p_time_ms: 86_400_000, p_penalty: 'none',
    })
    assert(!!error, 'accepted a 24-hour solve seconds after reveal')
  })

  // A real attempt spends its duration between reveal and submit, so the
  // elapsed-time guard always has room. This test does not -- it reveals and
  // submits back to back -- so it has to manufacture that room explicitly: a
  // short wait, then a claimed time comfortably below it. Do not replace
  // this with a "realistic" solve time; the guard in submit_daily is real
  // and correctly rejects a claimed time it can't have had.
  await new Promise((resolve) => setTimeout(resolve, 1500))

  await check('the first submission is accepted', async () => {
    const { error } = await b.client.rpc('submit_daily', {
      p_event: SENTINEL_EVENT_MAIN, p_time_ms: 900, p_penalty: 'none',
    })
    assert(!error, `first submission rejected: ${error?.message}`)
  })

  await check('a second submission is rejected', async () => {
    const { error } = await b.client.rpc('submit_daily', {
      p_event: SENTINEL_EVENT_MAIN, p_time_ms: 9999, p_penalty: 'none',
    })
    assert(!!error, 'a result was overwritten — it must be immutable')
  })

  await check('a result from a user who has not opted in stays unpublished', async () => {
    const { data } = await admin.from('daily_attempts').select('published')
      .eq('user_id', b.userId).eq('event', SENTINEL_EVENT_MAIN).eq('utc_day', today)
    assert(data[0].published === false, 'published without opting in')
  })

  // The sequential "a second submission is rejected" check above would pass
  // even against the racy pre-fix version of submit_daily -- both calls see
  // the write from the first before running, because they aren't
  // concurrent. This is the check that actually exercises the atomic
  // `... where submitted_at is null` guard: two calls in flight at once,
  // racing against the same row, must leave exactly one winner.
  await check('two concurrent submissions: exactly one wins', async () => {
    const event = SENTINEL_EVENT_RACE
    const raceFixture = { event, utc_day: today, scramble: "R2 U' F2 D L2 B' __harness_fixture__" }
    await admin.from('daily_scrambles').upsert(raceFixture).throwOnError()
    seededScrambles.push(raceFixture)

    const { error: revealError } = await b.client.rpc('reveal_daily', { p_event: event })
    assert(!revealError, `reveal before race failed: ${revealError?.message}`)

    // Room for the elapsed-time guard, same as the earlier submission test.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const [r1, r2] = await Promise.all([
      b.client.rpc('submit_daily', { p_event: event, p_time_ms: 900, p_penalty: 'none' }),
      b.client.rpc('submit_daily', { p_event: event, p_time_ms: 901, p_penalty: 'none' }),
    ])
    const succeeded = [r1, r2].filter((r) => !r.error)
    const failed = [r1, r2].filter((r) => r.error)
    assert(succeeded.length === 1, `expected exactly 1 winner, got ${succeeded.length}`)
    assert(failed.length === 1, `expected exactly 1 rejection, got ${failed.length}`)
  })

  // ---------------------------------------------------------- friendships
  const c = await asUser(`rls-c-${stamp}@example.test`)
  // A fourth account, used only to isolate E (friend_accept's WITH CHECK
  // `auth.uid() = addressee`) below. Redirecting to b.userId collided with
  // the primary key (requester, addressee) of the row assertion 6 already
  // created -- (A, B) -- so an error came back whether or not E existed,
  // and expectError couldn't tell those two cases apart. D has no existing
  // friendship with A in either direction, so the proposed (A, D) row exists
  // nowhere: if E were deleted, the update would actually SUCCEED, giving
  // expectRlsError something real to fail against.
  const d = await asUser(`rls-d-${stamp}@example.test`)
  // A fifth account, used only as the victim in the requester-rewrite attack
  // below. Kept entirely separate from a/b/c/d's existing entanglements
  // (a<->b accepted, a<->c pending/redirect-tested, d used only as E's
  // never-consummated redirect target) so the attack's central claim -- "the
  // victim never sent or received anything and still ends up looking like a
  // friend" -- is not accidentally true for some other reason already baked
  // into e's history.
  const e = await asUser(`rls-e-${stamp}@example.test`)
  await claimProfile(a)
  await claimProfile(b)
  await claimProfile(c)
  await claimProfile(d)
  await claimProfile(e)

  // THE most important assertion in this feature. Without `state = 'pending'`
  // on the insert policy, this succeeds and a stranger reads a full practice
  // history without the victim ever being asked.
  //
  // This does the work of expectError, but also captures the real error
  // object and confirms it is a row-level-security rejection (42501, or a
  // message mentioning row-level security/policy) rather than a foreign-key
  // violation (23503) or a unique violation (23505). Without this check the
  // assertion could pass vacuously -- rejected for the wrong reason -- and
  // still read green.
  await check('friendships: cannot insert a pre-accepted friendship', async () => {
    const { error } = await a.client.from('friendships')
      .insert({ requester: a.userId, addressee: b.userId, state: 'accepted' })
    assert(!!error, 'expected the write to be rejected, but it succeeded')
    const isRlsRejection =
      error.code === '42501' ||
      /row-level security|policy/i.test(error.message ?? '')
    assert(
      isRlsRejection,
      `expected a row-level-security rejection (42501), got ${error.code}: ${error.message} -- this assertion would be testing the wrong thing`,
    )
    console.log(`    (verbatim error for "cannot insert a pre-accepted friendship": ${JSON.stringify(error)})`)
  })

  // You cannot forge a request FROM someone else. expectRlsError, not
  // expectError: the point under test is specifically the insert policy's
  // `auth.uid() = requester` conjunct. If it were deleted, `state = 'pending'`
  // still passes and no (b, c) row exists yet to collide with, so the insert
  // would actually SUCCEED -- expectRlsError (and even plain expectError)
  // would correctly go red in that case, since no other constraint stands in
  // to reject it for the wrong reason.
  await expectRlsError(
    'friendships: cannot insert a request as another user',
    a.client.from('friendships')
      .insert({ requester: b.userId, addressee: c.userId, state: 'pending' }),
  )

  // The legitimate path: a pending request from a to b.
  await expectOneRow(
    'friendships: can send a pending request as yourself',
    a.client.from('friendships')
      .insert({ requester: a.userId, addressee: b.userId, state: 'pending' })
      .select(),
  )

  // The requester cannot accept their own request. This is rejected by
  // `auth.uid() = addressee` -- but that predicate appears in BOTH the
  // update policy's `using` clause and its `with check` clause, and this
  // write fails it under either evaluation (A is neither the row's current
  // addressee nor would be its new one), so this assertion proves "using OR
  // with check reject it", not the `using` clause specifically.
  await expectEmpty(
    'friendships: requester cannot self-accept',
    a.client.from('friendships')
      .update({ state: 'accepted' })
      .eq('requester', a.userId).eq('addressee', b.userId)
      .select(),
  )

  // A third party sees nothing of a friendship between two other users.
  await expectEmpty(
    'friendships: a third party cannot see a friendship between others',
    c.client.from('friendships').select('*')
      .eq('requester', a.userId).eq('addressee', b.userId),
  )

  // The addressee accepts. This is the only legal transition.
  await expectOneRow(
    'friendships: addressee can accept a pending request',
    b.client.from('friendships')
      .update({ state: 'accepted' })
      .eq('requester', a.userId).eq('addressee', b.userId)
      .select(),
  )

  // Isolates the `state = 'pending'` half of the update policy's USING
  // clause, independent of every other clause. B is the addressee (so
  // `auth.uid() = addressee` passes) and the target state is 'accepted' (so
  // WITH CHECK passes) -- the row is already accepted, so USING's
  // `state = 'pending'` is the only clause that can still reject this, and
  // it matches no row. Paired with "addressee can accept a pending request"
  // above (same actor, same pair, same target state, differing only in the
  // row's CURRENT state), this is the differential proof that a live
  // weaken-and-restore of the policy would otherwise have provided.
  await expectEmpty(
    'friendships: the addressee cannot re-accept an already-accepted friendship',
    b.client.from('friendships')
      .update({ state: 'accepted' })
      .eq('requester', a.userId).eq('addressee', b.userId)
      .select(),
  )

  // An accepted row cannot be flipped back to pending -- otherwise it could
  // be laundered through a second accept to reset provenance.
  await expectEmpty(
    'friendships: an accepted friendship cannot be reverted to pending',
    b.client.from('friendships')
      .update({ state: 'pending' })
      .eq('requester', a.userId).eq('addressee', b.userId)
      .select(),
  )

  // One row per unordered pair: the reverse-direction request is refused by
  // the friendships_pair unique index. Plain expectError deliberately, not
  // expectRlsError: this row would pass every RLS clause (b is inserting as
  // itself, state is 'pending'), so a genuine 23505 unique-violation IS the
  // expected outcome here -- it's a table constraint under test, not a
  // policy.
  await expectError(
    'friendships: the reverse-direction duplicate is rejected',
    b.client.from('friendships')
      .insert({ requester: b.userId, addressee: a.userId, state: 'pending' }),
  )

  // Finding C1's fix added a column-level grant to friendships (see
  // schema.sql), but -- unlike profiles' SELECT grant, which deliberately
  // narrows what's readable -- its SELECT list names every column the table
  // has today (requester, addressee, state, created_at), so select('*')
  // still succeeds. That grant exists to close UPDATE (only `state` is
  // writable), not to restrict SELECT: every current column is meaningful to
  // both parties and to nobody else, and the row filter is the whole
  // read-side boundary. This assertion pins that reasoning: '*' must succeed
  // AND return only rows the caller is party to. If someone later adds a
  // column that should not be shared, this is the assertion that should be
  // made to fail, by narrowing the SELECT grant -- not deleted.
  await check('friendships: select(*) returns only rows the caller is part of', async () => {
    const { data, error } = await c.client.from('friendships').select('*')
    assert(!error, `unexpected error ${error?.message}`)
    for (const row of data ?? []) {
      assert(
        row.requester === c.userId || row.addressee === c.userId,
        `leaked a friendship between ${row.requester} and ${row.addressee}`,
      )
    }
  })

  // friend_accept's WITH CHECK has two conjuncts: `auth.uid() = addressee`
  // (E) and `state = 'accepted'` (F). Nothing above exercises either: no
  // assertion changes `addressee`, and "an accepted friendship cannot be
  // reverted to pending" is already rejected by USING (the row's CURRENT
  // state is 'accepted' by that point) before WITH CHECK is ever reached, so
  // it cannot isolate F either. Isolating E and F needs a row whose CURRENT
  // state is 'pending' (so USING passes) -- but the A<->B row is 'accepted'
  // by this point in the sequence, and reusing it would mean reordering
  // assertions whose state sequence is already traced as coherent. So this
  // seeds a second, independent pending request (A -> C) purely to isolate
  // these two clauses; it never touches the A<->B row or its assertions.
  // Plain setup, not an assertion: matches the unasserted style used above
  // for "A owns one session and one solve" (.throwOnError(), no check()/
  // results entry) rather than the "setup: seed a ..." style, which IS
  // counted -- this keeps the new-assertion count at exactly 2 (E, F), not 3.
  await a.client.from('friendships')
    .insert({ requester: a.userId, addressee: c.userId, state: 'pending' })
    .throwOnError()

  // Isolates E. USING passes: C is the row's CURRENT addressee and the row
  // is pending. WITH CHECK's `state = 'accepted'` (F) also passes -- the
  // target state IS 'accepted'. Only E can still reject this: the row AS IT
  // WOULD BECOME has addressee = d.userId, not C, so `auth.uid() = addressee`
  // fails against the new row. Without E, C could redirect a request A sent
  // to C onto d -- someone A never asked and who never consented.
  //
  // Redirects to d.userId, not b.userId: A already has an ACCEPTED (A, B)
  // row by this point (assertion 6), so redirecting here to B would propose
  // a row with the same primary key (requester, addressee) as that existing
  // row. Counterfactual with E deleted: WITH CHECK would reduce to F alone,
  // which passes, so Postgres would proceed to the heap write and hit the
  // (A, B) primary-key conflict -- 23505, not the row succeeding -- so
  // *any* expectError-shaped check would report "ok" whether E existed or
  // not; that was the bug in round 1's version of this assertion. D has no
  // friendship with A in either direction, so (A, d.userId) exists nowhere:
  // with E deleted, this update would actually SUCCEED (no error at all),
  // which is what makes the assertion capable of going red.
  //
  // expectRlsError, not plain expectError: with E present, a row that
  // satisfies USING but whose new values fail WITH CHECK is not silently
  // filtered the way a USING failure is -- Postgres raises an explicit
  // "new row violates row-level security policy" error (42501) instead of
  // returning zero rows -- and this confirms the rejection actually IS that
  // policy error, not some other error that happened to also be non-null.
  await expectRlsError(
    'friendships: the addressee cannot redirect a pending request to someone else',
    c.client.from('friendships')
      .update({ addressee: d.userId, state: 'accepted' })
      .eq('requester', a.userId).eq('addressee', c.userId)
      .select(),
  )

  // Isolates F. The redirect attempt above was rejected (not merely filtered
  // -- it errored, so the row was never touched), leaving the A -> C row
  // still pending, addressee still C. USING passes for the same reason as
  // above, and `auth.uid() = addressee` in WITH CHECK also passes --
  // addressee is unchanged, so no primary-key collision is possible here
  // regardless of F's presence. Only F can still reject this: the target
  // state is 'pending', not 'accepted'. Counterfactual with F deleted: WITH
  // CHECK reduces to E alone, which passes (addressee is unchanged), USING
  // already passed, so the update would SUCCEED with no error -- a real red
  // signal, not a same-PK collision. expectRlsError again, for the same
  // "confirm it's actually 42501" reason as E above.
  await expectRlsError(
    'friendships: accepting requires actually moving the state to accepted',
    c.client.from('friendships')
      .update({ state: 'pending' })
      .eq('requester', a.userId).eq('addressee', c.userId)
      .select(),
  )

  // ---------------------------------------------------- SECURITY: Finding C1
  // friend_accept's USING and WITH CHECK clauses (see E and F above) only
  // ever mention `addressee`. Neither constrains `requester`, and Postgres
  // RLS's WITH CHECK evaluates only the NEW row -- it cannot see what the row
  // used to be. So nothing stops the addressee of a pending request from
  // simultaneously (1) accepting it and (2) rewriting `requester` to a third
  // party who never sent a request and was never asked. If that succeeds,
  // are_friends(attacker, victim) becomes true and the attacker can read the
  // victim's entire practice history via friend_calendar/friend_stats.
  //
  // The A -> C pending row seeded above (for the E/F isolation block) is
  // exactly the shape this needs, with no further setup: C is the row's
  // CURRENT addressee (USING's `auth.uid() = addressee` passes) and the row
  // is pending (USING's `state = 'pending'` passes). The proposed new row
  // keeps addressee = C unchanged (WITH CHECK's `auth.uid() = addressee`
  // passes) with state = 'accepted' (WITH CHECK's other conjunct passes) --
  // only a requester check, which does not exist anywhere in the policy,
  // could still reject this.
  //
  // e stands in as the victim: e has no friendship with c in either
  // direction (e is fresh -- see its creation above), so the proposed row
  // (requester = e, addressee = c) collides with no primary key and no
  // friendships_pair entry. That matters the same way it did for E and F
  // above: if this update is (wrongly) permitted, it must actually SUCCEED
  // -- not fail for the unrelated reason of colliding with an existing row
  // -- so that expectRlsError is capable of going red here rather than
  // passing vacuously.
  await expectRlsError(
    'friendships: SECURITY (C1) -- the addressee cannot rewrite requester to a third party while accepting',
    c.client.from('friendships')
      .update({ requester: e.userId, state: 'accepted' })
      .eq('requester', a.userId).eq('addressee', c.userId)
      .select(),
  )

  // Belt-and-suspenders on the outcome, not just the error: even if the
  // update above were wrongly accepted (or wrongly reported success despite
  // being filtered), the row itself must never actually name the victim.
  // are_friends is not directly callable by clients (revoked from anon and
  // authenticated above), so the only client-reachable surface to check the
  // real, persisted outcome is reading the friendships row back. This reads
  // it as the attacker (c), over every row naming c as addressee, and
  // asserts none of them has been repointed at e -- a direct check on the
  // data, independent of whatever error shape expectRlsError observed.
  await check(
    'friendships: SECURITY (C1) -- the victim was never substituted into the row',
    async () => {
      const { data, error } = await c.client.from('friendships')
        .select('requester, addressee, state')
        .eq('addressee', c.userId)
      assert(!error, `unexpected error ${error?.message}`)
      for (const row of data ?? []) {
        assert(
          row.requester !== e.userId,
          `victim was substituted in: row is now (${row.requester}, ${row.addressee}, ${row.state})`,
        )
      }
    },
  )

  // friendships rows need no explicit cleanup: both columns reference
  // profiles(user_id) -> auth.users(id) on delete cascade, so deleting the
  // throwaway accounts removes them. seededProfiles is cleaned for the same
  // reason and is kept only for the case where account deletion itself fails.

  // --------------------------------------------- friend_calendar / friend_stats
  //
  // These two functions are `security definer`: RLS does not apply inside
  // them at all. The `public.are_friends(auth.uid(), p_user)` check baked
  // into each is the ENTIRE boundary between "b's practice history" and
  // "anyone holding the public anon key". At this point in the run,
  // friendships holds exactly (a, b, accepted) and (a, c, pending) -- so a
  // is the one accepted friend of b, c is a stranger to b, and d never
  // enters this block.
  //
  // A sentinel event id, distinct from every other sentinel above and from
  // every real challenge event id ('222', '333', '444', '555', '666', '777',
  // 'minx', 'pyram', 'skewb', 'sq1', 'clock'), so this fixture can never be
  // mistaken for a real board row even if cleanup below fails.
  const SENTINEL_EVENT_FRIEND = '__harness_friend__'
  friendSessionId = randomUUID()
  const friendSolveTimeMs = 12345
  await admin.from('sessions').insert({
    id: friendSessionId, user_id: b.userId, name: 'harness',
    event: SENTINEL_EVENT_FRIEND,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).throwOnError()
  await admin.from('solves').insert({
    id: randomUUID(), user_id: b.userId, session_id: friendSessionId,
    time_ms: friendSolveTimeMs, penalty: 'none',
    // Backdated, not the second solve future-dated: no fixture row should
    // claim to have happened in the future. friend_solves orders by
    // created_at desc, so this one must sort after friendSolveTimeMs2 below.
    created_at: new Date(Date.now() - 1000).toISOString(), updated_at: new Date().toISOString(),
  }).throwOnError()

  // A second session for b with no solves at all. friend_sessions must omit
  // it: an empty log is noise rather than practice, and every device that
  // ever opened a discipline could otherwise contribute one.
  friendEmptySessionId = randomUUID()
  await admin.from('sessions').insert({
    id: friendEmptySessionId, user_id: b.userId, name: 'harness empty',
    event: SENTINEL_EVENT_FRIEND,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).throwOnError()

  // Positive controls FIRST, and against the real, seeded solve's effective
  // time -- not just "some rows came back". Every negative assertion below
  // (expectEmpty) passes just as well if the fixture were never seeded, the
  // event id were mistyped, or the row were marked deleted: an empty result
  // proves nothing about the boundary on its own. Only once these two show
  // that a genuine accepted friend gets the real data back does "a stranger
  // gets nothing" mean "are_friends blocked it" rather than "there was
  // nothing there to leak in the first place".
  await check('friend_calendar: an accepted friend sees the calendar', async () => {
    const { data, error } = await a.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected 1 day, got ${(data ?? []).length}`)
    assert(data[0].solves === 1, `expected 1 solve, got ${data[0].solves}`)
    assert(
      data[0].day_best === friendSolveTimeMs,
      `expected day_best ${friendSolveTimeMs}, got ${data[0].day_best}`,
    )
  })

  // The value assertions above read named fields (`solves`, `day_best`) and
  // never enumerate the row's keys, so they pass just as well if a future
  // edit adds an extra column alongside them -- e.g. `s.id as solve_id` or
  // `s.session_id` picked up while refactoring the query. A friend sees the
  // times and penalties of solves in a session, ordered but not timestamped
  // (see friend_solves below). A friend never sees a scramble, a solve id,
  // a session id, or the clock time of a solve. These two functions predate
  // that and remain strictly aggregate, so assert on the exact COLUMN SET
  // rather than a sampled value: a value assertion reads named fields and
  // would not notice a scramble or solve id riding alongside them.
  await check('friend_calendar: the row exposes no solve/scramble/session id', async () => {
    const { data, error } = await a.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    })
    assert(!error, `unexpected error ${error?.message}`)
    const keys = Object.keys(data[0]).sort()
    const expected = ['day', 'day_best', 'solves']
    assert(
      JSON.stringify(keys) === JSON.stringify(expected),
      `expected exactly columns ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
    )
  })

  // friend_stats has its own aggregation path (mine/recent CTEs plus an
  // outer `where public.are_friends(...)` guarding a FROM-less scalar
  // select) entirely separate from friend_calendar's. It deserves its own
  // positive proof: if a future edit dropped that outer WHERE, this is the
  // assertion that would catch total/best_ms/recent_ms still coming back
  // for a stranger below, because without this check first there would be
  // no evidence the friend path itself was ever exercised correctly.
  await check('friend_stats: an accepted friend sees the aggregate', async () => {
    const { data, error } = await a.client.rpc('friend_stats', {
      p_user: b.userId, p_session: friendSessionId,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected 1 row, got ${(data ?? []).length}`)
    const row = data[0]
    assert(row.total === 1, `expected total 1, got ${row.total}`)
    assert(row.best_ms === friendSolveTimeMs, `expected best_ms ${friendSolveTimeMs}, got ${row.best_ms}`)
    assert(Array.isArray(row.recent_ms), `expected recent_ms to be an array, got ${JSON.stringify(row.recent_ms)}`)
    assert(
      row.recent_ms[0] === friendSolveTimeMs,
      `expected recent_ms[0] ${friendSolveTimeMs}, got ${row.recent_ms[0]}`,
    )
  })

  // Same reasoning as friend_calendar above: the value assertions read
  // named fields and would not notice an extra leaked column (a solve id,
  // scramble, or session id) riding alongside `total`/`best_ms`/`recent_ms`.
  // Assert the exact column set.
  await check('friend_stats: the row exposes no solve/scramble/session id', async () => {
    const { data, error } = await a.client.rpc('friend_stats', {
      p_user: b.userId, p_session: friendSessionId,
    })
    assert(!error, `unexpected error ${error?.message}`)
    const keys = Object.keys(data[0]).sort()
    const expected = ['best_ms', 'recent_ms', 'total']
    assert(
      JSON.stringify(keys) === JSON.stringify(expected),
      `expected exactly columns ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
    )
  })

  // ------------------------------------------------------ friend_sessions
  //
  // The list a friend profile now picks from. Same security-definer posture
  // and the same are_friends boundary as the two above, and one thing
  // neither of them had: it returns session NAMES -- user-authored text that
  // nothing exposed across accounts before this function existed. The
  // stranger and anon assertions below are what keep that disclosure scoped
  // to accepted friends.
  //
  // Positive control first, for the reason spelled out above friend_calendar:
  // every expectEmpty below passes just as well against a function that
  // returns nothing to anybody.
  await check('friend_sessions: an accepted friend sees the session list', async () => {
    const { data, error } = await a.client.rpc('friend_sessions', { p_user: b.userId })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected 1 session, got ${(data ?? []).length}`)
    const row = data[0]
    assert(row.id === friendSessionId, `expected the seeded session id, got ${row.id}`)
    assert(row.name === 'harness', `expected name 'harness', got ${JSON.stringify(row.name)}`)
    assert(
      row.discipline === SENTINEL_EVENT_FRIEND,
      `expected discipline ${SENTINEL_EVENT_FRIEND}, got ${JSON.stringify(row.discipline)}`,
    )
    assert(row.solves === 1, `expected 1 solve, got ${row.solves}`)
  })

  // The empty session seeded above must NOT appear. Asserted on the count
  // via the positive control's `length === 1` as well, but called out
  // separately so a failure names the actual cause rather than looking like
  // a generic count mismatch.
  await check('friend_sessions: a session with no solves is omitted', async () => {
    const { data, error } = await a.client.rpc('friend_sessions', { p_user: b.userId })
    assert(!error, `unexpected error ${error?.message}`)
    assert(
      !(data ?? []).some((r) => r.id === friendEmptySessionId),
      'a session with zero solves was listed',
    )
  })

  // Same reasoning as the column-set assertions above: the value checks read
  // named fields and would not notice a solve id, scramble, or goal riding
  // alongside them. A friend sees the times and penalties of solves in a
  // session, ordered but not timestamped (see friend_solves below). A
  // friend never sees a scramble, a solve id, a session id, or the clock
  // time of a solve. These two functions predate that and remain strictly
  // aggregate, so assert on the exact COLUMN SET rather than a sampled
  // value: a value assertion reads named fields and would not notice a
  // scramble or solve id riding alongside them.
  await check('friend_sessions: the row exposes no solve/scramble/goal column', async () => {
    const { data, error } = await a.client.rpc('friend_sessions', { p_user: b.userId })
    assert(!error, `unexpected error ${error?.message}`)
    const keys = Object.keys(data[0]).sort()
    const expected = ['discipline', 'id', 'last_solve_at', 'name', 'solves']
    assert(
      JSON.stringify(keys) === JSON.stringify(expected),
      `expected exactly columns ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
    )
  })

  // c has no friendship with b in either direction. If are_friends were
  // dropped from friend_sessions' WHERE, this returns b's session -- NAME
  // included -- to a stranger.
  await expectEmpty(
    'friend_sessions: a stranger gets nothing',
    c.client.rpc('friend_sessions', { p_user: b.userId }),
  )

  // The grant, not the filter. Exactly the trap that shipped twice on this
  // project: Supabase's default privileges grant EXECUTE to anon explicitly
  // per-role at creation, and `revoke ... from public` does not touch them.
  // An anon caller would then reach the body, where are_friends(null, ...)
  // is false and the result is empty -- so an expectEmpty here would stay
  // green over a function anyone holding the public bundle could call.
  // Only a bare 42501 proves EXECUTE was actually revoked by name.
  await expectPermissionDenied(
    'friend_sessions: anon cannot execute the function at all (permission denied, not a filtered-empty result)',
    anon.rpc('friend_sessions', { p_user: b.userId }),
  )

  // ------------------------------------------------------- friend_solves
  //
  // The first function that returns SOLVE ROWS rather than aggregates. Same
  // security-definer posture and the same are_friends boundary as the four
  // above: RLS does not apply inside it, so that check is the entire
  // boundary between "b's solve log" and "anyone holding the public anon
  // key".

  // A second solve for b, so ordering and the row count are observable at
  // all -- with one row, "newest first" and "oldest first" are the same
  // answer and a broken ORDER BY would pass.
  const friendSolveTimeMs2 = 23456
  await admin.from('solves').insert({
    id: randomUUID(), user_id: b.userId, session_id: friendSessionId,
    time_ms: friendSolveTimeMs2, penalty: 'plus2',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).throwOnError()

  // Positive control FIRST. Every expectEmpty below passes just as well if
  // the fixture were never seeded or the rows were marked deleted; only
  // once a genuine accepted friend gets the real times back does "a
  // stranger gets nothing" mean "are_friends blocked it".
  await check('friend_solves: an accepted friend sees the solves, newest first', async () => {
    const { data, error } = await a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 2, `expected 2 solves, got ${(data ?? []).length}`)
    assert(data[0].time_ms === friendSolveTimeMs2, `expected newest first (${friendSolveTimeMs2}), got ${data[0].time_ms}`)
    assert(data[0].penalty === 'plus2', `expected penalty plus2, got ${data[0].penalty}`)
    assert(data[1].time_ms === friendSolveTimeMs, `expected oldest last (${friendSolveTimeMs}), got ${data[1].time_ms}`)
  })

  // The value assertions above read named fields and would not notice a
  // scramble, a solve id, or created_at riding alongside them. The exact
  // column set IS the boundary this function promises.
  await check('friend_solves: the row exposes no scramble, id, or clock time', async () => {
    const { data, error } = await a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    })
    assert(!error, `unexpected error ${error?.message}`)
    const keys = Object.keys(data[0]).sort()
    const expected = ['day', 'penalty', 'time_ms']
    assert(
      JSON.stringify(keys) === JSON.stringify(expected),
      `expected exactly columns ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
    )
  })

  // expectPermissionDenied, not expectEmpty: friend_solves revokes EXECUTE
  // from anon, so an anonymous caller gets a bare 42501 and never reaches
  // the query at all. expectEmpty can't tell that apart from "the function
  // ran and decided to return nothing" -- the same anon-grant blind spot
  // documented above expectPermissionDenied's definition.
  await expectPermissionDenied(
    'friend_solves: anon cannot execute it at all',
    anon.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    }),
  )

  // The n.user_id = p_user clause. p_session is an unvalidated id from the
  // caller: a is a genuine friend of b, but names a session that is NOT
  // b's -- sessionId belongs to a, not b, and holds only a's own solve, so
  // s.user_id = p_user (b) already empties this with or without the
  // n.user_id = p_user clause. That alone cannot turn the clause's removal
  // red, so a deliberately inconsistent fixture is seeded below: a solve
  // ROW OWNED BY b sitting inside a SESSION OWNED BY a. The application can
  // never produce this state itself (every insert path ties a solve's
  // session to its own owner), but nothing stops it existing in the
  // database, and the clause exists precisely to defend against it as
  // defence-in-depth: with the clause, zero rows; without it, the function
  // would happily hand a this row of b's back. Safe to seed here -- nothing
  // downstream counts rows by session_id = sessionId, only by solveId
  // (`.eq('id', solveId)`) or session id (`.eq('id', sessionId)`), so this
  // extra row cannot disturb any other assertion. Cascades away with b's
  // account in the top-level cleanup, same as every other solve seeded for
  // b.
  await admin.from('solves').insert({
    id: randomUUID(), user_id: b.userId, session_id: sessionId,
    time_ms: 99999, penalty: 'none',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).throwOnError()
  await expectEmpty(
    "friend_solves: a friend cannot read a session that is not the named user's",
    a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: sessionId, p_limit: 100,
    }),
  )

  // p_limit is attacker-controlled; the ceiling is server-side. A two-row
  // fixture can't actually exercise the 2000 cap -- both rows satisfy
  // `<= 2000` whether or not `least(...)` is present, so that alone proves
  // nothing. p_limit: 1 does have a real failure mode against these two
  // rows: it goes red if `least`/LIMIT were removed entirely (2 rows come
  // back) or if the ceiling were hardcoded to some value >= 2 instead of
  // reading p_limit at all.
  await check('friend_solves: p_limit is honoured, not just capped', async () => {
    const { data, error } = await a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 1,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected exactly 1 solve, got ${(data ?? []).length}`)
  })

  // This proves only that an oversized p_limit is accepted rather than
  // erroring -- NOT that the 2000 ceiling itself holds. Seeding 2001+ rows
  // to actually exercise that ceiling would mean a slow write against the
  // live database on every future run, so the ceiling is left unexercised
  // here; the assertion above is what catches a regression in how p_limit
  // is honoured at all.
  await check('friend_solves: an oversized p_limit is accepted rather than erroring', async () => {
    const { data, error } = await a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 1_000_000_000,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 2, `expected 2 solves, got ${(data ?? []).length}`)
  })

  // ------------------------------------ session/user pairing (p_session)
  //
  // p_session is an unvalidated id straight from the caller, so being an
  // accepted friend of b must not turn into "read any session id I can
  // name". a IS b's accepted friend here, and passes a session id that
  // belongs to A HERSELF while claiming p_user = b.
  //
  // friend_calendar is empty either way -- its solves are already filtered
  // by s.user_id = p_user -- so this one is a regression guard rather than a
  // live finding, and is labelled as such honestly.
  await expectEmpty(
    'friend_calendar: a session id belonging to someone other than p_user yields nothing',
    a.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: sessionId, p_since: '2000-01-01',
    }),
  )

  // friend_stats is the one that genuinely needs the `exists (... n.user_id
  // = p_user ...)` conjunct: its select list has NO FROM clause, so it
  // returns one row regardless of what the `mine` CTE filtered away. Without
  // that conjunct this call comes back as a row of (0, null, null) instead
  // of zero rows -- the same "one row of nulls" trap the are_friends guard
  // was written for. This assertion fails against a function missing it.
  await expectEmpty(
    'friend_stats: a session id belonging to someone other than p_user yields zero rows, not a row of nulls',
    a.client.rpc('friend_stats', { p_user: b.userId, p_session: sessionId }),
  )

  // --------------------------------------------------------- friend_daily
  //
  // `security definer`, gated on the same `are_friends(auth.uid(), p_user)`
  // boundary as friend_calendar/friend_stats above -- but with a
  // deliberately different relationship to `published`/`opted_in`: those two
  // read solves regardless of the board, because a friend's consent to be
  // seen was never tied to the board in the first place. friend_daily is the
  // one reader that COULD have reused the board's own policy
  // (attempts_select_board) and deliberately doesn't, because that policy
  // requires `published`, which requires `opted_in` -- and the spec's
  // Decisions section says those must never gate a friend's view. So the
  // fixture below seeds b with opted_in = FALSE and an UNPUBLISHED attempt on
  // purpose: if this ever came back empty, that would mean someone "fixed"
  // friend_daily to check published/opted_in after all, breaking the spec.
  //
  // No daily_scrambles row is needed for either fixture attempt below --
  // unlike reveal_daily/submit_daily (called as b, which insert through the
  // function and its FK-free but scramble-checked path), these rows are
  // written directly via the service-role client, and daily_attempts itself
  // has no foreign key to daily_scrambles.
  const SENTINEL_EVENT_FRIEND_DAILY = '__harness_friend_daily__'
  const SENTINEL_EVENT_FRIEND_DAILY_UNSUB = '__harness_friend_daily_unsub__'
  const friendDailyTimeMs = 8888

  // Explicit, not just relying on claimProfile's default: makes the "still
  // visible despite being unpublished" claim below true by construction
  // rather than by accident of whatever earlier assertion happened to run.
  await admin.from('profiles').update({ opted_in: false }).eq('user_id', b.userId).throwOnError()

  await check('setup: seed a SUBMITTED, UNPUBLISHED attempt for b (opted_in stays false)', async () => {
    await admin.from('daily_attempts').insert({
      user_id: b.userId, event: SENTINEL_EVENT_FRIEND_DAILY, utc_day: today,
      submitted_at: new Date().toISOString(), time_ms: friendDailyTimeMs, penalty: 'plus2',
      published: false,
    }).throwOnError()
    seededAttempts.push({ user_id: b.userId, event: SENTINEL_EVENT_FRIEND_DAILY, utc_day: today })
  })

  // Revealed but never submitted -- must never appear as a result.
  await check('setup: seed a revealed-but-unsubmitted attempt for b', async () => {
    await admin.from('daily_attempts').insert({
      user_id: b.userId, event: SENTINEL_EVENT_FRIEND_DAILY_UNSUB, utc_day: today,
    }).throwOnError()
    seededAttempts.push({ user_id: b.userId, event: SENTINEL_EVENT_FRIEND_DAILY_UNSUB, utc_day: today })
  })

  // Positive control, FIRST and against the actual seeded values -- every
  // negative assertion below is worthless without this: an empty result
  // proves nothing if there was never anything to return in the first
  // place.
  await check('friend_daily: an accepted friend sees the submitted result', async () => {
    const { data, error } = await a.client.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected 1 row, got ${(data ?? []).length}`)
    assert(data[0].time_ms === friendDailyTimeMs, `expected time_ms ${friendDailyTimeMs}, got ${data[0].time_ms}`)
    assert(data[0].penalty === 'plus2', `expected penalty 'plus2', got ${JSON.stringify(data[0].penalty)}`)
  })

  // THE load-bearing property of this feature: b never opted in to the
  // public board (opted_in = false, forced above) and the seeded attempt is
  // published = false -- the board path (attempts_select_board /
  // bests_select_board) would show a accepted-friend NOTHING for this row.
  // friend_daily must show it anyway, because accepting a friend request is
  // its own consent, independent of opted_in. This is the same call as the
  // positive control above; asserted again here, explicitly against a
  // confirmed-unpublished row, so this specific claim has its own named
  // failure rather than riding silently on the control above.
  await check('friend_daily: visible to a friend even though b is not opted in / the attempt is unpublished', async () => {
    const { data: profile } = await admin.from('profiles').select('opted_in').eq('user_id', b.userId).single()
    assert(profile.opted_in === false, 'fixture invariant broken: b must be opted_in = false for this assertion to mean anything')
    const { data: attemptRow } = await admin.from('daily_attempts').select('published')
      .eq('user_id', b.userId).eq('event', SENTINEL_EVENT_FRIEND_DAILY).eq('utc_day', today).single()
    assert(attemptRow.published === false, 'fixture invariant broken: the seeded attempt must be unpublished for this assertion to mean anything')

    const { data, error } = await a.client.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length === 1, `expected the unpublished result to still be visible to a friend, got ${(data ?? []).length} row(s)`)
    assert(data[0].time_ms === friendDailyTimeMs, `expected time_ms ${friendDailyTimeMs}, got ${data[0].time_ms}`)
  })

  // A revealed-but-unsubmitted attempt must not appear, even to a friend.
  await expectEmpty(
    'friend_daily: a revealed-but-unsubmitted attempt does not appear',
    a.client.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY_UNSUB,
    }),
  )

  // The row exposes exactly time and penalty -- no attempt id, revealed_at,
  // or scramble. Assert the exact column set, not a sampled value: a row
  // that happens to lack an id proves nothing about a row that has one.
  await check('friend_daily: the row exposes exactly time_ms and penalty, nothing else', async () => {
    const { data, error } = await a.client.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY,
    })
    assert(!error, `unexpected error ${error?.message}`)
    const keys = Object.keys(data[0]).sort()
    const expected = ['penalty', 'time_ms']
    assert(
      JSON.stringify(keys) === JSON.stringify(expected),
      `expected exactly columns ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
    )
  })

  // c has no friendship with b at all (at this point in the run: b<->c
  // pending is created later, below). If are_friends were removed from
  // friend_daily's WHERE, this returns b's real result instead of an empty
  // set, and fails.
  await expectEmpty(
    'friend_daily: a signed-in non-friend gets nothing',
    c.client.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY,
    }),
  )

  // Same reasoning as friend_calendar/friend_stats above: an anonymous
  // caller must be refused at the grant layer (permission denied), not
  // merely see zero rows -- an empty result would mean anon reached the
  // function body and are_friends(null, p_user) filtered it there, which is
  // exactly the shape of the earlier live hole on this branch (EXECUTE
  // granted to anon by Supabase's default privileges, `revoke ... from
  // public` alone left it standing). Only expectPermissionDenied proves
  // EXECUTE was actually revoked from anon.
  await expectPermissionDenied(
    'friend_daily: anon cannot execute the function at all (permission denied, not a filtered-empty result)',
    anon.rpc('friend_daily', {
      p_user: b.userId, p_event: SENTINEL_EVENT_FRIEND_DAILY,
    }),
  )

  // c has no friendship with b at all -- not pending, not accepted, nothing.
  // If are_friends were removed from friend_calendar's WHERE, this returns
  // b's one seeded day instead of an empty set, and fails.
  await expectEmpty(
    'friend_calendar: a stranger gets nothing',
    c.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    }),
  )

  // Same stranger, the other function. If the outer
  // `where public.are_friends(...)` were dropped from friend_stats (the
  // subtle construct called out above), this returns one row of real
  // aggregates instead of zero rows, and fails.
  await expectEmpty(
    'friend_stats: a stranger gets nothing',
    c.client.rpc('friend_stats', { p_user: b.userId, p_session: friendSessionId }),
  )

  // An anonymous caller holding only the public bundle, no session at all.
  // This used to be an expectEmpty on the grounds that auth.uid() is null
  // inside the function, so are_friends(null, b.userId) is false and the
  // body returns zero rows -- which is true, but beside the point: that
  // reasoning assumes anon can reach the function body at all. It could.
  // Supabase's default privileges (`alter default privileges in schema
  // public grant all on functions to anon, authenticated, service_role`)
  // grant EXECUTE to anon explicitly, per-role, at creation time, and
  // `revoke ... from public` -- the only revoke schema.sql issued -- does
  // not touch an explicit per-role grant. So anon could call
  // friend_calendar/friend_stats freely, and could call are_friends
  // directly with any two arbitrary uuids to learn whether two strangers
  // are friends, all while this assertion stayed green because "empty
  // result" was all it ever demanded. Retargeted (same calls, replacing
  // expectEmpty with expectPermissionDenied) to require the actual fix: a
  // bare 42501 rather than a result of any shape, empty or not. This is the
  // assertion that would have caught the live finding.
  await expectPermissionDenied(
    'friend_calendar: anon cannot execute the function at all (permission denied, not a filtered-empty result)',
    anon.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    }),
  )
  await expectPermissionDenied(
    'friend_stats: anon cannot execute the function at all (permission denied, not a filtered-empty result)',
    anon.rpc('friend_stats', { p_user: b.userId, p_session: friendSessionId }),
  )

  // are_friends is the relationship-oracle helper itself: called directly
  // with two arbitrary uuids (no shared session, no relationship to either
  // party required), it answers "are these two people friends" with no
  // filtering of its own -- that boundary is enforced entirely by nobody
  // being able to call it except the two security-definer functions running
  // as its owner. Revoked from anon AND authenticated (unlike
  // friend_calendar/friend_stats, which authenticated may call); both must
  // be checked, since a fix that only revoked from anon would leave a signed
  // in user free to probe arbitrary pairs.
  await expectPermissionDenied(
    'are_friends: anon cannot execute the relationship-oracle helper directly',
    anon.rpc('are_friends', { a: a.userId, b: b.userId }),
  )
  await expectPermissionDenied(
    'are_friends: an authenticated (but unrelated) caller cannot execute it directly either',
    c.client.rpc('are_friends', { a: a.userId, b: b.userId }),
  )

  // A PENDING request grants nothing -- only 'accepted' counts. b -> c is
  // requested but never accepted, so if are_friends only checked "a row
  // exists between these two users" rather than state = 'accepted', this
  // would leak and fail.
  await b.client.from('friendships')
    .insert({ requester: b.userId, addressee: c.userId, state: 'pending' })
    .throwOnError()
  await expectEmpty(
    'friend_calendar: a pending request grants no access',
    c.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    }),
  )

  // friend_solves' own pending-friend assertion lives HERE, not up in the
  // main friend_solves block above: at that earlier point in the run c's
  // only pending row was (a -> c), so c was merely a stranger to b and the
  // assertion would have stayed green even if are_friends counted pending
  // rows as friendship. The (b -> c) pending row seeded immediately above
  // is what actually isolates the state = 'accepted' requirement -- c has a
  // PENDING request to b, not an accepted one.
  await expectEmpty(
    'friend_solves: a pending friend sees nothing',
    c.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    }),
  )

  // Unfriending revokes immediately. This DESTROYS the (a, b, accepted) row
  // that every assertion above the "positive control" pair depends on, so it
  // must run LAST among the friend_calendar/friend_stats assertions -- any
  // assertion needing that friendship must already have run.
  await a.client.from('friendships').delete()
    .eq('requester', a.userId).eq('addressee', b.userId)
    .throwOnError()
  await expectEmpty(
    'friend_calendar: access stops the moment either party unfriends',
    a.client.rpc('friend_calendar', {
      p_user: b.userId, p_session: friendSessionId, p_since: '2000-01-01',
    }),
  )
  // The session list is the surface that discloses names, so it gets its own
  // proof that unfriending closes it -- not just the aggregates.
  await expectEmpty(
    'friend_sessions: the session list stops being visible the moment either party unfriends',
    a.client.rpc('friend_sessions', { p_user: b.userId }),
  )
} finally {
  // Removing the users cascades to their rows. Runs even on a thrown setup
  // or assertion error, so a failed run never orphans accounts. Each
  // deletion is independent: one failing (network blip, rate limit,
  // already deleted) must not stop the others from being attempted, and
  // must not change the script's exit code -- that reflects the
  // assertions, not this housekeeping.
  // deleteUser RESOLVES with { data, error } rather than throwing, so the
  // catch below never fires on an ordinary API failure -- the error has to be
  // read off the result. Trusting the catch alone let two throwaway accounts,
  // their profile row and a sentinel attempt survive a real run and sit in
  // production until they were found by hand.
  // Explicit, though the account cascade below would also remove these:
  // cleanup only warns on failure, and a leaked sentinel session is
  // invisible in normal use (its event id matches no real board or stats
  // view) but still a real orphaned row.
  if (friendEmptySessionId) {
    try {
      await admin.from('sessions').delete().eq('id', friendEmptySessionId).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture session ${friendEmptySessionId} — ${e.message}. Remove it manually.`)
    }
  }
  if (friendSessionId) {
    try {
      await admin.from('solves').delete().eq('session_id', friendSessionId).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture solve (session ${friendSessionId}) — ${e.message}. Remove it manually.`)
    }
    try {
      await admin.from('sessions').delete().eq('id', friendSessionId).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture session ${friendSessionId} — ${e.message}. Remove it manually.`)
    }
  }

  for (const userId of createdUserIds) {
    try {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) {
        console.warn(`WARNING: failed to delete throwaway account ${userId} — ${error.message}. Remove it manually.`)
      }
    } catch (e) {
      console.warn(`WARNING: failed to delete throwaway account ${userId} — ${e.message}. Remove it manually.`)
    }
  }

  // daily_scrambles rows aren't owned by a user, so deleting the throwaway
  // accounts above doesn't cascade to them -- they must be cleaned up
  // explicitly, or a sentinel fixture would linger and (harmlessly, since it
  // can never match a real event id) accumulate across runs. Filtered on the
  // exact (event, utc_day) this run inserted, never a broad delete, so this
  // can never remove a real scramble even if the sentinel constants above
  // were ever changed to something that collided.
  // Rows keyed to a throwaway account cascade away with it, but the account
  // deletion above only warns on failure -- so delete them explicitly too,
  // each independently, rather than trusting the cascade.
  for (const { user_id, event, utc_day } of seededAttempts) {
    try {
      await admin.from('daily_attempts').delete()
        .eq('user_id', user_id).eq('event', event).eq('utc_day', utc_day).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture daily_attempts row (${event}, ${utc_day}) — ${e.message}. Remove it manually.`)
    }
  }
  for (const { user_id, event, utc_day } of seededBests) {
    try {
      await admin.from('daily_bests').delete()
        .eq('user_id', user_id).eq('event', event).eq('utc_day', utc_day).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture daily_bests row (${event}, ${utc_day}) — ${e.message}. Remove it manually.`)
    }
  }
  for (const user_id of seededProfiles) {
    try {
      await admin.from('profiles').delete().eq('user_id', user_id).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture profiles row (${user_id}) — ${e.message}. Remove it manually.`)
    }
  }

  for (const { event, utc_day } of seededScrambles) {
    try {
      await admin.from('daily_scrambles').delete().eq('event', event).eq('utc_day', utc_day).throwOnError()
    } catch (e) {
      console.warn(`WARNING: failed to delete fixture daily_scrambles row (${event}, ${utc_day}) — ${e.message}. Remove it manually.`)
    }
  }
}

let failed = 0
for (const [ok, label] of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failed++
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`)
process.exit(failed ? 1 : 0)
