# CLAUDE.md

## Verifying work

```bash
npm test          # vitest
npm run build     # runs `tsc -b` first, so this typechecks
npm run typecheck
```

`npx tsc --noEmit` is a **no-op** here — the root `tsconfig.json` is a
solution file with only project references, so it silently checks nothing and
reports success. Use `tsc -b` or `npm run build`.

## Test the built output, not just dev

Dev and production differ in ways that have already shipped a broken site
once: Vite's preload helper crashed cubing.js's web worker in the build only,
so every scramble failed while dev looked perfect. Before claiming a change
works, run `npm run build && npx vite preview` and check that.

Headless Chrome's `--virtual-time-budget` cannot wait on CPU-bound wasm in a
worker and will make a working build look like a hanging one. To check
anything asynchronous, drive a real browser over CDP
(`--remote-debugging-port`) and poll the DOM.

## Never commit

- `.env.local` — contains Supabase credentials, and briefly a database
  password during setup.
- `cstimer_*.txt` — the user's personal solve export, used as test data.

Both are gitignored. The Supabase **anon key is public by design** and belongs
in the bundle; the **service_role key must never enter this repo**.

## Sync invariants

Every row mutation must go through `touch()` or `tombstone()` in
`src/sync/stamp.ts`. A row edited without bumping `updatedAt` loses the next
reconciliation and silently reverts. Deletes are **soft** — a hard delete is
invisible to another device, which then resurrects the row. Tombstones stay in
the store and are filtered at the UI boundary by `visible()`.

## Grants are not optional, and `from public` is a trap

RLS is the whole boundary here, but **policies only run if the caller could
reach the object at all** — and Supabase's default privileges
(`grant all ... to anon, authenticated, service_role`) hand out that reach
explicitly, per role, the moment you create a table or function.

Two consequences, both of which shipped as live holes on the phase 3 branch:

- **`revoke all ... from public` locks down nothing.** `PUBLIC` is a separate
  pseudo-role; the per-role grants survive it. Revoke by name:
  `revoke all on function f(args) from public, anon, authenticated;` then grant
  back only what is needed. `are_friends` stayed callable by anyone holding the
  public anon key for exactly this reason.
- **A policy cannot stop a column being rewritten.** RLS `with check` only sees
  the NEW row, so it cannot express "this column did not change". Use a
  column-level grant — `grant update (state) on public.friendships to
  authenticated`. Without it, `grant all on tables` let the addressee of a
  pending friend request accept it while rewriting `requester` to an arbitrary
  victim, manufacturing a friendship that victim never consented to.

`profiles` has the right pattern (`revoke all`, then column-scoped `grant
select`). Copy it. And **verify against the live database, not by reading** —
both holes passed code review, and one reviewer reasoned from theory that anon
was blocked and was wrong. A probe with the public anon key takes a minute.

## Charts

Validate any new chart colours before shipping them, against **both** theme
surfaces (`--panel` is `#ffffff` light, `#171717` dark — read them from
`src/index.css`, don't trust this file) using the dataviz skill's
`scripts/validate_palette.js`. Don't eyeball colour-blind safety.

That script is **not in this repo and not in `~/.claude`** — it ships bundled
with the dataviz skill, so invoke the skill and use the base directory it
prints. A discrete-bucket ramp like an activity grid wants `--ordinal`, not the
default sequential mode: every bucket must clear the surface rather than being
allowed to recede into it.

Colour tokens live in **three** blocks in `src/index.css` — bare `:root`, the
`prefers-color-scheme` media query, and `:root[data-theme='dark']`. A token
defined in only the first two breaks the explicit light/dark toggle in one
direction. Dark ramps are *chosen*, not flipped: on a dark surface more of a
thing must read as more prominent, so the ramp runs toward the light end.

## Deployment

`main` auto-deploys to Vercel (~10s). Supabase auth redirect URLs must list
every origin used, or magic links bounce.
