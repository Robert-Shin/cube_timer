import type { EventId, Penalty, Solve } from './types'

/**
 * csTimer export format (the JSON its "export to file" produces):
 *
 *   {
 *     "session1": [ [[penalty, timeMs], scramble, comment, unixSeconds], ... ],
 *     "properties": { "sessionData": "<JSON string>", ... }
 *   }
 *
 * `sessionData` maps the number in each "sessionN" key to that session's name
 * and options, including `opt.scrType` -- the scramble type, which is the most
 * reliable signal of which event the session holds.
 */

/** penalty field: 0 = clean, -1 = DNF, anything else = penalty ms (2000 = +2). */
function readPenalty(flag: number, timeMs: number): { penalty: Penalty; raw: number } {
  if (flag === -1) return { penalty: 'dnf', raw: timeMs }
  if (flag === 2000) {
    // csTimer stores the penalised total, so recover the raw time we store.
    return { penalty: 'plus2', raw: Math.max(0, timeMs - 2000) }
  }
  return { penalty: 'none', raw: timeMs }
}

/**
 * csTimer scramble type -> WCA event. Its ids encode the puzzle plus a
 * generator variant ("222so" = 2x2 optimal, "444wca" = 4x4 WCA), so the
 * prefix is what identifies the puzzle.
 */
const SCR_TYPES: [RegExp, EventId][] = [
  [/^333(ni|bldni)/, '333bf'],
  [/^333fm/, '333fm'],
  [/^333oh/, '333oh'],
  [/^333mbf|^r3ni/, '333mbf'],
  [/^333/, '333'],
  [/^222/, '222'],
  [/^444bld|^444ni/, '444bf'],
  [/^444/, '444'],
  [/^555bld|^555ni/, '555bf'],
  [/^555/, '555'],
  [/^666/, '666'],
  [/^777/, '777'],
  [/^clk/, 'clock'],
  [/^mgm|^minx/, 'minx'],
  [/^pyr/, 'pyram'],
  [/^skb/, 'skewb'],
  [/^sq1|^sqrs/, 'sq1'],
]

/** Session names people actually use, for when scrType is absent. */
const NAME_HINTS: [RegExp, EventId][] = [
  [/\bmulti|\bmbld/, '333mbf'],
  [/3\s*bld|333ni|\bbld\b/, '333bf'],
  [/4\s*bld/, '444bf'],
  [/5\s*bld/, '555bf'],
  [/\bfmc|fewest/, '333fm'],
  [/\boh\b|one.?hand/, '333oh'],
  [/2x2|\b222\b/, '222'],
  [/4x4|\b444\b/, '444'],
  [/5x5|\b555\b/, '555'],
  [/6x6|\b666\b/, '666'],
  [/7x7|\b777\b/, '777'],
  [/clock/, 'clock'],
  [/mega|minx/, 'minx'],
  [/pyra/, 'pyram'],
  [/skewb/, 'skewb'],
  [/sq.?1|square/, 'sq1'],
  [/3x3|\b333\b/, '333'],
]

/** Maps a csTimer session to a WCA event, or null when we can't tell. */
function eventFromScrType(scrType: string | undefined, name: string): EventId | null {
  const n = name.toLowerCase()
  // A relay session borrows a real generator (a 2-5 relay scrambles with
  // 555wca), so the name has to override the scramble type here.
  if (/relay/.test(n)) return null

  const s = (scrType || '').toLowerCase()
  if (s) {
    for (const [re, event] of SCR_TYPES) if (re.test(s)) return event
    return null // an unrecognised generator -- custom types, etc.
  }

  // No scrType means csTimer's default of 3x3, but users rename sessions and
  // reuse them, so let an explicit name in the title win over that default.
  for (const [re, event] of NAME_HINTS) if (re.test(n)) return event
  return '333'
}

export interface CstimerSession {
  /** The "sessionN" key in the export. */
  key: string
  name: string
  solveCount: number
  scrType?: string
  /** Our best guess at the event, or null when we can't map it. */
  detectedEvent: EventId | null
  /** Earliest and latest solve dates, ms. Null when the session is empty. */
  from: number | null
  to: number | null
}

export interface ParsedCstimer {
  sessions: CstimerSession[]
  /** Raw solve rows kept by session key, converted on import. */
  raw: Record<string, unknown[]>
}

export class CstimerParseError extends Error {}

export function parseCstimerExport(text: string): ParsedCstimer {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    throw new CstimerParseError("That file isn't valid JSON. Use csTimer's Export > to file.")
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CstimerParseError('That file does not look like a csTimer export.')
  }

  // sessionData is itself a JSON *string* inside properties.
  let meta: Record<string, { name?: unknown; opt?: { scrType?: string } }> = {}
  const props = data.properties as { sessionData?: string } | undefined
  if (props?.sessionData) {
    try {
      meta = JSON.parse(props.sessionData)
    } catch {
      // Metadata is a nice-to-have; solves still import without it.
    }
  }

  const sessions: CstimerSession[] = []
  const raw: Record<string, unknown[]> = {}

  for (const [key, value] of Object.entries(data)) {
    const n = /^session(\d+)$/.exec(key)?.[1]
    if (!n || !Array.isArray(value)) continue

    const info = meta[n] ?? {}
    // Unnamed sessions get a numeric name in the export, not a string.
    const name = info.name != null ? String(info.name) : `Session ${n}`
    const scrType = info.opt?.scrType

    const times = value
      .map((row) => (Array.isArray(row) ? Number(row[3]) * 1000 : NaN))
      .filter((t) => Number.isFinite(t) && t > 0)

    sessions.push({
      key,
      name,
      solveCount: value.length,
      scrType,
      detectedEvent: eventFromScrType(scrType, name),
      from: times.length ? Math.min(...times) : null,
      to: times.length ? Math.max(...times) : null,
    })
    raw[key] = value
  }

  if (sessions.length === 0) {
    throw new CstimerParseError('No sessions found in that file.')
  }
  sessions.sort((a, b) => b.solveCount - a.solveCount)
  return { sessions, raw }
}

/**
 * Converts one csTimer session's rows into our Solve shape, filed under the
 * given session. The original scramble and timestamp are preserved, so an
 * imported solve can be inspected exactly like one timed here.
 */
export function convertSession(rows: unknown[], sessionId: string): Solve[] {
  const out: Solve[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || !Array.isArray(row[0])) continue
    const timeMs = Number(row[0][1])
    if (!Number.isFinite(timeMs) || timeMs <= 0) continue

    const { penalty, raw } = readPenalty(Number(row[0][0]), timeMs)
    const stamp = Number(row[3])
    out.push({
      id: crypto.randomUUID(),
      sessionId,
      // csTimer records no parity information, so imported solves come in as
      // clean. That is an assumption, not a measurement: if the session
      // actually had parities, the no-parity mean will read slightly slow.
      parity: [],
      scramble: typeof row[1] === 'string' ? row[1] : '',
      timeMs: raw,
      penalty,
      createdAt: Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : Date.now(),
      // Imported now, so this is genuinely when the row last changed.
      updatedAt: Date.now(),
    })
  }
  return out
}
