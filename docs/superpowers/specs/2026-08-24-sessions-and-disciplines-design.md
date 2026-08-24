# Sessions and disciplines

## Problem

Two complaints, one root cause.

**Managing your own sessions is confusing.** A session carries two jobs at
once: it is a named practice log *and* it is the choice of puzzle. The
manage-modal row makes this literal -- name, event, goal, count -- with the
event as a casual `<select>` you can nudge past by accident after solves
exist. Nobody can answer "is a session a log or a puzzle?" because it is
both. Creating one compounds it: you must invent a name and pick an event up
front, so the only sessions that get named well are the ones csTimer named
during an import.

**Viewing a friend asks the wrong question.** `FriendProfile` picks between
all 17 WCA events, because that is the only axis the RPCs expose --
`friend_calendar`, `friend_stats`, and `friend_daily` all take `p_event` and
aggregate across every session that friend has for it. Their sessions are
discarded server-side. You should be picking between *their sessions*.

**And relays do not fit either.** A 2x2-5x5 relay puts four scrambles on
screen for one time. It is not a WCA event: `EventId` cannot hold it,
`EVENTS` has no entry for it, and `newScramble()` takes a single `EventId`.
Any design that makes "event" the primary axis has to smuggle relays in as a
fake event later.

## Model

The primary axis is **discipline** -- what you are practising -- not event.

```ts
type Discipline =
  | { kind: 'event'; event: EventId }
  | { kind: 'relay'; events: EventId[] }
```

A discipline serialises to a stable key: `"333"`, or `"relay:222+333+444+555"`.
Single-event keys are byte-identical to today's `EventId` values, so every
existing session row is already a valid discipline key and no data migration
is required -- `sessions.event` is `text` and keeps its name in the database.

A **session** is one log inside a discipline. Its discipline is set at
creation and is not a per-row dropdown; re-pointing it is an explicit "Move
to..." action in Manage.

## Scope

Ship the single-event variant only. The `relay` variant exists in the type
layer and in `disciplineKey`/`disciplineLabel`/`parseDiscipline` from the
start, and is not offered in any picker. This is deliberate: writing the
picker, the session nesting, the storage migration, and the friend RPCs
against `Discipline` now means the relay work later adds a variant plus a
multi-scramble display, rather than migrating every session row and every
friend RPC a second time.

## Your own sessions

The toolbar picks a discipline. A session switcher appears **only when that
discipline has more than one session**, so the common case is one control and
the second axis surfaces exactly when it is being used -- the "practice
context" and "time period" cases that justify multiple sessions at all.

`Store.activeId: string` becomes:

```ts
activeDiscipline: string                    // a discipline key
activeByDiscipline: Record<string, string>  // discipline key -> session id
```

Both stay device-local (`localStorage` only; `sync/engine.ts` merely carries
them across a merge). Migration on load: the existing `activeId` names a
session, that session's `event` is its discipline key, so the old pointer
becomes one entry in the new map and sets `activeDiscipline`.

**Sessions are created lazily.** Picking a discipline you have no session for
does not write anything. `App` holds a *draft* session -- a real `Session`
object with a real UUID, memoised on the discipline key so it is stable
across renders -- which is committed to the store together with the first
solve, in a single `setStore`. This keeps `session` non-null throughout
`App.tsx` (it is today, and making it nullable would touch every read of
`session.id` / `.name` / `.goalMs`), while never leaving empty sessions
behind for a discipline you merely looked at. Drafts do not count against
`MAX_SESSIONS`.

Auto-naming removes the other half of the creation friction: a new session is
named `<discipline label> - <date>` (`3x3 - Aug 24`), renameable inline. You
never have to invent a name up front.

## Friend profiles

The event picker is replaced by a flat list of that friend's sessions. Each
row shows its **discipline label** alongside the name, so the puzzle is never
implicit in a name you did not write -- and a relay session reads as
`2-5 Relay` with no extra work once relays ship.

This requires a new security-definer function, `friend_sessions(p_user)`,
returning `(id, name, discipline, solves, last_solve_at)` for that friend's
non-deleted sessions, gated on `are_friends(auth.uid(), p_user)` exactly as
the existing three are. Sessions with zero solves are omitted: a friend's
empty drafts are noise, not practice.

`friend_calendar` and `friend_stats` are re-keyed from `p_event` to
`p_session`, with the `are_friends` gate unchanged and an added check that
the session belongs to `p_user` -- otherwise passing any session id would
read a stranger's solves through a friendship with someone else. This also
removes the `n.event = p_event` join, which would have had no sensible
meaning for a relay.

`friend_daily` keeps taking `p_event`: the daily challenge is per-event, not
per-session. When a friend's selected session is a single-event discipline,
the profile passes that event; for a relay discipline there is no daily and
the panel is omitted.

### Disclosure

Session **names** become visible to accepted friends, which they are not
today. This is new user-authored text crossing a trust boundary. It is
in-scope and intended -- picking between a friend's sessions is meaningless
if you cannot see what they are called -- but it is a deliberate widening,
not an accident, and is recorded here as one.

### Grants

Per CLAUDE.md: `revoke all on function ... from public, anon, authenticated`
by name, then `grant execute ... to authenticated`. `revoke ... from public`
alone locks down nothing, and this has already shipped as a live hole twice
on this project. Verified against the live database with the public anon key,
not by reading the file, and each new assertion is watched failing before it
is trusted.

## Deferred to the relay step

- **`Solve.scramble` is a single `text` column.** A relay attempt has N
  scrambles. Newline-joining them keeps the column as-is, with leg order
  recoverable from the session's discipline -- no schema migration, but a
  decision to make deliberately rather than by accident.
- **The daily challenge is event-only.** A relay discipline has no daily; the
  tab needs an explicit empty state rather than an undefined event.
- **Parity tracking** (`hasParity`) has no meaning for a relay. Off for
  relays.

Stats, charts, and PB detection read times rather than events and are
unaffected either way.

## Testing

- `disciplineKey` / `parseDiscipline` round-trip, including the relay variant
  that no picker offers yet, and single-event keys matching `EventId` exactly.
- Storage migration: an old `activeId` store loads with the right
  `activeDiscipline` and map entry; a store whose `activeId` names a deleted
  or missing session still lands somewhere valid.
- Draft commit: the first solve in a fresh discipline writes exactly one
  session and one solve, sharing the draft's id, both stamped.
- Draft discard: switching discipline twice without solving writes no
  sessions.
- RLS, live, watched failing first: a non-friend calling `friend_sessions`
  gets zero rows; a friend passing a session id belonging to a third party
  gets zero rows from `friend_calendar` / `friend_stats`.
