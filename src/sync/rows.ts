import type { ParityId } from '../parity'
import type { EventId, Session, Solve } from '../types'

/** Database row shapes. snake_case here, camelCase everywhere else. */
export interface SessionRow {
  id: string
  user_id: string
  name: string
  event: string
  goal_ms: number | null
  color: number | null
  created_at: string
  updated_at: string
  deleted: boolean
}

export interface SolveRow {
  id: string
  user_id: string
  session_id: string
  scramble: string
  time_ms: number
  penalty: string
  parity: string[] | null
  created_at: string
  updated_at: string
  deleted: boolean
}

// Timestamps travel as ISO strings and are stored as our own client stamps,
// so a pull compares like with like rather than against server time.
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string) => new Date(s).getTime()

export function sessionToRow(s: Session, userId: string): SessionRow {
  return {
    id: s.id,
    user_id: userId,
    name: s.name,
    event: s.event,
    goal_ms: s.goalMs ?? null,
    color: s.color ?? null,
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
    deleted: s.deleted ?? false,
  }
}

export function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    name: r.name,
    event: r.event as EventId,
    goalMs: r.goal_ms ?? undefined,
    color: r.color ?? undefined,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    deleted: r.deleted,
  }
}

export function solveToRow(s: Solve, userId: string): SolveRow {
  return {
    id: s.id,
    user_id: userId,
    session_id: s.sessionId,
    scramble: s.scramble,
    time_ms: Math.round(s.timeMs),
    penalty: s.penalty,
    // null means untracked, [] means measured as clean. Collapsing the two
    // would bias every parity comparison.
    parity: s.parity ?? null,
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
    deleted: s.deleted ?? false,
  }
}

export function rowToSolve(r: SolveRow): Solve {
  return {
    id: r.id,
    sessionId: r.session_id,
    scramble: r.scramble,
    timeMs: r.time_ms,
    penalty: r.penalty as Solve['penalty'],
    parity: r.parity ? (r.parity as ParityId[]) : r.parity === null ? undefined : [],
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    deleted: r.deleted,
  }
}
