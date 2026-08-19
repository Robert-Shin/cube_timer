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

/** Maps a csTimer scramble type to one of our events, or null if unsupported. */
function eventFromScrType(scrType: string | undefined, name: string): EventId | null {
  const s = (scrType || '').toLowerCase()
  if (s.startsWith('222')) return '222'
  if (s.startsWith('444')) return '444'
  if (s.startsWith('333')) {
    // One-handed, blindfolded etc. are still 3x3 scrambles but different events;
    // only plain 3x3 maps cleanly onto what we support.
    return s === '333' || s === '333wca' ? '333' : null
  }
  if (s) return null // 555, megaminx, clock, ... -- not ours

  // No scrType means csTimer's default, which is 3x3. Sanity-check the name,
  // since users rename sessions freely.
  const n = name.toLowerCase()
  if (n.includes('2x2')) return '222'
  if (n.includes('4x4')) return '444'
  if (/5x5|6x6|7x7|mega|pyra|skewb|sq1|clock|bld|relay|oh/.test(n)) return null
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

/** Converts one session's rows into our Solve shape under the chosen event. */
export function convertSession(rows: unknown[], event: EventId): Solve[] {
  const out: Solve[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || !Array.isArray(row[0])) continue
    const timeMs = Number(row[0][1])
    if (!Number.isFinite(timeMs) || timeMs <= 0) continue

    const { penalty, raw } = readPenalty(Number(row[0][0]), timeMs)
    const stamp = Number(row[3])
    out.push({
      id: crypto.randomUUID(),
      event,
      scramble: typeof row[1] === 'string' ? row[1] : '',
      timeMs: raw,
      penalty,
      createdAt: Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : Date.now(),
    })
  }
  return out
}
