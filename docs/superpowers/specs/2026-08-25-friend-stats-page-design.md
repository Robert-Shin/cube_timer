# Friend stats page

A friend's practice moves out of a modal and onto a page of its own, laid out
like your own stats page and reachable by URL.

## Why

Opening a friend today drops their practice into a modal roughly 500px wide:
a session picker, four figures, today's daily result, and a 12-week calendar.
Your own stats page, three feet away, has a distribution histogram, a trend
chart with a percentile band, a practice calendar, a full figures table and a
solve list. The comparison a friend list exists to invite — *how does their
practice look next to mine* — cannot be made when the two are rendered by
different code at different sizes.

Note that neither surface has ever been opened by a real user (see
`friends-profile-surfaces-unopened`). This is a redesign of an unproven
surface, not a fix to a reported problem.

## What changes for the user

- Clicking a friend in the friends panel navigates to `#/friend/<uuid>`: a
  full-width page with the same panels, in the same order, as your stats tab.
- The page says whose it is, unmistakably, and offers one way back to your own
  timer and stats.
- Browser Back leaves the friend page. A refresh keeps you on it.
- The modal profile is deleted. There is one friend surface, not two.

## The security boundary

### What crosses it today

Friend data reaches the client through four `security definer` RPCs —
`friend_sessions`, `friend_stats`, `friend_calendar`, `friend_daily` — each
gated by `are_friends(auth.uid(), p_user)`. RLS does not apply inside them;
that check is the whole boundary. All four return **aggregates**: day counts,
day bests, a total, a best, the last 12 effective times, and today's daily
result.

### The invariant this reverses

`scripts/rls-harness.mjs` states, guarding two column-set assertions:

> This project's entire premise is that friends see aggregates and never raw
> solve rows.

That premise is now false by choice. The distribution histogram and the trend
chart cannot be drawn from aggregates, and the page is meant to mirror the
stats page. **The harness's comments and assertions must be rewritten to state
the new boundary explicitly, not quietly relaxed.** The new statement is:

> A friend sees the times and penalties of solves in a session, ordered but
> not timestamped. A friend never sees a scramble, a solve id, a session id,
> or the clock time of a solve.

A reviewer who finds the old comment and the new behaviour in the same file
should treat that as a bug.

### The new RPC

```sql
create or replace function public.friend_solves(
  p_user uuid, p_session uuid, p_limit int)
returns table (day date, time_ms int, penalty text)
language sql stable security definer set search_path = public as $$
  select
    (s.created_at at time zone 'UTC')::date,
    s.time_ms,
    s.penalty
  from public.solves s
  join public.sessions n on n.id = s.session_id
  where s.user_id = p_user
    and n.id = p_session
    and n.user_id = p_user
    and not s.deleted
    and not n.deleted
    and public.are_friends(auth.uid(), p_user)
  order by s.created_at desc
  limit least(coalesce(p_limit, 2000), 2000);
$$;

revoke all on function public.friend_solves(uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function public.friend_solves(uuid, uuid, int) to authenticated;
```

Every clause is load-bearing:

- **`and n.user_id = p_user`** is not redundant with `s.user_id = p_user`.
  `p_session` is an unvalidated id from the caller; without this, the check is
  merely that some solves in the named session belong to the friend, not that
  the session does. Same trap already documented in `friend_calendar`.
- **`are_friends` inside the query.** This is a set-returning query with a
  `FROM` clause, so a failed check yields zero rows naturally — it does not
  need `friend_stats`' outer `where`, which exists only because a `FROM`-less
  scalar select list always returns one row.
- **`least(coalesce(p_limit, 2000), 2000)`** caps server-side. `p_limit` is
  attacker-controlled; a client asking for 10^9 rows gets 2000.
- **`day`, not `created_at`.** The trend chart uses the timestamp only to
  print a date in a tooltip, and `friend_calendar` already exposes per-day
  activity, so a date discloses nothing new — while a full timestamp would
  hand over the exact minute of every solve a person has ever done. Ordering
  is carried by the row order (`order by s.created_at desc`), which is what
  `averageOf` needs; the timestamp itself never leaves the server.
- **Three columns only.** No scramble, no solve id, no session id, no
  `updated_at`. Nothing the page does not draw.
- **`revoke ... from public, anon, authenticated`.** `from public` alone locks
  down nothing: Supabase's default privileges grant execute to `anon` and
  `authenticated` by name the moment the function is created, and `PUBLIC` is
  a separate pseudo-role. Revoking by name is the only revocation that works.

### Client-side trust rules

- **The username is never read from the URL.** The hash carries a uuid; the
  display name is resolved from `listFriends()`. Otherwise a crafted link
  could put a misleading name above someone else's data.
- **An id that is not an accepted friend renders one calm state.** "Not
  available" — never a distinguishable "this user exists but is not your
  friend" versus "no such user". The server already conflates these (zero
  rows); the client must not un-conflate them.
- **The route is inert when signed out or while the claim gate is active** —
  the same `sync.email && !gateActive` predicate that gates the Friends button
  today.
- **Zero rows is not an error.** A friend with no solves in a session is an
  ordinary empty state. Conflating "no data" with "the call failed" is a
  mistake this codebase has made before, and `friends.ts` documents it twice.

## Rendering

