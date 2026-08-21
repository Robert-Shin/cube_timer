# Phase 1 — Identity

*2026-08-21*

## Why

The leaderboard is three phases. Phase 2 — the daily challenge, the committed
attempt, the board — shipped on 2026-08-21 and is complete and correct. It is
also **inert**, and phase 1 is the whole unlock.

`profiles(user_id, username, opted_in)` exists in the schema and is fully
locked down, but nothing in `src/` ever writes it. Every reference is a read:
`dailyClient.ts:143` reads `opted_in`, `dailyClient.ts:197` reads usernames. So
`opted_in` is `false` for every user forever, `published` is therefore always
`false`, and `Leaderboard.tsx` renders "Nobody has posted a time today"
permanently — including the reader's own row.

Phase 1 gives a signed-in user a name and a way to say yes. That is all it is.

## Scope

In scope: a username claim, a rename, an opt-in toggle, and the schema
constraints that make those safe.

Out of scope: friends, per-day aggregates, avatars, profile pages. Those are
phase 3, which depends on usernames existing but is not designed here.

## Decisions

**A username is required.** A signed-in user with no username is not finished
signing in. There is no anonymous participation and no skip.

**The profile row is created at claim time, not at sign-in.** Since a name is
mandatory, "no profile row" and "no username" are the same state, and the app
gates on exactly one condition instead of three. This also handles accounts
that signed in before phase 1 existed, with no separate backfill path.

**Names are 3–20 characters of letters, digits, and single interior spaces,
unique case-insensitively.** `Rob` and `rob` cannot both exist; impersonation
by casing is a real hazard on a public board. The name is stored as typed and
displayed as typed.

**Renames are free.** `Leaderboard` looks names up live by `user_id`, so a
rename relabels past board rows too. There is no name history, and that is
accepted: the board shows who someone is now.

**Opt-in governs future submissions only.** Flipping the toggle does not
re-stamp anything already written. `daily_attempts.published` is frozen at
submit time inside `submit_daily` (`schema.sql:321`) and the table has no
client write policy at all (`schema.sql:200`), which stays true.

**The toggle locks once anything is submitted today.** Because opt-in is
future-only, a toggle that could move after submission would misrepresent the
board for the rest of the UTC day — opting out would not remove a posted time,
and opting in would not add one. Disabling it after the first submission of the
day makes the setting and the board agree at all times. The lock is scoped to
*any* challenge event: once one row is frozen, the setting cannot honestly
describe the day.

This also resolves an inconsistency that would otherwise be visible.
`publishBestOfDay` recomputes `published` from `opted_in` on every sync tick
(`dailyClient.ts:143-165`), so the "best today" column tracks the toggle live
while the ranked challenge column would not. Under the lock, both are settled
before either can be seen, and no code in `dailyClient.ts` needs to change.

## Approach

Constraints live in Postgres; the client writes `profiles` directly through the
column grants that already exist (`schema.sql:182-184`).

The alternative — `security definer` RPCs for `claim_username` and `set_opt_in`
— was rejected. The only thing a hand-rolled client gains by bypassing the UI
is flipping *its own* `opted_in` after submitting, which cannot publish its
attempt (that stamp is already frozen) and can at most expose its own "best
today". That is self-exposure, not a boundary breach, and it does not justify
two more functions to keep in sync.

## Schema

Three guarded statements in `supabase/schema.sql`, in the existing re-runnable
migration style:

```sql
-- Subsumed by the case-insensitive index below.
alter table public.profiles drop constraint if exists profiles_username_key;

alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null
         or (username ~ '^[A-Za-z0-9]+( [A-Za-z0-9]+)*$'
             and length(username) between 3 and 20));

create unique index if not exists profiles_username_lower
  on public.profiles (lower(username));
```

The regex pins the charset and makes leading, trailing, and doubled spaces
unrepresentable, so the client's trim-and-collapse is a convenience rather than
the only defence.

`username` stays nullable although the app never writes null: a `not null`
would make `npm run schema` fail against any pre-existing row that has one, and
the file must stay re-runnable. `dailyClient.ts:210` already falls back to
`anonymous`, so such a row degrades instead of breaking.

No new tables, no new columns, no new functions.

## Client

**`src/profile.ts`** (new), owning the `profiles` table the way
`dailyClient.ts` owns the daily tables:

| Function | Purpose |
|---|---|
| `normalizeUsername(raw)` | Trim, collapse interior space runs. Pure. |
| `validateUsername(name)` | Error string or null, mirroring the check constraint. Pure. |
| `classifyClaimError(err)` | `'taken' \| 'invalid' \| 'retry'`. Pure. |
| `fetchProfile()` | `{ username, optedIn } \| null`; null means unclaimed. |
| `claimUsername(name)` | Upsert on `user_id`; also serves rename. |
| `setOptIn(value)` | One-column update. |

`classifyClaimError` follows `classifySubmitError`: `23505` is taken; `23514`
means client and server validation have drifted and is surfaced as the bug it
is; anything else retries, per `fb876fc`.

**`dailyClient.ts`** gains `hasSubmittedToday()` — today's `daily_attempts`
rows across the challenge events with `submitted_at not null`, limit 1. It
drives the toggle lock and nothing else.

## UI

`App.tsx` gains a `useProfile` hook keyed off `sync.email`. Three states:

1. **Signed out** — unchanged; nothing new renders.
2. **Signed in, no profile row** — `AuthPanel` opens automatically and shows
   only the claim form. There is no Close button; the escape is **Sign out**,
   which makes it a gate rather than a trap.
3. **Claimed** — the existing status block, plus a username field with a
   "change name" action and the opt-in toggle.

The toggle's label says what it does: your username and today's time become
visible to other signed-in users. When `hasSubmittedToday()` is true it renders
disabled, with the reason — you have already posted today, so this takes effect
tomorrow.

`publishBestOfDay` and `fetchBoard` are unchanged.

## Testing

**Unit** (`src/profile.test.ts`), pure functions with no Supabase mock, in the
style of `dailyClient.test.ts`:

- `normalizeUsername` — trims, collapses runs, leaves single interior spaces.
- `validateUsername` — boundaries at 2/3/20/21 characters; rejects punctuation,
  emoji, and a name that is only spaces.
- `classifyClaimError` — one case per branch.

**RLS harness** (`scripts/rls-harness.mjs`), since this touches the only data
boundary CubeStats has. Three assertions, each written so it fails if the thing
it names is broken:

- user B cannot update user A's `profiles` row;
- claiming `Rob` when `rob` exists is rejected by the index, not silently
  accepted;
- an ill-formed name is rejected by the check constraint even when written with
  the service role, bypassing the client.

**Verification order.** `main` auto-deploys, so sequence matters:

1. `npm run schema` — the unique index must exist *before* any client can
   claim. Two differing-case names getting in first would make the index
   uncreatable.
2. `npm run rls`, `npm test`, `npm run build`.
3. `npm run build && npx vite preview`, driven over CDP per `CLAUDE.md`: claim
   a name, opt in, take the daily, and confirm your own row renders on the
   board.

Step 3 is the acceptance test. It is the first time `Leaderboard.tsx` will ever
have shown a row, and it is what proves phase 2 is no longer inert.

## Notes for phase 3

`profiles` rows now appear later than `auth.users` rows — at claim, not at
sign-in. A `friendships` table can take a foreign key to `profiles`, which has
the useful effect that nobody can be befriended before they have a name. That
is a phase 3 decision, recorded here only so the timing is not a surprise.
