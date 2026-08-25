import type { ParityId } from '../parity'
import type { Session, Solve } from '../types'

/** Database row shapes. snake_case here, camelCase everywhere else. */
export interface SessionRow {
  id: string
  user_id: string
  name: string
  /**
   * The session's discipline key. The column keeps its old name: a
   * single-event key is byte-identical to the EventId that used to live
   * here, so every existing row is already valid and renaming the column
   * would buy nothing but a migration.
   */
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
  splits: number[] | null
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
    event: s.discipline,
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
    discipline: r.event,
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
    // null means untracked, [] means tracked with no boundaries -- the same
    // distinction `parity` draws directly above. Round for the same reason
    // as time_ms: useTimer stores fractional performance.now() deltas, and
    // the column is integer[] -- an unrounded value throws in Postgres and
    // aborts the tick before the pull and cursor write, deadlocking sync.
    splits: s.splits?.map(Math.round) ?? null,
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
    splits: r.splits ?? undefined,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    deleted: r.deleted,
  }
}
