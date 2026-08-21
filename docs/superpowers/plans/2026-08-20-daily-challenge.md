# Daily Challenge and Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a daily shared-scramble challenge with an opt-in public leaderboard, without weakening the privacy guarantees the existing sync model depends on.

**Architecture:** A Supabase Edge Function generates one scramble per event per UTC day into a table no client may read. Clients reach a scramble only through a `security definer` RPC that records the commitment and returns the scramble in the same transaction, making reveal and commit inseparable. Results submit once and are immutable. The local-first store is untouched: challenge results are ordinary local solves, and submission is a separate write that queues and retries.

**Tech Stack:** Postgres + Row Level Security (Supabase), Deno Edge Function, cubing.js, React 19, TypeScript, vitest, `@supabase/supabase-js`.

**Spec:** `docs/superpowers/specs/2026-08-20-daily-challenge-design.md`

## Global Constraints

- **Day boundary is UTC**, always written `(now() at time zone 'utc')::date` in SQL. `current_date` follows the session timezone and must never be used for this.
- **`daily_scrambles` has no select policy, ever.** Reads happen only inside `security definer` functions.
- **The service_role key must never enter this repo** and must never be prefixed `VITE_` — Vite inlines `VITE_*` into the browser bundle. The harness reads `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`, which is gitignored.
- **Opting in governs publication, not participation.** `reveal_daily` never checks it; `submit_daily` and the `daily_bests` write policy do.
- **Every board query filters on `published`.**
- Challenge events are exactly: `222`, `333`, `444`, `555`, `666`, `777`, `minx`, `pyram`, `skewb`, `sq1`, `clock`.
- `supabase/schema.sql` is re-runnable: every statement guarded with `if not exists` or `drop policy if exists`. New statements follow that rule.
- Verify with `npm test` and `npm run build`. `npx tsc --noEmit` is a no-op in this repo — the root tsconfig is a solution file. Use `npm run build`.
- Node scripts live in `scripts/` and are run through npm scripts, following `scripts/apply-schema.mjs`.

---

### Task 1: Adversarial RLS harness

The harness must exist and prove itself against the *current* schema before any policy is relaxed. It mints two throwaway users with the admin API, then makes every assertion with ordinary anon-key clients — exactly what an attacker has.

