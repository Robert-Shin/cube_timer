# Cube Timer

A speedcubing timer in the spirit of csTimer, built to grow richer statistics.

## Status

Phase 1 — core timer, local only:

- WCA random-state scrambles (3x3, 2x2, 4x4) via [cubing.js](https://js.cubing.net)
- Hold-space-to-start timing on `performance.now()`
- +2 / DNF penalties, delete, clear session
- best, mean, ao5, ao12, best ao5, best ao12
- solves persist in `localStorage`, per event
- settings: stopwatch or hand-typed entry, hide the time while solving
- stats tab: solve-time distribution (0.05–1s bins) and a chronological
  trend with a rolling mean overlaid
- import from csTimer, choosing per session which event it belongs to

Planned: Supabase accounts and cloud sync (phase 2), then deeper statistics —
trend graphs, time distributions, per-session comparison (phase 3).

## Develop

```bash
npm install
npm run dev
```

## Controls

Hold **space** until the timer turns green, release to start, press any key to stop.
