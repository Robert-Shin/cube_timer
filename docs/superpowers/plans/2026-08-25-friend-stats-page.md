# Friend Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a friend's practice out of a 500px modal onto a full page at `#/friend/<uuid>`, laid out by the same component that draws your own stats tab.

**Architecture:** One new `security definer` RPC, `friend_solves`, returns a friend's per-solve times gated by `are_friends` — the first time raw solve rows cross that boundary, which is why the RLS harness is the first task and not the last. The stats layout is extracted from `App.tsx` into a presentational `StatsView` that both surfaces render, with interactivity as optional props. Navigation is a hash route read from `window.location.hash`; no router dependency and no `vercel.json` rewrite.

**Tech Stack:** React 19 + TypeScript, Vite, Vitest, Supabase (Postgres RLS + `security definer` RPCs). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-friend-stats-page-design.md`

## Global Constraints

- **Typecheck with `tsc -b` or `npm run build`.** `npx tsc --noEmit` is a no-op here — the root `tsconfig.json` is a solution file with only project references, so it silently checks nothing and reports success.
- **Verify against the built output**, not just dev: `npm run build && npx vite preview`. A Vite-only bug has shipped a broken site before.
- **Headless Chrome `--virtual-time-budget` cannot wait on CPU-bound wasm in a worker.** To check anything asynchronous, drive a real browser over CDP (`--remote-debugging-port`) and poll the DOM.
- **Never commit** `.env.local` or `cstimer_*.txt`. The Supabase **anon key is public by design**; the **service_role key must never enter this repo**.
- **Every row mutation goes through `touch()` or `tombstone()`** in `src/sync/stamp.ts`. Nothing in this plan mutates rows — the friend page is read-only — so no task should call either.
- **Revoke by name.** `revoke all ... from public` locks down nothing; Supabase's default privileges grant execute to `anon` and `authenticated` explicitly. Always `revoke all on function f(args) from public, anon, authenticated;` then grant back.
- **`npm run schema` cannot run here.** Schema changes are applied by pasting the changed block into the Supabase SQL editor.
- **An assertion never watched failing proves nothing.** Four assertions on the phase 3 branch passed green against wide-open holes.
- **The cap is 2000 solves**, enforced server-side as `least(coalesce(p_limit, 2000), 2000)`.
- **The columns `friend_solves` returns are exactly `day`, `time_ms`, `penalty`.** No scramble, no ids, no timestamps.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema.sql` | Modify: add `friend_solves` + its grants at the end of the friend-RPC block |
| `scripts/rls-harness.mjs` | Modify: rewrite the aggregates-only invariant comment; add the `friend_solves` block and preflight probe |
| `src/friends.ts` | Modify: add `friendSolves()` and the pure `toSolves()` mapping |
| `src/friends.test.ts` | Modify: unit tests for `toSolves()` |
| `src/route.ts` | Create: parse/format the hash route. Pure, no React |
| `src/route.test.ts` | Create: unit tests for the parser |
| `src/StatsView.tsx` | Create: the stats panels, extracted verbatim from `App.tsx` |
| `src/SolveList.tsx` | Create: the solve list, extracted from `App.tsx`, actions optional |
| `src/FriendStats.tsx` | Create: the friend page — data fetching + `StatsView` + `SolveList` |
| `src/FriendProfile.tsx` | Delete: replaced by `FriendStats.tsx` |
| `src/App.tsx` | Modify: render `StatsView`/`SolveList`; route to `FriendStats`; drop the modal |
| `src/index.css` | Modify: friend-page chrome (the "viewing a friend" banner) |

---

### Task 1: `friend_solves` RPC, proven by the RLS harness

The security boundary, first, because every later task consumes it. The harness is this task's test suite; there is no vitest for it.