**Files:**
- Create: `scripts/rls-harness.mjs`
- Modify: `package.json` (add `"rls": "node scripts/rls-harness.mjs"` to scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run rls`, exiting non-zero on the first failed assertion. Later tasks append assertion blocks to the same file. Helper signatures other tasks reuse: `asUser(email)` → `{ client, userId }`, `check(label, fn)` → records pass/fail, `expectEmpty(label, query)`, `expectError(label, query)`.

- [ ] **Step 1: Write the harness with its first assertions**

```js
#!/usr/bin/env node
/**
 * Adversarial Row Level Security harness.
 *
 * The anon key ships in the browser bundle, so RLS is the entire boundary
 * between one user's solves and everyone else. These assertions are written
 * from the attacker's side: two real accounts, ordinary anon-key clients,
 * and no privileged access except to create the accounts themselves.
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

await expectEmpty("B cannot read A's solves", b.client.from('solves').select('*').eq('user_id', a.userId))
await expectEmpty("B cannot read A's sessions", b.client.from('sessions').select('*').eq('user_id', a.userId))
await expectError(
  "B cannot write a solve attributed to A",
  b.client.from('solves').insert({ id: randomUUID(), user_id: a.userId, session_id: sessionId, scramble: 'x', time_ms: 1, created_at: nowIso, updated_at: nowIso }),
)

// Cleanup: removing the users cascades to their rows.
await admin.auth.admin.deleteUser(a.userId)
await admin.auth.admin.deleteUser(b.userId)

let failed = 0
for (const [ok, label] of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failed++
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`)
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`:

```json
"rls": "node scripts/rls-harness.mjs",
```

- [ ] **Step 3: Run it against the current schema**

Run: `npm run rls`
Expected: `3/3 assertions passed`. These policies already exist, so the harness passing here proves the harness itself works. If it fails, the harness is wrong — fix it before trusting any later assertion.

- [ ] **Step 4: Commit**

```bash
git add scripts/rls-harness.mjs package.json
git commit -m "Add an adversarial RLS harness driven by two real accounts"
```

---

### Task 2: Challenge tables and policies

**Files:**
- Modify: `supabase/schema.sql` (append)
- Modify: `scripts/rls-harness.mjs`

**Interfaces:**
- Consumes: `asUser`, `check`, `assert`, `expectEmpty`, `expectError` from Task 1.
- Produces: tables `daily_scrambles(event, utc_day, scramble, created_at)`, `daily_attempts(user_id, event, utc_day, revealed_at, submitted_at, time_ms, penalty, published)`, `daily_bests(user_id, event, utc_day, time_ms, scramble, updated_at, published)`, and a guarded minimal `profiles(user_id, username, opted_in, created_at)`.

- [ ] **Step 1: Append the schema**

Append to `supabase/schema.sql`:

```sql
-- ---------------------------------------------------------------- profiles
-- Phase 1 owns the profile UI and any further columns; this guarded block is
-- the minimum the daily challenge needs to exist against.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  opted_in    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------- daily challenge tables
-- One row per event per UTC day, written only by the Edge Function's service
-- role. There is deliberately no select policy: a client that could read this
-- table could practise the scramble before committing to its attempt.
create table if not exists public.daily_scrambles (
  event       text not null,
  utc_day     date not null,
  scramble    text not null,
  created_at  timestamptz not null default now(),
  primary key (event, utc_day)
);

create table if not exists public.daily_attempts (
  user_id       uuid not null references auth.users(id) on delete cascade,
  event         text not null,
  utc_day       date not null,
  revealed_at   timestamptz not null default now(),
  submitted_at  timestamptz,
  time_ms       integer,
  penalty       text not null default 'none'
                  check (penalty in ('none', 'plus2', 'dnf')),
  published     boolean not null default false,
  primary key (user_id, event, utc_day)
);

create table if not exists public.daily_bests (
  user_id     uuid not null references auth.users(id) on delete cascade,
  event       text not null,
  utc_day     date not null,
  time_ms     integer not null,
  scramble    text not null default '',
  updated_at  timestamptz not null,
  published   boolean not null default false,
  primary key (user_id, event, utc_day)
);

create index if not exists daily_attempts_board
  on public.daily_attempts (event, utc_day, time_ms)
  where published and submitted_at is not null and penalty <> 'dnf';
create index if not exists daily_bests_board
  on public.daily_bests (event, utc_day, time_ms)
  where published;

alter table public.profiles        enable row level security;
alter table public.daily_scrambles enable row level security;
alter table public.daily_attempts  enable row level security;
alter table public.daily_bests     enable row level security;

-- Usernames are public so a board can name people. Nothing else is: the
-- email lives in auth.users, which PostgREST does not expose.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- daily_scrambles: no policy at all. RLS with zero policies denies everything,
-- which is the intent. security definer functions bypass it.

drop policy if exists attempts_select_own on public.daily_attempts;
create policy attempts_select_own on public.daily_attempts
  for select using (auth.uid() = user_id);

-- A revealed-but-unsubmitted attempt stays private, so an unfinished solve is
-- not visible to anyone as a gap.
drop policy if exists attempts_select_board on public.daily_attempts;
create policy attempts_select_board on public.daily_attempts
  for select using (published and submitted_at is not null);

-- No insert/update/delete policy: writes go only through the functions.

drop policy if exists bests_select_own on public.daily_bests;
create policy bests_select_own on public.daily_bests
  for select using (auth.uid() = user_id);

drop policy if exists bests_select_board on public.daily_bests;
create policy bests_select_board on public.daily_bests
  for select using (published);

-- `not published or opted_in`: without this a client could publish its own
-- row by setting the column, bypassing the opt-in entirely.
drop policy if exists bests_write_own on public.daily_bests;
create policy bests_write_own on public.daily_bests
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      not published
      or exists (select 1 from public.profiles p
                 where p.user_id = auth.uid() and p.opted_in)
    )
  );
```

- [ ] **Step 2: Add the assertions that must fail before the schema is applied**

In `scripts/rls-harness.mjs`, insert before the cleanup block:

```js
const today = new Date().toISOString().slice(0, 10)

await expectEmpty(
  'nobody can select daily_scrambles directly',
  b.client.from('daily_scrambles').select('*'),
)

// A has revealed but not submitted.
await admin.from('daily_attempts').insert({
  user_id: a.userId, event: '333', utc_day: today,
}).throwOnError()

await expectEmpty(
  "B cannot see A's unsubmitted attempt",
  b.client.from('daily_attempts').select('*').eq('user_id', a.userId),
)

await check('a published submitted attempt is visible to B', async () => {
  await admin.from('daily_attempts')
    .update({ submitted_at: new Date().toISOString(), time_ms: 9990, published: true })
    .eq('user_id', a.userId).eq('event', '333').eq('utc_day', today)
    .throwOnError()
  const { data, error } = await b.client
    .from('daily_attempts').select('time_ms')
    .eq('user_id', a.userId).eq('event', '333')
  assert(!error, `unexpected error ${error?.message}`)
  assert(data.length === 1 && data[0].time_ms === 9990, 'published attempt was not readable')
})

await expectError(
  'B cannot write an attempt at all',
  b.client.from('daily_attempts').insert({ user_id: b.userId, event: '333', utc_day: today }),
)

await expectError(
  'a user who has not opted in cannot publish a daily best',
  b.client.from('daily_bests').insert({
    user_id: b.userId, event: '333', utc_day: today,
    time_ms: 8000, updated_at: new Date().toISOString(), published: true,
  }),
)

await check('the same row is accepted unpublished', async () => {
  const { error } = await b.client.from('daily_bests').insert({
    user_id: b.userId, event: '333', utc_day: today,
    time_ms: 8000, updated_at: new Date().toISOString(), published: false,
  })
  assert(!error, `rejected an unpublished own-row write: ${error?.message}`)
})

await check('no query path returns an email address', async () => {
  const { data } = await b.client.from('profiles').select('*')
  for (const row of data ?? []) {
    assert(!('email' in row), 'profiles exposed an email column')
  }
})
```

- [ ] **Step 3: Run the harness and watch the new assertions fail**

Run: `npm run rls`
Expected: FAIL — the `daily_*` tables do not exist yet, so those assertions error. The three Task 1 assertions still pass.

- [ ] **Step 4: Apply the schema**

Run: `npm run schema`
Expected: applies without error and is safe to re-run.

- [ ] **Step 5: Run the harness again**

Run: `npm run rls`
Expected: every assertion passes.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql scripts/rls-harness.mjs
git commit -m "Add daily challenge tables with publication-gated policies"
```

---

### Task 3: `reveal_daily` and `submit_daily`

**Files:**
- Modify: `supabase/schema.sql` (append)
- Modify: `scripts/rls-harness.mjs`

**Interfaces:**
- Consumes: tables from Task 2.
- Produces: RPCs `reveal_daily(p_event text)` returning `(scramble text, revealed_at timestamptz, submitted boolean)`, and `submit_daily(p_event text, p_time_ms integer, p_penalty text)` returning `void`. The client calls these as `supabase.rpc('reveal_daily', { p_event })` and `supabase.rpc('submit_daily', { p_event, p_time_ms, p_penalty })`.

- [ ] **Step 1: Append the functions**

Append to `supabase/schema.sql`:

```sql
-- ------------------------------------------------------ challenge functions
-- security definer: these run as the owner and bypass RLS, which is the only
-- way to hand out a scramble and record the commitment in one transaction.
-- search_path is pinned so a caller cannot shadow a referenced object.

create or replace function public.reveal_daily(p_event text)
returns table (scramble text, revealed_at timestamptz, submitted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  -- Opting in governs publication, not participation: someone may take the
  -- daily privately, so this deliberately does not check profiles.opted_in.

  insert into public.daily_attempts (user_id, event, utc_day)
  values (v_uid, p_event, v_day)
  on conflict (user_id, event, utc_day) do nothing;

  return query
  select s.scramble, a.revealed_at, a.submitted_at is not null
  from public.daily_attempts a
  join public.daily_scrambles s
    on s.event = a.event and s.utc_day = a.utc_day
  where a.user_id = v_uid and a.event = p_event and a.utc_day = v_day;
end;
$$;

create or replace function public.submit_daily(
  p_event text, p_time_ms integer, p_penalty text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_attempt public.daily_attempts%rowtype;
  v_opted boolean;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if p_penalty not in ('none', 'plus2', 'dnf') then
    raise exception 'unknown penalty %', p_penalty;
  end if;

  select * into v_attempt from public.daily_attempts
  where user_id = v_uid and event = p_event and utc_day = v_day;

  if not found then
    raise exception 'no attempt: reveal the scramble first';
  end if;
  if v_attempt.submitted_at is not null then
    -- Custom SQLSTATE, not just a message: the client decides "the first
    -- write won, stop retrying" from this, and matching on message text
    -- would silently retry forever the day the wording changed.
    raise exception 'already submitted' using errcode = 'CS001';
  end if;
  -- Impossible rather than merely suspicious: no solve can be longer than the
  -- wall clock since the scramble was handed out.
  if p_time_ms > extract(epoch from (now() - v_attempt.revealed_at)) * 1000 then
    raise exception 'submitted time exceeds elapsed time since reveal';
  end if;

  select coalesce(opted_in, false) into v_opted
  from public.profiles where user_id = v_uid;

  update public.daily_attempts
  set submitted_at = now(),
      time_ms      = p_time_ms,
      penalty      = p_penalty,
      published    = coalesce(v_opted, false)
  where user_id = v_uid and event = p_event and utc_day = v_day;
end;
$$;

revoke all on function public.reveal_daily(text) from public;
revoke all on function public.submit_daily(text, integer, text) from public;
grant execute on function public.reveal_daily(text) to authenticated;
grant execute on function public.submit_daily(text, integer, text) to authenticated;
```

- [ ] **Step 2: Add the function assertions**

In `scripts/rls-harness.mjs`, before the cleanup block:

```js
// A scramble must exist for the day before reveal can return one.
await admin.from('daily_scrambles')
  .upsert({ event: '444', utc_day: today, scramble: 'R U R2 Fw2 Uw' })
  .throwOnError()

await check('reveal returns the scramble and creates the commitment', async () => {
  const { data, error } = await b.client.rpc('reveal_daily', { p_event: '444' })
  assert(!error, `reveal failed: ${error?.message}`)
  assert(data[0].scramble === 'R U R2 Fw2 Uw', 'wrong scramble returned')
  assert(data[0].submitted === false, 'a fresh attempt claimed to be submitted')
})

await check('revealing twice is idempotent and returns the same scramble', async () => {
  const { data, error } = await b.client.rpc('reveal_daily', { p_event: '444' })
  assert(!error, `second reveal failed: ${error?.message}`)
  assert(data[0].scramble === 'R U R2 Fw2 Uw', 'second reveal changed the scramble')
})

await check('submitting with no attempt is rejected', async () => {
  const { error } = await b.client.rpc('submit_daily', {
    p_event: '555', p_time_ms: 30000, p_penalty: 'none',
  })
  assert(!!error, 'submitted for an event that was never revealed')
})

await check('a time longer than the elapsed wall clock is rejected', async () => {
  const { error } = await b.client.rpc('submit_daily', {
    p_event: '444', p_time_ms: 86_400_000, p_penalty: 'none',
  })
  assert(!!error, 'accepted a 24-hour solve seconds after reveal')
})

await check('the first submission is accepted', async () => {
  const { error } = await b.client.rpc('submit_daily', {
    p_event: '444', p_time_ms: 41230, p_penalty: 'none',
  })
  assert(!error, `first submission rejected: ${error?.message}`)
})

await check('a second submission is rejected', async () => {
  const { error } = await b.client.rpc('submit_daily', {
    p_event: '444', p_time_ms: 9999, p_penalty: 'none',
  })
  assert(!!error, 'a result was overwritten — it must be immutable')
})

await check('a result from a user who has not opted in stays unpublished', async () => {
  const { data } = await admin.from('daily_attempts').select('published')
    .eq('user_id', b.userId).eq('event', '444').eq('utc_day', today)
  assert(data[0].published === false, 'published without opting in')
})
```

- [ ] **Step 3: Run the harness and watch the new assertions fail**

Run: `npm run rls`
Expected: FAIL — the functions do not exist yet (`Could not find the function public.reveal_daily`).

- [ ] **Step 4: Apply the schema**

Run: `npm run schema`

- [ ] **Step 5: Run the harness again**

Run: `npm run rls`
Expected: every assertion passes.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql scripts/rls-harness.mjs
git commit -m "Add reveal and submit functions with one-attempt enforcement"
```

---

### Task 4: Spike cubing.js under Deno

The spec flags this as the largest unknown, and this project has already shipped a broken build once because cubing.js behaved differently under a bundler. Find out before building on it. **This task's output is an answer, not code to keep.**

**Files:**
- Create: `scratch/deno-spike.ts` (throwaway, not committed)

**Interfaces:**
- Consumes: nothing.
- Produces: a decision recorded in the plan — either "Edge Function generates scrambles" or the fallback in Task 5's note.

- [ ] **Step 1: Write the smallest possible probe**

```ts
// scratch/deno-spike.ts — throwaway
import { randomScrambleForEvent } from 'npm:cubing@0.63.3/scramble'

const started = Date.now()
const alg = await randomScrambleForEvent('444')
console.log(alg.toString())
console.log(`generated in ${Date.now() - started}ms`)
```

- [ ] **Step 2: Run it**

Run: `deno run --allow-net --allow-read scratch/deno-spike.ts`
Expected: a valid 4x4 scramble and a timing. A wasm or worker error here is the finding.

- [ ] **Step 3: Record the outcome**

If it works, continue to Task 5 unchanged. If it fails, **stop and report** — the fallback is to generate scrambles in a scheduled GitHub Action that writes to Supabase with the service role, which avoids Deno entirely and is a change of deployment target, not of schema. Do not attempt Task 5 against a broken runtime.

- [ ] **Step 4: Delete the spike**

```bash
rm scratch/deno-spike.ts
```

No commit: a spike's output is knowledge.

---

### Task 5: Edge Function generating the day's scrambles

**Files:**
- Create: `supabase/functions/daily-scrambles/index.ts`
- Create: `supabase/functions/daily-scrambles/README.md`

**Interfaces:**
- Consumes: `daily_scrambles` from Task 2.
- Produces: an HTTP endpoint that upserts today's scramble for every challenge event and is safe to call repeatedly.

- [ ] **Step 1: Write the function**

```ts
/**
 * Generates one scramble per challenge event for the current UTC day.
 *
 * Scrambles cannot come from clients: a client-supplied "scramble" could be
 * four moves from solved, and Postgres cannot validate one without a solver.
 * This runs with the service role, which is the only writer of the table.
 *
 * Idempotent: `ignoreDuplicates` means a re-run never replaces a scramble
 * someone has already been given.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { randomScrambleForEvent } from 'npm:cubing@0.63.3/scramble'

const EVENTS = ['222', '333', '444', '555', '666', '777', 'minx', 'pyram', 'skewb', 'sq1', 'clock']

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const utcDay = new Date().toISOString().slice(0, 10)

  const rows = []
  for (const event of EVENTS) {
    const alg = await randomScrambleForEvent(event)
    rows.push({ event, utc_day: utcDay, scramble: alg.toString() })
  }

  const { error } = await supabase
    .from('daily_scrambles')
    .upsert(rows, { onConflict: 'event,utc_day', ignoreDuplicates: true })

  if (error) return new Response(error.message, { status: 500 })
  return Response.json({ utcDay, generated: rows.length })
})
```

- [ ] **Step 2: Write the deployment note**

`supabase/functions/daily-scrambles/README.md`:

```markdown
# daily-scrambles

Generates the shared scramble for each challenge event, once per UTC day.

    supabase functions deploy daily-scrambles

Schedule it just after 00:00 UTC (Supabase dashboard > Database > Cron):

    select cron.schedule(
      'daily-scrambles', '5 0 * * *',
      $$select net.http_post(
          url := 'https://<project>.supabase.co/functions/v1/daily-scrambles',
          headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb
        )$$
    );

`SUPABASE_SERVICE_ROLE_KEY` is injected by the platform. It must never be
committed, and never given a `VITE_` prefix — Vite inlines `VITE_*` into the
public browser bundle.

Re-running is safe: existing rows are left alone, so a scramble someone has
already been shown is never swapped underneath them.
```

- [ ] **Step 3: Deploy and invoke once**

Run: `supabase functions deploy daily-scrambles` then invoke the URL.
Expected: `{"utcDay":"…","generated":11}`.

- [ ] **Step 4: Verify the rows landed and stay put**

Run the invocation a second time, then in the SQL editor:

```sql
select event, utc_day, left(scramble, 20) from daily_scrambles
where utc_day = (now() at time zone 'utc')::date order by event;
```

Expected: 11 rows, and `created_at` unchanged by the second invocation.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/daily-scrambles
git commit -m "Generate the day's shared scrambles in an edge function"
```

---

### Task 6: UTC day and best-of-day, as pure functions

**Files:**
- Create: `src/daily.ts`
- Create: `src/daily.test.ts`

**Interfaces:**
- Consumes: `Solve` and `effectiveMs` from `src/types.ts`.
- Produces: `utcDay(at: number): string` (→ `'2026-08-20'`) and `bestOfDay(solves: Solve[], event: EventId, day: string): { solve: Solve; ms: number } | null`. Task 8 consumes both.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { bestOfDay, utcDay } from './daily'
import type { Solve } from './types'

const solve = (over: Partial<Solve>): Solve => ({
  id: 'x', sessionId: 's', scramble: 'R U', timeMs: 10000,
  penalty: 'none', createdAt: Date.UTC(2026, 7, 20, 12), updatedAt: 0, ...over,
})

describe('utcDay', () => {
  it('formats as an ISO date', () => {
    expect(utcDay(Date.UTC(2026, 7, 20, 12))).toBe('2026-08-20')
  })

  it('uses UTC, not the local timezone, either side of midnight', () => {
    expect(utcDay(Date.UTC(2026, 7, 20, 23, 59))).toBe('2026-08-20')
    expect(utcDay(Date.UTC(2026, 7, 21, 0, 1))).toBe('2026-08-21')
  })
})

describe('bestOfDay', () => {
  const day = '2026-08-20'

  it('returns the fastest solve of that day', () => {
    const list = [
      solve({ id: 'a', timeMs: 12000 }),
      solve({ id: 'b', timeMs: 9000 }),
      solve({ id: 'c', timeMs: 11000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('b')
  })

  it('ignores solves from other days', () => {
    const list = [
      solve({ id: 'yesterday', timeMs: 5000, createdAt: Date.UTC(2026, 7, 19, 12) }),
      solve({ id: 'today', timeMs: 9000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('today')
  })

  it('excludes DNFs and deleted solves', () => {
    const list = [
      solve({ id: 'dnf', timeMs: 1000, penalty: 'dnf' }),
      solve({ id: 'gone', timeMs: 2000, deleted: true }),
      solve({ id: 'real', timeMs: 9000 }),
    ]
    expect(bestOfDay(list, '333', day)?.solve.id).toBe('real')
  })

  it('ranks on the +2-adjusted time, not the raw one', () => {
    const list = [
      solve({ id: 'penalised', timeMs: 9000, penalty: 'plus2' }), // 11.00
      solve({ id: 'clean', timeMs: 10000 }),                      // 10.00
    ]
    const best = bestOfDay(list, '333', day)
    expect(best?.solve.id).toBe('clean')
    expect(best?.ms).toBe(10000)
  })

  it('returns null when the day has no usable solve', () => {
    expect(bestOfDay([], '333', day)).toBeNull()
    expect(bestOfDay([solve({ penalty: 'dnf' })], '333', day)).toBeNull()
  })
})
```

Note: `bestOfDay` takes solves already filtered to one event by the caller in Task 8; the `event` parameter is carried for the returned shape and for future per-event filtering. Keep the signature as specified so Task 8 compiles against it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './daily'`.

- [ ] **Step 3: Implement**

```ts
import { effectiveMs, type EventId, type Solve } from './types'

/** The UTC calendar day a timestamp falls in, as 'YYYY-MM-DD'. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * The fastest usable solve of one UTC day, ranked on the +2-adjusted time so
 * a penalised solve cannot beat a clean one it was actually slower than.
 */
export function bestOfDay(
  solves: Solve[],
  _event: EventId,
  day: string,
): { solve: Solve; ms: number } | null {
  let best: { solve: Solve; ms: number } | null = null
  for (const s of solves) {
    if (s.deleted || s.penalty === 'dnf') continue
    if (utcDay(s.createdAt) !== day) continue
    const ms = effectiveMs(s)
    if (ms === null) continue
    if (!best || ms < best.ms) best = { solve: s, ms }
  }
  return best
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daily.ts src/daily.test.ts
git commit -m "Add UTC day and best-of-day helpers for the daily challenge"
```

---

### Task 7: The submission queue

A submission must never be lost to a dropped connection, and must never be sent twice. The queue is pure logic over a serialisable value, so it is fully testable.

**Files:**
- Create: `src/dailyQueue.ts`
- Create: `src/dailyQueue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PendingSubmission = { event: EventId; day: string; timeMs: number; penalty: Penalty }`, `enqueue(queue, item)`, `dropSettled(queue, event, day)`, `loadQueue()`, `saveQueue(queue)`. Task 8 consumes all of them.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { dropSettled, enqueue, type PendingSubmission } from './dailyQueue'

const item = (over: Partial<PendingSubmission> = {}): PendingSubmission => ({
  event: '333', day: '2026-08-20', timeMs: 12000, penalty: 'none', ...over,
})

describe('enqueue', () => {
  it('adds a submission', () => {
    expect(enqueue([], item())).toHaveLength(1)
  })

  it('never queues two submissions for the same event and day', () => {
    // One attempt means one result: a second entry could only ever be
    // rejected by the server, and would retry forever.
    const queue = enqueue([item({ timeMs: 12000 })], item({ timeMs: 9000 }))
    expect(queue).toHaveLength(1)
    expect(queue[0].timeMs).toBe(12000)
  })

  it('keeps submissions for different events and different days apart', () => {
    let queue = enqueue([], item({ event: '333' }))
    queue = enqueue(queue, item({ event: '444' }))
    queue = enqueue(queue, item({ event: '333', day: '2026-08-21' }))
    expect(queue).toHaveLength(3)
  })
})

describe('dropSettled', () => {
  it('removes the entry once the server has it', () => {
    const queue = enqueue([], item())
    expect(dropSettled(queue, '333', '2026-08-20')).toHaveLength(0)
  })

  it('leaves other entries alone', () => {
    let queue = enqueue([], item({ event: '333' }))
    queue = enqueue(queue, item({ event: '444' }))
    expect(dropSettled(queue, '333', '2026-08-20').map((q) => q.event)).toEqual(['444'])
  })

  it('is safe to call for something not queued', () => {
    expect(dropSettled([], '333', '2026-08-20')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './dailyQueue'`.

- [ ] **Step 3: Implement**

```ts
import type { EventId, Penalty } from './types'

/**
 * A challenge result recorded locally but not yet accepted by the server.
 *
 * The attempt row already exists server-side by the time anything is queued,
 * so a retry can always complete. An "already submitted" rejection is a
 * success from the queue's point of view: the first write won.
 */
export interface PendingSubmission {
  event: EventId
  day: string
  timeMs: number
  penalty: Penalty
}

const KEY = 'cube-timer.daily-queue.v1'

/** One attempt means one result, so an existing entry is never replaced. */
export function enqueue(
  queue: PendingSubmission[],
  item: PendingSubmission,
): PendingSubmission[] {
  const exists = queue.some((q) => q.event === item.event && q.day === item.day)
  return exists ? queue : [...queue, item]
}

export function dropSettled(
  queue: PendingSubmission[],
  event: EventId,
  day: string,
): PendingSubmission[] {
  return queue.filter((q) => !(q.event === event && q.day === day))
}

export function loadQueue(): PendingSubmission[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as PendingSubmission[]) : []
  } catch {
    return []
  }
}

export function saveQueue(queue: PendingSubmission[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue))
  } catch {
    // A lost queue costs one unsubmitted result, never a lost solve: the
    // solve itself is already in the store.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dailyQueue.ts src/dailyQueue.test.ts
git commit -m "Add a submission queue that survives a dropped connection"
```

---

### Task 8: The daily client module

The single place that talks to Supabase about the challenge. Kept out of `App.tsx`, which is already large.

**Files:**
- Create: `src/dailyClient.ts`

**Interfaces:**
- Consumes: `supabase` from `src/supabase.ts`; `utcDay`, `bestOfDay` from Task 6; the queue from Task 7; `reveal_daily`/`submit_daily` from Task 3.
- Produces: `revealDaily(event)` → `Reveal`, `submitDaily(event, timeMs, penalty)` → `'accepted' | 'settled' | 'retry'`, `recordChallengeResult(event, timeMs, penalty)` → `void` (submits, queueing on failure — this is what Task 9 calls), `flushQueue()` → `void`, `publishBestOfDay(solves, event)` → `void`, `fetchBoard(event, day)` → `BoardRow[]`, and the exported types `Reveal` and `BoardRow`.

- [ ] **Step 1: Write the module**

```ts
import { supabase } from './supabase'
import { utcDay, bestOfDay } from './daily'
import { dropSettled, enqueue, loadQueue, saveQueue } from './dailyQueue'
import type { EventId, Penalty, Solve } from './types'

export interface BoardRow {
  username: string
  challengeMs: number | null
  challengePenalty: Penalty
  bestMs: number | null
  isSelf: boolean
}

export interface Reveal {
  scramble: string
  revealedAt: string
  submitted: boolean
}

/**
 * Commits to today's attempt and returns the scramble. Reveal *is* the
 * commitment: there is no way to read the scramble without the attempt row
 * existing, which is what makes one-attempt enforceable.
 */
export async function revealDaily(event: EventId): Promise<Reveal> {
  if (!supabase) throw new Error('not configured')
  const { data, error } = await supabase.rpc('reveal_daily', { p_event: event })
  if (error) throw error
  const row = data?.[0]
  if (!row) throw new Error('no scramble has been generated for today yet')
  return { scramble: row.scramble, revealedAt: row.revealed_at, submitted: row.submitted }
}

/**
 * 'accepted' — the server took it.
 * 'settled'  — it was already submitted; the first write won, stop retrying.
 * 'retry'    — transport failure; the caller queues it.
 */
export async function submitDaily(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<'accepted' | 'settled' | 'retry'> {
  if (!supabase) return 'retry'
  const { error } = await supabase.rpc('submit_daily', {
    p_event: event,
    p_time_ms: Math.round(timeMs),
    p_penalty: penalty,
  })
  if (!error) return 'accepted'
  return /already submitted/i.test(error.message) ? 'settled' : 'retry'
}

/** Retries every queued submission. Safe to call on any sync tick. */
export async function flushQueue(): Promise<void> {
  let queue = loadQueue()
  if (queue.length === 0) return
  for (const item of [...queue]) {
    const outcome = await submitDaily(item.event, item.timeMs, item.penalty)
    if (outcome === 'accepted' || outcome === 'settled') {
      queue = dropSettled(queue, item.event, item.day)
    }
  }
  saveQueue(queue)
}

/** Records a result locally-first, then tries the network. */
export async function recordChallengeResult(
  event: EventId,
  timeMs: number,
  penalty: Penalty,
): Promise<void> {
  const day = utcDay(Date.now())
  const outcome = await submitDaily(event, timeMs, penalty)
  if (outcome === 'retry') {
    saveQueue(enqueue(loadQueue(), { event, day, timeMs, penalty }))
  }
}

/**
 * Publishes the best ordinary solve of today. Derived from local state every
 * time, so deleting or DNF-ing the underlying solve corrects the row on the
 * next call with no separate retraction path.
 */
export async function publishBestOfDay(solves: Solve[], event: EventId): Promise<void> {
  if (!supabase) return
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id
  if (!userId) return

  const day = utcDay(Date.now())
  const best = bestOfDay(solves, event, day)
  const { data: profile } = await supabase
    .from('profiles').select('opted_in').eq('user_id', userId).maybeSingle()

  if (!best) {
    await supabase.from('daily_bests')
      .delete().eq('user_id', userId).eq('event', event).eq('utc_day', day)
    return
  }

  await supabase.from('daily_bests').upsert({
    user_id: userId,
    event,
    utc_day: day,
    time_ms: Math.round(best.ms),
    scramble: best.solve.scramble,
    updated_at: new Date().toISOString(),
    published: profile?.opted_in ?? false,
  })
}

export async function fetchBoard(event: EventId, day: string): Promise<BoardRow[]> {
  if (!supabase) return []
  const { data: auth } = await supabase.auth.getUser()
  const self = auth.user?.id ?? null

  const [attempts, bests] = await Promise.all([
    supabase.from('daily_attempts')
      .select('user_id, time_ms, penalty')
      .eq('event', event).eq('utc_day', day)
      .eq('published', true).not('submitted_at', 'is', null),
    supabase.from('daily_bests')
      .select('user_id, time_ms')
      .eq('event', event).eq('utc_day', day).eq('published', true),
  ])

  const rows = attempts.data ?? []
  if (rows.length === 0) return []

  // Usernames come from a second query rather than an embedded select:
  // daily_attempts has no foreign key to profiles -- both reference
  // auth.users -- so PostgREST cannot embed one in the other. It also lets a
  // user who has never claimed a username still appear on the board.
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, username')
    .in('user_id', rows.map((r) => r.user_id))

  const nameByUser = new Map((profiles ?? []).map((p) => [p.user_id, p.username]))
  const bestByUser = new Map((bests.data ?? []).map((r) => [r.user_id, r.time_ms]))

  return rows
    .map((r) => ({
      username: nameByUser.get(r.user_id) ?? 'anonymous',
      challengeMs: r.penalty === 'dnf' ? null : r.time_ms,
      challengePenalty: r.penalty as Penalty,
      bestMs: bestByUser.get(r.user_id) ?? null,
      isSelf: r.user_id === self,
    }))
    .sort((a, b) => (a.challengeMs ?? Infinity) - (b.challengeMs ?? Infinity))
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: builds clean. (`npx tsc --noEmit` is a no-op here — the root tsconfig only holds project references.)

- [ ] **Step 3: Commit**

```bash
git add src/dailyClient.ts
git commit -m "Add the daily challenge client module"
```

---

### Task 9: Challenge mode in the timer

**Files:**
- Create: `src/DailyChallenge.tsx`
- Modify: `src/App.tsx` (add a `'daily'` tab alongside `'timer'` and `'stats'`)
- Modify: `src/index.css` (append)

**Interfaces:**
- Consumes: `revealDaily`, `recordChallengeResult` from Task 8; `useTimer` from `src/useTimer.ts`.
- Produces: a `<DailyChallenge event={…} onRecord={…} />` component. `onRecord(timeMs)` lets `App` write the solve into the local store exactly like any other solve.

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react'
import type { EventId, Penalty } from './types'
import { formatMs } from './format'
import { recordChallengeResult, revealDaily, type Reveal } from './dailyClient'
import { useTimer } from './useTimer'

/**
 * One committed attempt at the day's shared scramble.
 *
 * The scramble is not fetched until the button is pressed, so it cannot be
 * read from devtools before committing. Everything after that point is
 * deliberately one-way.
 */
export function DailyChallenge({
  event,
  onRecord,
}: {
  event: EventId
  onRecord: (timeMs: number, scramble: string) => void
}) {
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [result, setResult] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const finish = (elapsed: number) => {
    setResult(elapsed)
    if (reveal) onRecord(elapsed, reveal.scramble)
    void recordChallengeResult(event, elapsed, 'none' as Penalty)
  }

  const { state, display } = useTimer(finish, reveal !== null && result === null)

  const start = async () => {
    setError(null)
    try {
      const r = await revealDaily(event)
      setReveal(r)
      if (r.submitted) setResult(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the server')
    }
  }

  if (!reveal) {
    return (
      <div className="challenge">
        <h2>Daily challenge</h2>
        <p className="note">
          One attempt at the same scramble everyone else gets. Revealing it commits you —
          whatever you record is your result for today, including a DNF.
        </p>
        <button className="primary" onClick={start}>
          Reveal and start
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="challenge">
      <p className="scramble">{reveal.scramble}</p>
      <div className={`timer state-${state}`}>{formatMs(result ?? display)}</div>
      <p className="hint">
        {result !== null ? 'Submitted. Come back tomorrow.' : 'Hold space to start'}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Add the tab in `App.tsx`**

The Daily tab must only exist when Supabase is configured. `revealDaily`
throws when the client is null, and an unconfigured clone should not offer a
tab that can only report an error — the app already hides sign-in the same
way. Gate both the button and the branch on the existing `syncConfigured`
import from `./supabase`.

Widen the tab state and add the button beside Timer and Stats:

```tsx
const [tab, setTab] = useState<'timer' | 'stats' | 'daily'>('timer')
```

```tsx
<button className={tab === 'daily' ? 'active' : ''} onClick={() => setTab('daily')}>
  Daily
</button>
```

In the stage, alongside the existing branches:

```tsx
{tab === 'daily' && (
  <DailyChallenge
    event={session.event}
    onRecord={(timeMs, scramble) => {
      // An ordinary local solve: no new column on `solves`, because the
      // attempt row is the authoritative record of the challenge.
      setStore((prev) => ({
        ...prev,
        solves: [
          {
            id: crypto.randomUUID(),
            sessionId: session.id,
            scramble,
            timeMs,
            penalty: 'none' as Penalty,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            parity: [] as ParityId[],
          },
          ...prev.solves,
        ],
      }))
    }}
  />
)}
```

- [ ] **Step 3: Append the styles**

```css
/* ---- daily challenge --------------------------------------------------- */
.challenge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  text-align: center;
  max-width: 46ch;
  margin: 0 auto;
}
.challenge h2 { font-size: var(--t-lg); font-weight: 600; color: var(--text); margin: 0; }
```

- [ ] **Step 4: Verify against the built output**

Run: `npm run build && npx vite preview`
Then, in a real browser (headless cannot be trusted for this app's async work — drive Chrome over `--remote-debugging-port` and poll the DOM):
1. Open the Daily tab. Confirm the scramble is **not** in the DOM before pressing the button.
2. Press Reveal and start; confirm a scramble appears.
3. Reload; confirm the same scramble comes back and the attempt was not duplicated.
4. Solve, and confirm the result submits and the local solve list gains a row.

- [ ] **Step 5: Commit**

```bash
git add src/DailyChallenge.tsx src/App.tsx src/index.css
git commit -m "Add the daily challenge tab with a committed reveal"
```

---

### Task 10: The board

**Files:**
- Create: `src/Leaderboard.tsx`
- Modify: `src/DailyChallenge.tsx` (show the board once the attempt is settled)
- Modify: `src/index.css` (append)

**Interfaces:**
- Consumes: `fetchBoard`, `BoardRow` from Task 8; `utcDay` from Task 6.
- Produces: `<Leaderboard event={…} />`.

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react'
import type { EventId } from './types'
import { formatMs } from './format'
import { utcDay } from './daily'
import { fetchBoard, type BoardRow } from './dailyClient'

/** Ranked on the shared scramble; "best today" is shown but never ranked. */
export function Leaderboard({ event }: { event: EventId }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null)
  const day = utcDay(Date.now())

  useEffect(() => {
    let live = true
    fetchBoard(event, day).then((r) => live && setRows(r))
    return () => {
      live = false
    }
  }, [event, day])

  if (rows === null) return <p className="note">Loading the board…</p>
  if (rows.length === 0) return <p className="empty">Nobody has posted a time today.</p>

  return (
    <table className="figures board">
      <thead>
        <tr>
          <th />
          <th />
          <th>daily</th>
          <th>best today</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.username} className={r.isSelf ? 'self' : ''}>
            <th>{i + 1}</th>
            <th>{r.username}</th>
            <td>{r.challengeMs === null ? 'DNF' : formatMs(r.challengeMs)}</td>
            <td className="hi">{r.bestMs === null ? '—' : formatMs(r.bestMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 2: Show it after the attempt settles**

In `DailyChallenge.tsx`, inside the settled branch, below the hint:

```tsx
{result !== null && <Leaderboard event={event} />}
```

- [ ] **Step 3: Append the styles**

```css
.board { margin-top: var(--sp-4); }
.board tbody th:nth-child(2) { text-align: left; color: var(--text); font-weight: 500; }
.board tr.self th, .board tr.self td { color: var(--pb); }
```

- [ ] **Step 4: Verify with two accounts**

Run the app against two signed-in accounts (the harness's users work), submit a result from each, and confirm:
- Both appear, sorted fastest first.
- An account that has not opted in does **not** appear.
- Your own row is highlighted.

- [ ] **Step 5: Commit**

```bash
git add src/Leaderboard.tsx src/DailyChallenge.tsx src/index.css
git commit -m "Add the daily leaderboard"
```

---

### Task 11: Publish best-of-day on the sync tick

**Files:**
- Modify: `src/sync/engine.ts`

**Interfaces:**
- Consumes: `publishBestOfDay`, `flushQueue` from Task 8.
- Produces: nothing new.

- [ ] **Step 1: Call both at the end of a successful sync**

In `engine.ts`, after the cursors are written and before `setState('idle')`:

```ts
// Derived from local state each time, so a deleted or DNF-ed solve corrects
// the published row without a separate retraction path.
const events = new Set(
  storeRef.current.sessions.filter((s) => !s.deleted).map((s) => s.event),
)
for (const event of events) {
  await publishBestOfDay(
    storeRef.current.solves.filter(
      (s) => storeRef.current.sessions.find((x) => x.id === s.sessionId)?.event === event,
    ),
    event,
  )
}
await flushQueue()
```

- [ ] **Step 2: Verify**

Run: `npm run build && npm test`
Then with a signed-in account: record a solve, wait for the sync tick, and confirm a `daily_bests` row appears. DNF that solve, wait for the next tick, and confirm the row updates or disappears.

- [ ] **Step 3: Run the full harness once more**

Run: `npm run rls`
Expected: every assertion still passes — nothing in this task should have changed the boundary.

- [ ] **Step 4: Commit**

```bash
git add src/sync/engine.ts
git commit -m "Publish the day's best solve on each sync tick"
```

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: the central constraint → Tasks 2 and 3; data model → Task 2; access control → Tasks 2 and 3; server-side generation → Tasks 4 and 5; client flows (reveal, submit, `daily_bests`, board) → Tasks 8–11; testing → Task 1 extended through Tasks 2 and 3; rollout order → task order.

**Two known gaps, deliberately left to phase 1.** The opt-in toggle and username claim have no UI here — this plan reads `profiles.opted_in` but never writes it, so until phase 1 ships, publication can only be enabled by hand in SQL. That is the correct seam: building a profile UI inside this plan would pre-empt phase 1's spec.

**One risk that the plan cannot remove.** Task 4 is a spike, and if cubing.js does not run under Deno, Task 5 changes shape entirely. It is sequenced before any client work for exactly that reason.
