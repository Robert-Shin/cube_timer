# Phase 3 — Friends

*2026-08-22*

## Why

Phases 1 and 2 built a public board: one shared scramble per event per UTC day,
one committed attempt, and a leaderboard of everyone who opted in. It works, and
it is the wrong shape for the thing people actually do with a cubing habit,
which is compare notes with three or four friends who care.

The public board answers "who was fastest today". It cannot answer "is Glen
still practising", "what is Glen's PB", or "am I ahead of Glen this week" —
and those are the questions that keep someone opening the app.

Phase 3 adds a friend: a person you have both agreed to share practice with,
and a page that shows you theirs.

## Scope

In scope: mutual-consent friendships, a friend profile page showing a practice
calendar, best single, a rolling average, total solves, and today's daily
challenge result.

Out of scope: blocking, friend groups, notifications, a friends-only filter on
the daily board, historical boards, avatars, and any comparison view that ranks
friends against each other. Several of those are natural next steps; none is
needed to answer the questions above.

## Decisions

**Friendship is mutual and explicit.** A request is sent, and nothing is shared
until it is accepted. Nobody's practice becomes visible because someone else
decided to follow them.

**Friendship is its own consent, independent of `opted_in`.** `opted_in` means
"put me on the public board". Accepting a friend request means "you may see my
practice". A user can share everything with three friends and nothing with
strangers, which is how most people want this. The two flags never interact.

**Discovery is by exact username.** You type a name you already know and send a
request. There is no search-as-you-type and no browsable user list.

Any signed-in user can *already* enumerate every username — `schema.sql:201`
grants `select (user_id, username, opted_in)` on `profiles` to authenticated,
because the board needs to name people. So exact-match is not a security
boundary and is not claimed as one. It is a choice not to build browsing
strangers into the product.

**There is no `daily_summary` table.** The earlier sketch for this phase assumed
per-day aggregate rows. Two things killed it, and the second is fatal:

- Aggregating 3463 solves behind an index is sub-millisecond at personal scale,
  so a materialised table is an optimisation for a problem that does not exist.
- **A rolling average cannot be derived from per-day aggregates at all.** `ao12`
  is a window over the last 12 solves wherever they fall, and it crosses day
  boundaries arbitrarily. No table of per-day counts can produce it.

Aggregates are computed on demand instead, by `security definer` functions that
read `solves` directly. That also removes a trigger, a backfill of the existing
rows, and the standing possibility of a summary that disagrees with the solves
behind it.

**A friend's rolling average is computed on the client, from bare integers.**
`averageOf` (`stats.ts:10`) implements real WCA semantics: trim the best and the
worst, treat a single DNF as the worst, and return `null` — a DNF average — when
more than one solve is a DNF. Reimplementing that in SQL is precisely the kind
of subtle logic that drifts from its twin, and the divergence would be silent.

So `friend_stats` returns the friend's last 12 **effective times as integers** —
no ids, no scrambles, no session references, no timestamps — and the existing,
already-tested TypeScript computes the average. Twelve integers is not raw solve
data, and a friend's `ao12` and your own can never disagree, because they are
produced by the same function.

**Declining a request deletes the row.** There is no `rejected` state. A
persisted rejection is either a tombstone every query must filter, or a
permanent block — and blocking is a separate feature with separate
requirements. Deleting lets them ask again, which is the right default among
friends.

`state` is nonetheless `text` rather than `boolean`, so `pending`/`accepted`
reads correctly at every call site and a future `blocked` is a new value rather
than a migration.

## Schema

One new table. It keys on `profiles(user_id)`, not `auth.users(id)`: phase 1
moved profile creation to username-claim time, so this foreign key makes it
structurally impossible to befriend someone who has not claimed a name, with no
check in application code.

```sql
create table if not exists public.friendships (
  requester   uuid not null references public.profiles(user_id) on delete cascade,
  addressee   uuid not null references public.profiles(user_id) on delete cascade,
  state       text not null check (state in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- One row per unordered pair: rob->glen and glen->rob cannot both exist as
-- competing requests, in either order.
create unique index if not exists friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));

-- The calendar groups by created_at; the existing indexes are on
-- (user_id, updated_at) and (user_id, session_id), neither of which serves it.
create index if not exists solves_user_created on public.solves (user_id, created_at)
  where not deleted;
```

**One row per pair, not two mirrored rows.** Two rows means every accept is a
two-row transaction and every policy must reason about the pair agreeing; one
row cannot be half-accepted. The cost is that "are these two friends" is an `or`
over both column orders, which is why it is written exactly once:

```sql
create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.state = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;
```