**Files:**
- Modify: `supabase/schema.sql` (append after the `friend_sessions` grants, currently ending ~line 667)
- Modify: `scripts/rls-harness.mjs` (preflight list ~line 266-274; the invariant comment ~line 1006; new block after the `friend_sessions` assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: RPC `friend_solves(p_user uuid, p_session uuid, p_limit int)` returning rows of `{ day: string, time_ms: number, penalty: 'none' | 'plus2' | 'dnf' }`, newest first, at most 2000. Zero rows for any caller who is not an accepted friend of `p_user`.

- [ ] **Step 1: Add `friend_solves` to the harness preflight probe**

The preflight list (around line 266) exists so a missing or misnamed function fails loudly instead of making every assertion below pass vacuously. Add a fourth friend entry alongside the existing three:

```js
  { name: 'friend_sessions', args: { p_user: '00000000-0000-0000-0000-000000000000' } },
  // Probed with a random uuid: are_friends is false for it, so this returns
  // zero rows rather than touching anyone's data.
  { name: 'friend_solves', args: {
      p_user: '00000000-0000-0000-0000-000000000000',
      p_session: '00000000-0000-0000-0000-000000000000',
      p_limit: 10,
    } },
```

- [ ] **Step 2: Run the harness and watch the preflight fail**

Run: `npm run rls`
Expected: FAIL in preflight, naming `friend_solves` as missing (PostgREST reports `PGRST202`, "Could not find the function"). This is the proof that the probe is wired to a real call and not silently skipped.

- [ ] **Step 3: Rewrite the aggregates-only invariant comment**

In `scripts/rls-harness.mjs`, the comment above the `friend_calendar` column-set assertion currently reads *"This project's entire premise is that friends see aggregates and never raw solve rows."* That premise is now false. Replace that sentence — in **both** places it appears (the `friend_calendar` and `friend_stats` column-set assertions) — with:

```js
  // A friend sees the times and penalties of solves in a session, ordered
  // but not timestamped (see friend_solves below). A friend never sees a
  // scramble, a solve id, a session id, or the clock time of a solve. These
  // two functions predate that and remain strictly aggregate, so assert on
  // the exact COLUMN SET rather than a sampled value: a value assertion
  // reads named fields and would not notice a scramble or solve id riding
  // alongside them.
```

Leave the assertions themselves unchanged — `friend_calendar` and `friend_stats` are still aggregate-only and must stay that way.

- [ ] **Step 4: Write the failing harness assertions**

Add after the existing `friend_sessions` assertions. `friendSessionId`, `friendSolveTimeMs`, `a` (accepted friend of `b`), `b` (the data owner), `c` (a stranger with a *pending* request), `admin`, `expectEmpty`, `check` and `assert` are all already in scope in that block.

```js
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
    created_at: new Date(Date.now() + 1000).toISOString(),
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

  // c has a PENDING request to b, not an accepted one. are_friends must
  // require 'accepted' -- a request anyone can send is not consent.
  await expectEmpty('friend_solves: a pending friend sees nothing', () =>
    c.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    }),
  )

  await expectEmpty('friend_solves: an anonymous caller sees nothing', () =>
    anonClient().rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 100,
    }),
  )

  // The n.user_id = p_user clause. p_session is an unvalidated id from the
  // caller: a is a genuine friend of b, but names a session that is NOT
  // b's. Without that clause the function would happily read it.
  await expectEmpty("friend_solves: a friend cannot read a session that is not the named user's", () =>
    a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: harnessOwnSessionId, p_limit: 100,
    }),
  )

  // p_limit is attacker-controlled; the ceiling is server-side.
  await check('friend_solves: p_limit cannot exceed the server cap', async () => {
    const { data, error } = await a.client.rpc('friend_solves', {
      p_user: b.userId, p_session: friendSessionId, p_limit: 1_000_000_000,
    })
    assert(!error, `unexpected error ${error?.message}`)
    assert((data ?? []).length <= 2000, `expected at most 2000 rows, got ${(data ?? []).length}`)
  })
```

Two names in the above may not exist yet in the harness — resolve them before running:
- `anonClient()` — if the file already has a helper that builds an unauthenticated anon-key client, use its name. Otherwise add `const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } })` near the top, beside `admin`.
- `harnessOwnSessionId` — the session belonging to `a` (not `b`), created around line 308 as `sessionId`. Use that variable's actual name; if it is out of scope in this block, hoist its declaration.

- [ ] **Step 5: Run the harness and watch every new assertion fail**

Run: `npm run rls`
Expected: the preflight still fails on the missing function. Comment out the preflight entry *temporarily* and re-run so the six assertions themselves execute and fail — the positive control must fail with an RPC-missing error, and each `expectEmpty` must be seen erroring rather than passing. Restore the preflight entry afterwards.

This step is the point of the task. An `expectEmpty` that has never been seen red is indistinguishable from one that passes because the function does not exist.

- [ ] **Step 6: Add the function to `supabase/schema.sql`**

Append after the `friend_sessions` grants:

```sql
-- The first friend function that returns SOLVE ROWS rather than aggregates.
-- Drawing a distribution or a trend cannot be done from day counts, and the
-- friend page is meant to mirror the owner's own stats page.
--
-- What a friend may see is therefore now: the times and penalties of solves
-- in a session, ordered but not timestamped. What a friend may still never
-- see: a scramble, a solve id, a session id, or the clock time of a solve.
-- Same security-definer posture as the four above -- RLS does not apply in
-- here, so the are_friends check IS the boundary, in full.
create or replace function public.friend_solves(
  p_user uuid, p_session uuid, p_limit int)
returns table (day date, time_ms int, penalty text)
language sql stable security definer set search_path = public as $$
  select
    -- A date, not created_at. The trend chart uses the timestamp only to
    -- print a date in a tooltip, and friend_calendar already exposes
    -- per-day activity -- so a date discloses nothing new, while a full
    -- timestamp would hand over the exact minute of every solve a person
    -- has ever done. Ordering is carried by the ORDER BY below, which is
    -- what averageOf needs; the timestamp itself never leaves the server.
    (s.created_at at time zone 'UTC')::date,
    s.time_ms,
    s.penalty
  from public.solves s
  join public.sessions n on n.id = s.session_id
  where s.user_id = p_user
    and n.id = p_session
    -- Not redundant with s.user_id = p_user. p_session is an unvalidated id
    -- from the caller: the check that matters is that the session being read
    -- belongs to the friend named in p_user, not merely that some solves in
    -- it do. Same trap as friend_calendar.
    and n.user_id = p_user
    and not s.deleted
    and not n.deleted
    -- This is a set-returning query with a FROM clause, so a failed check
    -- yields zero rows naturally. It needs no outer WHERE of the kind
    -- friend_stats carries -- that exists only because a FROM-less scalar
    -- select list always returns exactly one row.
    and public.are_friends(auth.uid(), p_user)
  order by s.created_at desc
  -- p_limit is attacker-controlled, so the ceiling is enforced here rather
  -- than trusted from the client: a caller asking for 10^9 rows gets 2000.
  limit least(coalesce(p_limit, 2000), 2000);
$$;

-- `revoke ... from public` alone would leave this callable by anyone holding
-- the public anon key: PUBLIC is a separate pseudo-role, and Supabase's
-- default privileges grant execute to anon and authenticated BY NAME the
-- moment the function is created. Each named role must be revoked by name.
revoke all on function public.friend_solves(uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function public.friend_solves(uuid, uuid, int) to authenticated;
```

- [ ] **Step 7: Apply the block to the live database by hand**

`npm run schema` cannot run here. Copy the block added in Step 6 — the `create or replace`, the `revoke`, and the `grant` together — into the Supabase SQL editor and execute it. Applying the function without the revoke/grant lines leaves it callable by `anon`, which is the exact hole this project has shipped twice.

- [ ] **Step 8: Run the harness and watch every new assertion pass**

Run: `npm run rls`
Expected: PASS, including the preflight and all six new assertions, with no regression in the existing ones.

- [ ] **Step 9: Prove each guard clause is load-bearing**

For each of the three clauses below, apply a version of the function to the live database with that clause deleted, run `npm run rls`, confirm the named assertion goes **red**, then restore the correct version and confirm green again:

| Clause removed | Assertion that must go red |
|---|---|
| `and public.are_friends(auth.uid(), p_user)` | pending friend / anonymous caller |
| `and n.user_id = p_user` | "a friend cannot read a session that is not the named user's" |
| `least(coalesce(p_limit, 2000), 2000)` → `coalesce(p_limit, 2000)` | "p_limit cannot exceed the server cap" (seed >2000 solves for `b`, or temporarily lower the cap to 1 and assert on that) |

Finish with the correct function applied and `npm run rls` green.

- [ ] **Step 10: Commit**

```bash
git add supabase/schema.sql scripts/rls-harness.mjs
git commit -m "Let a friend read a session's solve times, gated by are_friends"
```

---

### Task 2: `friendSolves()` and the row-to-`Solve` mapping

**Files:**
- Modify: `src/friends.ts`
- Modify: `src/friends.test.ts`

**Interfaces:**
- Consumes: RPC `friend_solves` from Task 1.
- Produces:
  - `export interface FriendSolveRow { day: string; time_ms: number; penalty: string }`
  - `export function toSolves(rows: FriendSolveRow[], sessionId: string): Solve[]` — pure, newest-first order preserved.
  - `export async function friendSolves(userId: string, sessionId: string): Promise<Solve[] | null>` — `null` means the call failed; `[]` means the friend has no solves in this session.
  - `export const FRIEND_SOLVE_CAP = 2000`

- [ ] **Step 1: Write the failing tests**

Append to `src/friends.test.ts`:

```ts
import { toSolves } from './friends'

describe('toSolves', () => {
  const rows = [
    { day: '2026-08-25', time_ms: 12_340, penalty: 'none' },
    { day: '2026-08-24', time_ms: 23_450, penalty: 'plus2' },
    { day: '2026-08-24', time_ms: 34_560, penalty: 'dnf' },
  ]

  it('preserves the server order, which is what averageOf reads', () => {
    expect(toSolves(rows, 'sess').map((s) => s.timeMs)).toEqual([12_340, 23_450, 34_560])
  })

  it('round-trips penalties, so a friend DNF stays a DNF', () => {
    expect(toSolves(rows, 'sess').map((s) => s.penalty)).toEqual(['none', 'plus2', 'dnf'])
  })

  it('treats an unrecognised penalty as none rather than trusting the server string', () => {
    const odd = [{ day: '2026-08-25', time_ms: 1000, penalty: 'wat' }]
    expect(toSolves(odd, 'sess')[0].penalty).toBe('none')
  })

  it('gives each solve a distinct id, since React keys off it', () => {
    const ids = toSolves(rows, 'sess').map((s) => s.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('leaves parity undefined -- untracked, not "measured as none"', () => {
    expect(toSolves(rows, 'sess')[0].parity).toBeUndefined()
  })

  it('turns the day into a timestamp the trend tooltip can print', () => {
    const [first] = toSolves(rows, 'sess')
    expect(new Date(first.createdAt).toISOString().slice(0, 10)).toBe('2026-08-25')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/friends.test.ts`
Expected: FAIL — `toSolves is not a function`.

- [ ] **Step 3: Implement `toSolves` and `friendSolves`**

Add to `src/friends.ts` (it already imports `supabase`; add `Penalty`, `Solve` to the type import from `./types`):

```ts
/** At most this many solves per session, matching friend_solves' server cap. */
export const FRIEND_SOLVE_CAP = 2000

export interface FriendSolveRow {
  /** UTC date, 'YYYY-MM-DD'. friend_solves returns a date, never a timestamp. */
  day: string
  time_ms: number
  penalty: string
}

const PENALTIES: Penalty[] = ['none', 'plus2', 'dnf']

/**
 * friend_solves rows as the `Solve` objects the charts and stats.ts already
 * consume, so a friend's ao12 is computed by the SAME function as yours and
 * the two can never disagree.
 *
 * Fields with no counterpart on the wire are filled honestly rather than
 * fabricated: there is no scramble (the server does not send one, by
 * design), and `parity` stays undefined -- "untracked", which is true, and
 * different from `[]`, which would claim it was measured as none.
 *
 * `createdAt` is midnight UTC of the solve's day, which is all the server
 * discloses. It is used only to print a date in the trend tooltip; ORDER is
 * carried by the array, not by this field, so a whole session sharing one
 * timestamp changes nothing.
 */
export function toSolves(rows: FriendSolveRow[], sessionId: string): Solve[] {
  return rows.map((r, i) => ({
    // Index-based, not crypto.randomUUID(): a stable id means React does not
    // remount every row when the list re-renders.
    id: `${sessionId}:${i}`,
    sessionId,
    scramble: '',
    timeMs: r.time_ms,
    // Never trust the string to be one of ours. An unexpected value falling
    // through as a penalty would be rendered, and 'dnf' in particular
    // changes what every average means.
    penalty: PENALTIES.includes(r.penalty as Penalty) ? (r.penalty as Penalty) : 'none',
    createdAt: Date.parse(`${r.day}T00:00:00.000Z`),
    updatedAt: 0,
  }))
}

/**
 * A friend's solves for one session, newest first.
 *
 * null is a genuine failure. An EMPTY array is not null: it means this
 * friend has no solves in this session, which is an ordinary state. Reading
 * "no rows" as "no access" is the same mistake class this file documents
 * twice already.
 */
export async function friendSolves(userId: string, sessionId: string): Promise<Solve[] | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.rpc('friend_solves', {
      p_user: userId,
      p_session: sessionId,
      p_limit: FRIEND_SOLVE_CAP,
    })
    if (error) return null
    return toSolves((data ?? []) as FriendSolveRow[], sessionId)
  } catch {
    // A thrown rejection is the fetch layer failing outright -- never a
    // decision by the server.
    return null
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/friends.test.ts && npm run typecheck`
Expected: PASS, 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/friends.ts src/friends.test.ts
git commit -m "Read a friend's solves into the same Solve shape as your own"
```

---

### Task 3: Hash route

**Files:**
- Create: `src/route.ts`
- Create: `src/route.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Route = { kind: 'self' } | { kind: 'friend'; userId: string }`
  - `export function parseRoute(hash: string): Route`
  - `export function friendHash(userId: string): string`
  - `export function useRoute(): Route` — a React hook reading `window.location.hash` and subscribing to `hashchange`.

- [ ] **Step 1: Write the failing tests**

Create `src/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { friendHash, parseRoute } from './route'

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

describe('parseRoute', () => {
  it('reads a friend route', () => {
    expect(parseRoute(`#/friend/${UUID}`)).toEqual({ kind: 'friend', userId: UUID })
  })

  it('treats an empty hash as your own app', () => {
    expect(parseRoute('')).toEqual({ kind: 'self' })
    expect(parseRoute('#')).toEqual({ kind: 'self' })
    expect(parseRoute('#/')).toEqual({ kind: 'self' })
  })

  it('rejects anything that is not a uuid, rather than passing it to an RPC', () => {
    expect(parseRoute('#/friend/not-a-uuid')).toEqual({ kind: 'self' })
    expect(parseRoute('#/friend/')).toEqual({ kind: 'self' })
    expect(parseRoute(`#/friend/${UUID}/extra`)).toEqual({ kind: 'self' })
    expect(parseRoute(`#/friend/${UUID}' or 1=1--`)).toEqual({ kind: 'self' })
  })

  it('ignores an unknown route', () => {
    expect(parseRoute('#/settings')).toEqual({ kind: 'self' })
  })

  it('round-trips through friendHash', () => {
    expect(parseRoute(friendHash(UUID))).toEqual({ kind: 'friend', userId: UUID })
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route module**

Create `src/route.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * The app's only route. Hash-based on purpose: a hash never reaches the
 * server, so there is no SPA-fallback rewrite to get wrong on Vercel and no
 * router dependency to add.
 */
export type Route = { kind: 'self' } | { kind: 'friend'; userId: string }

const FRIEND = /^#\/friend\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Anything that is not exactly a friend route falls back to your own app.
 *
 * The uuid is matched in full rather than merely split on '/': the value goes
 * straight into an RPC argument, and a route parser is the right place to
 * reject a malformed id -- not the server, and not a component.
 */
export function parseRoute(hash: string): Route {
  const m = FRIEND.exec(hash)
  return m ? { kind: 'friend', userId: m[1] } : { kind: 'self' }
}

export function friendHash(userId: string): string {
  return `#/friend/${userId}`
}

/** The current route, kept in step with the address bar and the Back button. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    // The hash can have changed between the initial useState and this
    // subscription -- a redirect during mount, say -- so read it once more.
    onChange()
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/route.test.ts && npm run typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/route.ts src/route.test.ts
git commit -m "Add a hash route for the friend page"
```

---

### Task 4: Extract `StatsView` and `SolveList` from `App.tsx`

A pure refactor: no behaviour changes, no new tests. The gate is that the app looks and behaves identically afterwards.

**Files:**
- Create: `src/StatsView.tsx`
- Create: `src/SolveList.tsx`
- Modify: `src/App.tsx` (the `stats-view` block at lines ~905-1004; the `pane-right` solve list at lines ~1053-1097)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StatsView({ solves, calendarSolves, title, event, showParity }: { solves: Solve[]; calendarSolves: Solve[]; title: string; event: EventId; showParity: boolean })` — renders the distribution, improvement-over-time and practice panels, plus the "Cost of parity" panel when `showParity`. Owns its own bucket/window/band/scope state.
  - `SolveList({ solves, event, pbId, latestId, showParityTags, onOpen, onPenalty, onDelete, onClear }: {...})` — the last four are optional; absent means read-only.

- [ ] **Step 1: Create `StatsView.tsx` by moving the block verbatim**

Move the JSX currently between `<div className="stats-view dimmable">` and its closing `</div>` (App.tsx ~905-1004) into a new component, along with the state it owns — `bucketChoice`, `distSplit`, `rollWindow`, `showBand`, `calendarScope` — and the derived `bucketMs`/`parityEvent` values those need. Keep every comment attached to the code it explains; they document traps (the `useEffect(() => setBucketChoice(null), [session.id])` reset, the parity gating) that are still true in the new home.

The `calendarScope === 'all'` toggle needs solves beyond the session, which is why `calendarSolves` is a separate prop rather than derived: the friend page has no equivalent of "all sessions" and passes the same array for both, which makes the toggle a no-op there rather than a lie.

`parityEvent` becomes the `showParity` prop, so the friend page can pass `false` unconditionally — parity does not cross the boundary.

- [ ] **Step 2: Create `SolveList.tsx` by moving the list**

Move the `<aside className="pane pane-right dimmable">` contents. Row actions become optional:

```tsx
{onPenalty && onDelete && (
  <span className="actions">
    {/* the +2 / DNF / × buttons, unchanged */}
  </span>
)}
```

and the row is a `<button className="solve-open">` only when `onOpen` is given; otherwise render the same spans inside a plain `<div className="solve-open static">`, so the markup and CSS stay shared but there is nothing to click. Same for the "Clear" button and `onClear`.

- [ ] **Step 3: Render both from `App.tsx`**

Replace the moved blocks with `<StatsView … />` and `<SolveList … />`, passing the handlers that exist today (`setDetailId`, `setPenalty`, `deleteSolve`, `clearSession`). Delete any state and imports that moved and are now unused in `App.tsx` — `oxlint` will name them.

- [ ] **Step 4: Verify nothing changed**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: 149 tests pass (144 existing + 5 from Task 3), no type errors, no lint errors, build succeeds.

Then run the built output and compare against the screenshots in this session: `npx vite preview`, drive Chrome over CDP, seed a session with solves, open the Stats tab, and confirm the distribution (including the parity toggle and the auto bucket), the trend chart, the practice calendar, and the solve list with its +2/DNF/× buttons all render and work as before.

- [ ] **Step 5: Commit**

```bash
git add src/StatsView.tsx src/SolveList.tsx src/App.tsx
git commit -m "Extract StatsView and SolveList so a friend page can render them"
```

---

### Task 5: The friend page

**Files:**
- Create: `src/FriendStats.tsx`
- Delete: `src/FriendProfile.tsx`
- Modify: `src/App.tsx`, `src/FriendsPanel.tsx`, `src/index.css`

**Interfaces:**
- Consumes: `friendSolves`, `toSolves`, `FRIEND_SOLVE_CAP` (Task 2); `parseRoute`, `friendHash`, `useRoute` (Task 3); `StatsView`, `SolveList` (Task 4); the existing `friendSessions`, `friendProfile`, `friendDaily`, `listFriends`, `currentStreak`, `FriendCalendar`, `StatsPane`.
- Produces: `FriendStats({ userId, onLeave }: { userId: string; onLeave: () => void })`.

- [ ] **Step 1: Build `FriendStats.tsx`**

Start from `src/FriendProfile.tsx` — its session-picker, three-state (`null` / `'error'` / value) handling, and per-effect `stale` flags are all correct and must be carried over verbatim in shape. Changes:

- It is a page, not a modal: the outer `<div className="modal-backdrop">` / `<section className="friend-profile modal">` become `<div className="friend-page">`, with no backdrop and no click-outside-to-close.
- A header that makes whose page this is unmistakable: the friend's name, a "viewing a friend" label, and a "Back to your timer" button calling `onLeave`.
- **The name is resolved from `listFriends()`, never from the URL.** Hold it in state; until it resolves, render the page without a name rather than echoing anything from the hash. If the id is not in the accepted list, render the "not available" state.
- A fourth fetch beside the existing three: `friendSolves(userId, sessionId)`, into the same three-state shape.
- Render `<StatsPane solves={friendSolves} goalMs={null} />`, `<StatsView solves={friendSolves} calendarSolves={friendSolves} title={sessionName} event={event} showParity={false} />`, and `<SolveList solves={friendSolves} event={event} pbId={…} latestId={null} showParityTags={false} />` with no action handlers.
- When `rows.length === FRIEND_SOLVE_CAP`, render a note under the distribution: `Showing the most recent 2,000 solves.`
- Keep the daily-result panel exactly as `FriendProfile` has it, including its omission for relay sessions.

- [ ] **Step 2: Route to it from `App.tsx`**

```tsx
const route = useRoute()
// A friend page is meaningless without an account, and friendships have a
// foreign key to profiles(user_id) -- so a user still behind the claim gate
// can neither befriend nor be found. Same predicate that gates the Friends
// button.
const onFriendPage = route.kind === 'friend' && !!sync.email && !gateActive

useEffect(() => {
  // Signing out while on a friend page must not leave it on screen.
  if (route.kind === 'friend' && !onFriendPage) window.location.hash = ''
}, [route.kind, onFriendPage])
```

When `onFriendPage`, render `<FriendStats userId={route.userId} onLeave={…} />` **instead of** the whole app shell, so no timer, no scramble and no keyboard handler is mounted behind it. `onLeave` is:

```tsx
// history.back() when there is somewhere to go back to -- the natural
// gesture -- and an explicit hash reset when the page was reached by a
// pasted link, where Back would leave the site entirely.
const onLeave = () => {
  if (window.history.length > 1) window.history.back()
  else window.location.hash = ''
}
```

- [ ] **Step 3: Point `FriendsPanel` at the route**

`onOpen(id, name)` becomes navigation: `window.location.hash = friendHash(id)`. Drop the `name` argument from the callback — the page resolves the name itself, and passing it here would invite reading it from the URL later. Close the friends panel on navigation.

Delete `src/FriendProfile.tsx` and the `openFriend` state, the `FriendProfile` import, and the modal branch in `App.tsx`.

- [ ] **Step 4: Style the page**

Add to `src/index.css`: `.friend-page` (full-width, same padding as `.stats-view`), and a banner treatment that reads as "not yours" without inventing a new colour — chrome in this codebase is greyscale, and colour means data. A `--raised` background bar with the name and a "Back to your timer" button is enough. Define any new token in **all three** colour blocks (bare `:root`, the `prefers-color-scheme` media query, and `:root[data-theme='dark']`); a token defined in only the first two breaks the explicit light/dark toggle in one direction.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A src/ && git commit -m "Give a friend's practice a page of its own"
```

---

### Task 6: End-to-end verification in the built output

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Build and preview**

Run: `npm run build && npx vite preview`

- [ ] **Step 2: Drive it over CDP with a real signed-in session**

Local sign-in redirects to production unless the origin is in Supabase's redirect allowlist — inject a session instead (see `local-preview-signin-blocked`). Two accounts that are accepted friends, one with solves.

Confirm, on the built site:

| Check | Expected |
|---|---|
| Click a friend in the friends panel | URL becomes `#/friend/<uuid>`; the page renders |
| Reload | Still on the friend's page |
| Browser Back | Back to your own app, timer working |
| "Back to your timer" | Same |
| The page | Name visible, distribution + trend + calendar + figures + read-only solve list |
| Solve rows | No +2/DNF/× buttons; clicking a row does nothing |
| Space bar on the friend page | Nothing — no timer is mounted |
| `#/friend/<a stranger's uuid>` typed by hand | "Not available", no data |
| `#/friend/garbage` | Your own app |
| Sign out while on the friend page | Returns to your own app |

- [ ] **Step 3: Re-run the security harness against the deployed state**

Run: `npm run rls`
Expected: green, including all six `friend_solves` assertions.

- [ ] **Step 4: Commit any fixes and finish**

```bash
git add -A && git commit -m "Fix <what the browser found>"
```

---

## Self-Review

**Spec coverage:** RPC and its clauses → Task 1. Harness invariant rewrite + eight assertion classes → Task 1 (six `check`/`expectEmpty` blocks covering positive control, column set, pending, anon, cross-session, cap; the preflight is Step 1). Client trust rules → Task 3 (uuid validation) and Task 5 (name from `listFriends`, calm not-available, signed-out redirect). Shared rendering and the affordance table → Task 4 and Task 5. Data shape → Task 2. Bucket width → nothing to do, already handled by `suggestBucket`. Navigation → Task 3, Task 5. Error/empty table → Task 5. Cap note → Task 5 Step 1. Testing → Tasks 1, 2, 3 unit + Task 6 browser. Deployment → Task 1 Step 7.

**Known gap:** the spec's error table lists "RPC failed → Could not load … Try again" for the new `friendSolves` call; Task 5 Step 1 covers it under "the same three-state shape", which is the existing pattern in `FriendProfile`, but does not spell out the retry button. Reuse the `attempt` counter that file already carries.
