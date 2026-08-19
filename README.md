# Cube Timer

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
- settings: stopwatch or hand-typed entry, hide the time while solving,
  parity tracking
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
npm run dev
```

## Controls

Hold **space** until the timer turns green, release to start, press any key to stop.