### Shared component

The stats layout is extracted from `App.tsx` into `src/StatsView.tsx`, a
presentational component that takes solves and renders the panels — used by
both your stats tab and the friend page. Sharing is not an optimisation here: it is the only version where
"looks like your stats page" stays true after the next change to either.

`StatsPane` (the figures table) is already a standalone component taking
`{ solves, goalMs }` and is reused as-is.

Interactive affordances become optional props. Absent means read-only, which
is what the friend page passes:

| Affordance | Self | Friend |
|---|---|---|
| Solve row opens `SolveDetail` | yes | no — there is no scramble to show |
| +2 / DNF / delete buttons | yes | no |
| "Clear" session button | yes | no |
| Distribution "By parity" toggle | on parity events | never — parity does not cross |
| Parity tags on solve rows | when tracking | never |
| "Cost of parity" panel | on parity events | never |

The friend page renders: session picker, figures table, distribution,
improvement over time, practice calendar, today's daily result, and a
read-only solve list. The daily-result panel is omitted entirely when the
chosen session is a relay — there is no daily challenge for one, so there is
nothing to be loading or missing. This matches what `FriendProfile` does
today.

### Data shape

`friend_solves` rows are mapped into the `Solve`-shaped objects the charts and
`stats.ts` already consume, so a friend's ao12 is computed by the same function
as yours and the two cannot disagree. Fields with no counterpart are filled
honestly rather than fabricated: `scramble: ''`, `parity: undefined`
(untracked, which is true), and an id synthesised for React keys only.

### Bucket width

The distribution's auto bucket (`suggestBucket`) reads the spread of whatever
solves it is given, so a friend's 4x4 page picks its own width the same way
yours does. Nothing to add.

## Navigation

Hash routing, no dependency, no `vercel.json` rewrite — hash routes never
reach the server, so there is no SPA-fallback 404 to get wrong.

- `#/friend/<uuid>` is the only route. Everything else is your own app.
- Read on mount, and on `hashchange`.
- Leaving is `history.back()` where the previous entry is your own app, and an
  explicit "Back to your timer" control that sets the hash to `#/` otherwise
  (arriving by pasted link has no history to go back to).
- Opening a friend from the friends panel sets the hash rather than calling a
  state setter, so one code path drives the page.

## Errors and empty states

| Situation | What renders |
|---|---|
| Not signed in, or claim gate active | Redirect to your own app |
| Hash uuid is malformed | "Not available" |
| Not an accepted friend | "Not available" — indistinguishable from the above |
| RPC failed (network, error response) | "Could not load … Try again", with a retry |
| Friend has no sessions | "*name* has no solves yet" |
| Session has no solves | "No solves in this session yet" |
| More than 2000 solves in the session | Charts drawn from the newest 2000, with a note saying so |

The three-state pattern already used throughout `FriendProfile`
(`null` = loading, `'error'` = failed, a value = success including empty) is
kept, along with its per-call `stale` flags so a slow response can never land
after a newer request.

## Testing

### Unit

Pure functions only, as elsewhere in this repo: the hash parser (valid uuid,
malformed, absent, trailing junk), and the row-to-`Solve` mapping (penalty
round-trips, DNF stays a DNF, order is preserved).

### RLS harness

A new block in `scripts/rls-harness.mjs`, following the file's own rules:

1. **Positive control first**: an accepted friend calls `friend_solves` and
   gets back the seeded solve's exact `time_ms` and `penalty`. Without this,
   every negative assertion below passes just as well if the fixture were
   never seeded.
2. A stranger (`c`, no friendship) gets zero rows.
3. A *pending* friend gets zero rows — pending is not accepted.
4. An anonymous anon-key client gets zero rows.
5. A friend passing another user's `p_session` gets zero rows (the
   `n.user_id = p_user` clause).
6. `p_limit` of 10^9 returns at most 2000 rows.
7. **Column set is exactly `['day', 'penalty', 'time_ms']`** — asserted on
   `Object.keys`, not by sampling a value, because a value assertion would not
   notice a scramble or solve id riding alongside.
8. `friend_solves` is added to the preflight probe list, so a missing or
   misnamed function fails loudly instead of making every assertion pass
   vacuously.

**Every new assertion is watched failing before it is made to pass** — against
the database *before* the function exists, and again with each guard clause
removed. Four assertions on the phase 3 branch passed green against wide-open
holes; an assertion never seen red proves nothing
(`assertions-must-be-watched-failing`).

### Browser

The build, not dev: `npm run build && npx vite preview`, driven over CDP.
Sign-in on a local origin needs a redirect-allowlist entry or an injected
session (`local-preview-signin-blocked`).

## Deployment

The schema block is applied by hand — pasted into the Supabase SQL editor —
because `npm run schema` cannot run here
(`cubestats-apply-schema-by-hand`). It must be applied **before** the client
that calls it deploys, or every friend page 404s on the RPC.

## Out of scope

- Parity on the friend page. Parity does not cross the boundary.
- Comparing your times against a friend's on one chart.
- Any change to who can befriend whom, or to the public leaderboard's
  `opted_in` gate. `friend_solves` is gated on `are_friends` alone, matching
  `friend_daily`: an accepted friend sees practice whether or not the friend
  opted in to the public board.
