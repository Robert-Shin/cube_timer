#!/usr/bin/env node
/**
 * Generates the daily challenge's shared scrambles, as a plain Node script
 * rather than a Supabase Edge Function.
 *
 * A Supabase Edge Function was tried first (see
 * .superpowers/sdd/2026-08-20-daily-challenge/task-5-report.md). It failed
 * at runtime with "Module worker instantiation failed. There are no more
 * fallbacks available.": cubing/scramble's randomScrambleForEvent always
 * offloads to a Web Worker with no non-worker code path, and Supabase's Edge
 * Runtime refuses to spawn a worker from inside a user function. Plain Node
 * has full Worker support, so this runs the exact same library successfully
 * (confirmed: a 4x4 scramble generates in ~1.4s under Node). Do not
 * re-attempt the Edge Function -- the gap is in the platform, not the code.
 *
 * A client can never generate its own scramble for this feature: a
 * client-supplied "scramble" could be four moves from solved, and Postgres
 * cannot validate a scramble without cubing.js's wasm solver. So this script
 * must run somewhere trusted and write with the service_role key.
 *
 * Generates a WINDOW of days (default 30, override via argv[2]), not just
 * today, so a missed run never leaves the board without a scramble. Every
 * day uses the UTC calendar day -- new Date().toISOString().slice(0, 10),
 * the same convention as utcDay() in src/daily.ts -- never local time.
 *
 * Idempotent by construction: upserts with onConflict: 'event,utc_day' and
 * ignoreDuplicates: true. A scramble that someone may already have been
 * shown must never change underneath them, so an existing row -- including
 * its created_at -- is left exactly as it is. Safe to run repeatedly, e.g.
 * from a manually-triggered schedule the user sets up separately; this
 * script does not schedule itself.
 *
 *   npm run scrambles
 *   node scripts/generate-scrambles.mjs 60
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { randomScrambleForEvent } from 'cubing/scramble'

// Must match the event list the rest of the daily-challenge feature uses.
const EVENTS = ['222', '333', '444', '555', '666', '777', 'minx', 'pyram', 'skewb', 'sq1', 'clock']

function readEnv(file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // Missing file is reported below with a usable message.
  }
  return out
}

const env = { ...readEnv(new URL('../.env.local', import.meta.url).pathname), ...process.env }
const URL_ = env.VITE_SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY

if (!URL_ || !SERVICE) {
  console.error(
    'Missing configuration. .env.local needs VITE_SUPABASE_URL and\n' +
      'SUPABASE_SERVICE_ROLE_KEY.\n\n' +
      'The service_role key is admin-level: it belongs only in .env.local\n' +
      '(gitignored) and must NOT be given a VITE_ prefix, or Vite would\n' +
      'inline it into the public bundle.',
  )
  process.exit(1)
}

const days = Number.parseInt(process.argv[2], 10) || 30
if (!Number.isFinite(days) || days < 1) {
  console.error(`Invalid day count: ${process.argv[2]}`)
  process.exit(1)
}

// The UTC calendar day for N days out from today, as 'YYYY-MM-DD' -- the
// same convention as utcDay() in src/daily.ts. Built from a UTC midnight
// anchor plus a day offset so it never drifts into local time.
function utcDayOffset(n) {
  const anchor = new Date()
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const dayList = Array.from({ length: days }, (_, i) => utcDayOffset(i))
console.log(`Generating scrambles for ${EVENTS.length} events x ${days} days ` +
  `(${dayList[0]} through ${dayList[dayList.length - 1]})...`)

const started = Date.now()
let generated = 0
let existing = 0
let failed = 0

for (const day of dayList) {
  for (const event of EVENTS) {
    // Checked before generating, not after: a wasm scramble search costs up
    // to ~1.4s (4x4), and re-running this script over a mostly-already-filled
    // window should cost a row lookup per slot, not a full re-solve for
    // every slot it is about to throw away.
    const { data: before } = await admin
      .from('daily_scrambles')
      .select('event')
      .eq('event', event)
      .eq('utc_day', day)
      .maybeSingle()

    if (before) {
      existing++
      continue
    }

    let scramble
    try {
      const alg = await randomScrambleForEvent(event)
      scramble = alg.toString()
    } catch (e) {
      failed++
      console.error(`  scramble generation failed for ${event}/${day}: ${e.message}`)
      continue
    }

    // ignoreDuplicates + onConflict means an existing row -- including its
    // created_at -- is left completely untouched even if another run raced
    // this one between the check above and this write.
    const { error } = await admin
      .from('daily_scrambles')
      .upsert(
        { event, utc_day: day, scramble },
        { onConflict: 'event,utc_day', ignoreDuplicates: true },
      )

    if (error) {
      failed++
      console.error(`  upsert failed for ${event}/${day}: ${error.message}`)
      continue
    }

    generated++
  }
}

const elapsedS = ((Date.now() - started) / 1000).toFixed(1)
console.log(
  `\nDone in ${elapsedS}s. generated=${generated} already-existed=${existing} failed=${failed} ` +
    `range=${dayList[0]}..${dayList[dayList.length - 1]}`,
)

if (failed > 0) {
  console.error(`${failed} scramble(s) failed -- see errors above.`)
  process.exit(1)
}
