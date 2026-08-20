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

## Charts

Validate any new chart colours before shipping them, against **both** theme
surfaces (`--panel` is `#fffdfa` light, `#1c1a17` dark) using the dataviz
skill's `scripts/validate_palette.js`. Don't eyeball colour-blind safety.

## Deployment

`main` auto-deploys to Vercel (~10s). Supabase auth redirect URLs must list
every origin used, or magic links bounce.