## Access control

Send, accept, decline and unfriend are ordinary writes under RLS. No RPC is
involved, because the client can already resolve a username to a `user_id`
through the existing `profiles` grant. These four policies are the entire
access model for friendship itself.

```sql
alter table public.friendships enable row level security;

-- You see only friendships you are part of.
create policy friend_select on public.friendships for select
  using (auth.uid() in (requester, addressee));

-- You may only ever create a PENDING request, and only as yourself.
create policy friend_insert on public.friendships for insert
  with check (auth.uid() = requester and state = 'pending');

-- Only the addressee may accept, and only pending -> accepted.
create policy friend_accept on public.friendships for update
  using      (auth.uid() = addressee and state = 'pending')
  with check (auth.uid() = addressee and state = 'accepted');

-- Either party may walk away, from either state.
create policy friend_delete on public.friendships for delete
  using (auth.uid() in (requester, addressee));
```

Two clauses carry almost all the weight:

**`state = 'pending'` on insert.** Without it, anyone could insert
`(me, you, 'accepted')` and read a stranger's entire practice history without
that person ever being asked. This is the single most dangerous mistake
available in this feature, and the assertion that pins it is the most important
one in the harness.

**The `using`/`with check` split on update.** `using` tests the row as it was,
`with check` the row as it would become. Together they stop a requester
self-accepting their own request, and stop an accepted row being flipped back to
`pending` and re-accepted to launder it.

Note what the delete policy deliberately permits: either party may delete at any
state, so declining a request and unfriending are the same operation. That is
intended — it means there is one path out, not two.

### Reading a friend's practice

Reading someone else's solves is the only operation RLS cannot express, so it
is the only place `security definer` appears. Two functions, both scoped to one
`(p_user, p_event)` pair, because the page needs a row set and a scalar set and
one function cannot return both:

```sql
-- One row per day with activity, for the calendar.
create or replace function public.friend_calendar(
  p_user uuid, p_event text, p_since date)
returns table (
  day       date,   -- calendar cell
  solves    int,    -- that day's count
  day_best  int     -- that day's best effective time; null if all DNF
)
language sql stable security definer set search_path = public as $$
  select date_trunc('day', s.created_at)::date, ...
  from public.solves s
  join public.sessions n on n.id = s.session_id
  where s.user_id = p_user and n.event = p_event
    and not s.deleted and not n.deleted
    and s.created_at >= p_since
    and public.are_friends(auth.uid(), p_user)   -- the boundary
  group by 1;
$$;

-- The scalars: total, best single, and the last 12 effective times for ao12.
create or replace function public.friend_stats(p_user uuid, p_event text)
returns table (total int, best_ms int, recent_ms int[])
language sql stable security definer set search_path = public as $$ ... $$;
```

`are_friends` is itself `security definer`, because under the caller's own RLS
it could only ever see friendships the caller is party to — which happens to be
sufficient here, but only by coincidence, and relying on that coincidence would
make the helper unsafe the moment it is reused.

Both functions return **no rows at all** when `are_friends(auth.uid(), p_user)`
is false. `security definer` means they run with the owner's rights and **RLS
does not protect them**: that friendship check *is* the boundary, in full. This
is the same posture as `reveal_daily`, and it is why these functions need
harness assertions written before they ship rather than after.

Counting three new functions where the client sees two calls is deliberate.
`are_friends` exists so the boundary condition is written once and can be
attacked once, rather than being copy-pasted into each function and drifting.

Scoping is per event. A PB across 3x3 and 4x4 together is meaningless, so the
profile page shows one event at a time, chosen by the viewer.

## Client

A new `src/friends.ts` alongside the existing `dailyClient.ts`, holding the
network surface: `sendRequest(username)`, `respond(requester, accept)`,
`unfriend(otherUserId)`, `listFriends()`, and `friendProfile(userId, event)`
(which makes both RPC calls and assembles one view model).

Following the pattern established by `classifySubmitError` and `planBestOfDay`,
the decisions come out as pure functions that can be tested without a database:

- `classifyRequestError(error)` — distinguishes *no such username*, *already
  friends*, *request already pending*, and *retry*. The unique pair index and
  the foreign key both surface as constraint violations with stable SQLSTATEs
  (`23505`, `23503`); mapping them to messages a person can act on is pure
  logic over an error object.
- `partitionFriendships(rows, selfId)` — one list of `friendships` rows becomes
  `{ accepted, incoming, outgoing }`. Which bucket a row lands in depends on
  whether you are the requester or the addressee, which is exactly the kind of
  off-by-one that is worth pinning in a test and invisible in a UI.

