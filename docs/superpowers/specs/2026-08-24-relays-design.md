# Relays

## Problem

A relay puts several scrambles on screen for one time: you solve a 2x2, a
3x3, a 4x4 and a 5x5 back to back and stop the timer once. It is not a WCA
event and never will be -- `EventId` cannot hold it, `EVENTS` has no entry for
it, and `newScramble()` takes a single `EventId`.

The groundwork is already in place. `Discipline` (see `src/discipline.ts`)
has carried a `relay` variant since the sessions redesign; `disciplineKey`
serialises it as `relay:222+333+444+555`; `disciplineLabel` contracts a
contiguous NxN run to `2-5 Relay`; and `soleEvent` returns **null** for a
relay rather than silently taking the first leg, so every caller that needs
exactly one event is a compile-time-visible seam. No picker offers the relay
variant yet. This spec turns it on.

## Decisions

**Relays are custom-only.** There is no preset menu. Every relay is one the
user built.

**A relay has no home but its sessions.** Because relays are custom-only,
the set of relays that exist is exactly the set of distinct relay discipline
keys among the user's live sessions. No new table, no new synced entity, no
new localStorage key.

That forces one asymmetry, and it is deliberate: **creating a relay writes a
real session immediately, not a draft.** Events can be drafts because all 17
are permanently on offer, so nothing is lost by declining to persist one. A
relay that existed only as a draft would vanish on reload, discarding the
work of building it. Deleting a relay's last session is what removes the
relay from the picker -- which is the existing delete path, not a new one.

**Legs are stored in canonical `EVENTS` order**, not the order the user
ticked them. `disciplineKey` already treats order as significant, so a
reorder feature remains possible later; shipping a tick-order rule nobody
asked for would bake an arbitrary convention into every stored key.

**One relay attempt is one `Solve`.** Stats, PB, ao5, histogram and trend
read times, not events, and are untouched.

**Splits are optional and off by default.** Most attempts want a single
time; the ability to record per-leg splits is an opt-in extra.

## Scrambles

`newScramble(event)` gains a sibling:

```ts
newScrambles(d: Discipline): Promise<string[]>
```

one scramble per leg, generated with `Promise.all`. A single-event
discipline returns a one-element array, so the timer has one code path.

The timer renders one labelled block per leg rather than today's single
`<p className="scramble">`.

**Storage:** `Solve.scramble` stays a single `text` column with the legs
newline-joined. Leg order is recoverable from the session's discipline, so
this needs no column and no migration. The alternative -- a `scrambles`
array column -- buys nothing the join does not already give.

**Risk to check in the build, not dev.** cubing.js loads a random-state
solver per event in a web worker, on first use. A 2-5 relay's first scramble
loads four at once. Vite's preload helper has already broken cubing.js's
worker in the build and only in the build on this project, so this is
verified with `npm run build && npx vite preview` driven over CDP with a
polled DOM -- never a fixed timeout, and never `--virtual-time-budget`,
which cannot wait on CPU-bound wasm in a worker.

## Splits

`settings.trackSplits: boolean`, defaulting to false, mirroring
`settings.trackParity` exactly: a global toggle that is inert unless the
active discipline is a relay.

```ts
/**
 * Cumulative ms at each leg boundary. N-1 entries for an N-leg relay --
 * the final stop already IS timeMs, and storing it twice would let the two
 * disagree. Per-leg durations are derived. undefined means splits were not
 * recorded, which is different from an empty array, the same distinction
 * `parity` draws between untracked and measured-as-none.
 */
splits?: number[]
```

**Interaction:** with splits on, the space bar marks a leg boundary and the
Nth press stops the timer. With splits off, any key stops, as today.
`useTimer` grows an optional split callback alongside its existing `onStop`.

**Schema:** `public.solves` gains `splits integer[]`, nullable. Applied by
hand through the dashboard -- `npm run schema` cannot connect, as
`.env.local` holds no `DATABASE_URL`.

## What relays deliberately do not get

- **No daily challenge.** `isChallengeEvent` takes a plain string and rejects
  relay keys already, so `sync/engine.ts` excludes relays from the board with
  no change. The daily tab needs an explicit empty state for a relay
  discipline rather than rendering against an undefined event.
- **No parity.** `hasParity` never fires for a relay.
- **No friend-profile work.** `friend_sessions` returns the discipline key,
  `disciplineLabel` renders it as `2-5 Relay`, and the friend RPCs are
  session-keyed. A relay session appears in a friend's list and works.

## Testing

- `newScrambles` returns one scramble per leg, in leg order, and exactly one
  for a single-event discipline.
- Splits derivation: cumulative `[t1, t2, t3]` with `timeMs` t4 yields per-leg
  `[t1, t2-t1, t3-t2, t4-t3]`; an undefined `splits` yields no per-leg data
  rather than a zero-length list.
- A solve recorded with splits off stores `splits: undefined`, not `[]`.
- Relay round-tripping through `sessionToRow`/`rowToSession` and through
  `solveToRow`/`rowToSolve` including `splits`.
- `sync/engine.ts` publishes no daily best for a relay session (guarded today
  by `isChallengeEvent`; asserted so a future edit cannot quietly change it).
- Creating a relay writes a session immediately; deleting its last session
  removes the relay from the discipline list.
- In the built app over CDP: a 2-5 relay generates four scrambles, and a
  timed attempt with splits on records three boundaries plus `timeMs`.
