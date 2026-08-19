# CubeStats: accounts and cloud sync

Date: 2026-08-19
Status: approved, not yet implemented

## Problem

Solves live in `localStorage`, scoped to one browser on one machine. They are
lost when site data is cleared, invisible on a second device, and capped near
5MB (~30,000 solves). To share the site with other people, each visitor needs
somewhere durable to keep their own data, isolated from everyone else's.

## Goals

- A visitor can time solves immediately, with no account and no network.
- A visitor can optionally sign in; their existing local solves follow them.
- A signed-in user sees the same data on any device they sign in from.
- Losing connectivity never loses a solve and never blocks the timer.
- One user can never read or write another user's rows.

## Non-goals

Realtime subscriptions, server-side statistics, public profiles, sharing or
leaderboards, and account deletion UI. Each is additive later and none change
the schema below.

## Architecture

Three layers, with one rule: the UI never talks to Supabase.

```
UI (App.tsx and components)
      | reads and writes synchronously
Local store (localStorage)   <- authoritative for every read
      | background reconcile
Sync engine  <->  Supabase (Postgres + Row Level Security)
```

Recording a solve is a local write and nothing else. Sync is a background
reconciliation of two copies. This keeps the timer usable offline and means a
network fault can never interrupt a solve in progress.

## Data model

```sql
create table sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  event       text not null,
  goal_ms     integer,
  color       smallint,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted     boolean not null default false
);

create table solves (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null references sessions(id) on delete cascade,
  scramble    text not null default '',
  time_ms     integer not null,
  penalty     text not null check (penalty in ('none','plus2','dnf')),
  parity      text[],
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted     boolean not null default false
);

create index solves_user_updated on solves (user_id, updated_at);
create index solves_user_session on solves (user_id, session_id);
create index sessions_user_updated on sessions (user_id, updated_at);
```

Field notes:

- `parity` is `null` for a solve recorded before parity tracking was enabled
  and `{}` for one measured as clean. The distinction is load-bearing: folding
  untracked solves into "no parity" would bias the clean mean that every
  parity comparison is measured against.
- `time_ms` is the raw time. Penalties stay in their own column so a `+2` can
  be undone without losing the original measurement.
- Ids are UUIDs generated on the client. Local rows created before sign-in
  keep their identity when uploaded, so adoption is a plain upsert with no id
  remapping.

## Security

Row Level Security enabled on both tables, with policies for select, insert,
update and delete all requiring `user_id = auth.uid()`. Inserts additionally
check `user_id = auth.uid()` so a client cannot write rows attributed to
someone else.

This is the entire access-control model, so it is verified directly rather
than assumed: a test signs in as a second account and confirms the first
account's rows are absent from selects and rejected on writes.

The anon key is published in the browser bundle by design; RLS is what
protects the data. The service-role key is never used in this repository.

## Sync engine

Local `Session` and `Solve` gain `updatedAt: number` and `deleted: boolean`.
Storage migrates v2 to v3, stamping existing rows with their `createdAt` as
`updatedAt` and `deleted: false`.

- **Pull**: select rows where `updated_at > lastPulledAt`. RLS scopes the
  query to the current user, so no user filter is needed in the client.
- **Push**: upsert, in batches, every row whose `updatedAt` is newer than the
  last successful push.
- **Conflict**: last write wins, compared per row on `updatedAt`.
- **Deletes**: soft, via the `deleted` tombstone. A hard delete would be
  invisible to a second device, which would then resurrect the row.
- **Triggers**: sign-in, window focus, a debounce after local changes, and a
  periodic retry while unsynced changes remain.
- **Failure**: a failed sync is a non-event. Local already holds the truth, so
  the attempt is retried later. The UI shows sync state but never blocks.

Accepted limitation: last-write-wins compares client clocks, so a device with
a badly skewed clock could win a conflict it should lose. For single-user data
where solves are append-only and edits are rare, this is preferred over
server-assigned version vectors, which would add substantial complexity for a
conflict pattern this data barely produces.

## Auth and adoption

Magic link over email. On first sign-in, every local row is marked dirty and
pushed. If the account already holds data, the two sets union — UUID ids
cannot collide, so no destructive "merge or replace" choice is imposed.

Signing out keeps local data on the device and stops syncing.

## Configuration

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, read from `.env.local`
locally and from Vercel's environment settings in production. `.env*` is
already gitignored. `supabase/schema.sql` is committed so the database is
reproducible rather than hand-configured.

If the variables are absent the app runs exactly as it does today, local-only,
with sign-in hidden. This keeps the repository usable by anyone who clones it
without a Supabase project.

## Files

| Path | Purpose |
|------|---------|
| `supabase/schema.sql` | tables, indexes, RLS policies |
| `src/supabase.ts` | client construction; absent config disables sync |
| `src/sync/engine.ts` | push, pull, merge, scheduling |
| `src/sync/merge.ts` | pure last-write-wins reconciliation |
| `src/AuthPanel.tsx` | sign in, sign out, sync status |
| `src/storage.ts` | v2 to v3 migration, dirty tracking |
| `.env.example` | documents both variables |

## Testing

- Pure merge function against hand-built cases: local newer, remote newer,
  equal timestamps, tombstone versus edit, and rows present on one side only.
- Migration from v2 to v3, and idempotence across repeated loads.
- RLS verified from a second account: rows invisible, writes rejected.
- Offline behaviour: solves recorded with the network down appear after it
  returns.
- Adoption: local solves recorded signed-out appear in the account after
  signing in, with their scrambles, penalties and timestamps intact.

## Deployment

Vercel, connected to the GitHub repository, deploying `main` on push. Supabase
auth redirect URLs must include the production origin and `http://localhost:5173`.