Friend data is **not** written into the local store and does not sync. It is
remote-only, fetched on view. The sync engine's invariants in `src/sync/stamp.ts`
govern rows this device owns and can edit offline; a friend's aggregates are
neither. Putting them in the store would mean tombstones, `updatedAt` stamping,
and reconciliation for data that is read-only and cheap to refetch.

## UI

Two surfaces.

**A friends list**, reachable from the existing auth/profile area. It shows
accepted friends, incoming requests with accept and decline, and outgoing
requests as pending. Plus the add form: one text input and a button.

**A friend profile page**, reached by selecting a friend. It shows their
username, an event selector, best single, `ao12`, total solves, a practice
calendar of the last several weeks as an activity grid, the current streak, and
their daily challenge result for today if they posted one.

The calendar is the one genuinely new visual component. Per CLAUDE.md, any new
chart colours must be validated against both theme surfaces (`--panel` is
`#fffdfa` light, `#1c1a17` dark) with the dataviz skill's
`scripts/validate_palette.js` — an activity grid encodes count as colour
intensity, so this is exactly the case that rule exists for. Colour-blind
safety is not to be eyeballed.

## Error handling

The failure that matters is a friend request that cannot be delivered. Unlike a
daily submission, nothing is lost by failing loudly: there is no revealed
attempt on the line and the user can simply press the button again. So requests
are **not** queued for retry the way `dailyQueue` queues submissions. They
report the error and stop.

`friend_calendar` returning no rows is ambiguous in exactly one way worth naming:
it means either "not friends" or "this friend has no solves for this event".
The client distinguishes them by checking the friendship it already listed,
rather than inferring from emptiness — the same class of mistake as reading an
empty local store as "no best today", which is what phase 3's predecessor bug
turned out to be.

## Testing

Three layers.

**Pure unit tests**, in the style of the existing suites: `classifyRequestError`
over each SQLSTATE, and `partitionFriendships` over every requester/addressee
combination including the incoming/outgoing swap.

**RLS harness assertions**, added to `scripts/rls-harness.mjs`. This is the
layer that matters, and per the standing rule these are written before the
feature ships, not after. Every one of these was a real defect class in an
earlier phase or is one clause away from being one:

1. A stranger cannot insert `(self, victim, 'accepted')` — the insert policy
   rejects it. **The most important assertion in the feature.**
2. A stranger cannot read `friend_calendar` or `friend_stats` for a user they
   are not friends with.
3. A *pending* request does not grant profile access to either party.
4. The requester cannot accept their own request.
5. An accepted row cannot be flipped back to `pending`.
6. A third party cannot see a friendship row between two other users.
7. After either party deletes, both functions stop returning data.
8. Neither function returns a solve id, scramble, or session id — assert on
   the returned column set, not on a sampled row.
9. `select('*')` on `friendships` behaves as the grant intends, matching the
   deliberate `profiles` precedent so a column added later is not public by
   default.

The harness's existing rules carry over unchanged: the preflight guard must know
about `friendships` and all three functions, or a missing object will read as
security working; and fixtures must use sentinel ids and delete themselves in a
`finally`, because harness fixtures have twice reached production.

**Manual acceptance**, against the built output rather than dev, per CLAUDE.md:
two real accounts, send a request one way, confirm nothing is visible while it
is pending, accept, confirm the calendar renders, unfriend, confirm it goes
dark again.

## Risks

**`security definer` is the whole boundary.** RLS does not apply inside these
functions. A missing `are_friends` check is a silent full disclosure of another
user's practice history, and it would not fail any test that only checks the
happy path. This is why assertions 2, 3 and 7 exist and why they must be
written first.

**Enumeration is already open.** Usernames are readable by any signed-in user
today. This phase does not widen that, but it does make it useful: knowing a
name is now sufficient to send a request. If unsolicited requests ever become a
problem, the fix is a "who can send me requests" setting — deliberately not
built now.

**The calendar's shape leaks a little.** Per-day counts reveal daily rhythm —
when someone practises, and when they stopped. That is the intended product, and
it is gated behind an accepted friendship, but it is more than "they are
active", and worth being honest about rather than describing the aggregates as
though they were anonymous.

## Rollout

1. Schema: table, pair index, `solves_user_created`, `are_friends`, the two
   read functions, and the four policies.
   Run `npm run rls` before and after.
2. Harness assertions, before any client code — they must fail against the
   unbuilt feature for the right reason.
3. `src/friends.ts` with its pure functions and their unit tests.
4. The friends list UI.
5. The profile page and the calendar, with palette validation.
6. Manual acceptance against the built output with two accounts.
