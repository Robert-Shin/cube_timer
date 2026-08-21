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
]
for (const { name, args } of REQUIRED_FUNCTIONS) {
  const { error } = await admin.rpc(name, args)
  if (error?.code === 'PGRST202') {
    console.error(`PREFLIGHT FAILED: required function "${name}" does not exist. Apply supabase/schema.sql before running the RLS harness.`)
    process.exit(1)
  }
}

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
      user_id: a.userId, username: `harness-${stamp}`, opted_in: false,
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
} finally {
  // Removing the users cascades to their rows. Runs even on a thrown setup
  // or assertion error, so a failed run never orphans accounts. Each
  // deletion is independent: one failing (network blip, rate limit,
  // already deleted) must not stop the others from being attempted, and
  // must not change the script's exit code -- that reflects the
  // assertions, not this housekeeping.
  for (const userId of createdUserIds) {
    try {
      await admin.auth.admin.deleteUser(userId)
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
