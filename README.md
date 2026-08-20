# CubeStats

A speedcubing timer in the spirit of csTimer, built to grow richer statistics.

## Status

Phase 1 — core timer, local only:

- WCA scrambles for all 17 official events via [cubing.js](https://js.cubing.net)
- Hold-space-to-start timing on `performance.now()`
- +2 / DNF penalties, delete, clear session
- best, mean, standard deviation, ao5, ao12, best ao5, best ao12
- named sessions (up to 20), each bound to an event, so two 3x3 sessions can coexist
- click any solve for its scramble, date, and penalty controls
- solves persist in `localStorage`, per session
- settings: theme (system/light/dark), stopwatch or hand-typed entry, hide the
  time while solving, parity tracking
- per-session accent colour, applied across the interface
- stats tab: solve-time distribution (0.05–1s bins) and a chronological
  trend with a rolling mean overlaid
- parity tracking on 4x4–7x7: one prompt per solve, a distribution stacked by
  parity category, and mean/sd per category with the gap to the clean mean
- sub-X rate against a per-session goal
- practice calendar: solves per day, shaded by quartile of your active days
- rolling p25–p75 band on the trend chart, alongside the rolling mean
- import from csTimer: each session becomes a session here, keeping scrambles
  and dates, with the event detected from its scramble type and overridable

Planned: Supabase accounts and cloud sync (phase 2), then deeper statistics —
trend graphs, time distributions, per-session comparison (phase 3).

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests
npm run typecheck
```

## Cloud sync (optional)

The app is local-first: it works fully with no account and no network, storing
solves in `localStorage`. Signing in adds cross-device sync and takes your
existing local solves with you.

To enable it, create a [Supabase](https://supabase.com) project, then:

1. Run `supabase/schema.sql` in the dashboard's SQL Editor. It creates two
   tables with Row Level Security, which is what keeps one user's solves
   invisible to another.
2. Under **Authentication → Providers**, enable **Email**.
3. Under **Authentication → URL Configuration**, add your dev and production
   origins to **Redirect URLs**.
4. Copy `.env.example` to `.env.local` and fill in the project URL and anon
   key from **Project Settings → API**.

The anon key belongs in the browser bundle — it identifies the project, not a
user, and RLS protects the data. The `service_role` key must never be used
here. With the variables unset, the app runs local-only and hides sign-in.

## Controls

Hold **space** until the timer turns green, release to start, press any key to stop.
