import { useEffect, useState } from 'react'
import { utcDay } from './daily'
import {
  currentStreak,
  friendDaily,
  friendProfile,
  friendSessions,
  type FriendDailyView,
  type FriendProfileView,
  type FriendSessionView,
} from './friends'
import { disciplineLabel, parseDiscipline, soleEvent } from './discipline'
import { FriendCalendar } from './FriendCalendar'
import { formatMs } from './format'
import { averageOf } from './stats'
import type { Solve } from './types'

const WEEKS = 12

/**
 * You pick between the friend's SESSIONS here, not between all 17 WCA events.
 *
 * The event picker this replaces existed only because the RPCs took an event
 * and aggregated across every session the friend had for it -- so it asked a
 * question the friend never organised their practice by, and offered 17
 * choices of which they might have solves for two.
 */
export function FriendProfile({
  userId,
  username,
  onClose,
}: {
  userId: string
  username: string
  onClose: () => void
}) {
  // null = loading, 'error' = the call failed, an array = success (possibly
  // empty, which is a friend with no solves -- not an error).
  const [sessions, setSessions] = useState<FriendSessionView[] | null | 'error'>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // null = loading, 'error' = the call genuinely failed, an object = success
  // (possibly with total: 0, which is a normal empty state, not an error).
  const [view, setView] = useState<FriendProfileView | null | 'error'>(null)
  // Same three states as `view`, but for today's daily-challenge result --
  // kept separate so a failure in one call never blanks or masks the other.
  // 'none' is success-with-no-data (not friends, no attempt, or revealed but
  // never submitted -- friendDaily's docstring covers why those collapse
  // into one calm state rather than an error).
  const [daily, setDaily] = useState<FriendDailyView | 'none' | null | 'error'>(null)
  // Bumped by the retry button to force the effects below to run again for
  // the same userId/session.
  const [attempt, setAttempt] = useState(0)

  // Same staleness pattern as the two effects below. Selecting the first
  // session here (rather than leaving it null) is what makes the profile
  // land on something useful immediately: friend_sessions orders by most
  // recent solve, so that is the log they are actually practising.
  useEffect(() => {
    let stale = false
    setSessions(null)
    setSessionId(null)
    friendSessions(userId).then((v) => {
      if (stale) return
      setSessions(v ?? 'error')
      if (v && v.length > 0) setSessionId(v[0].id)
    })
    return () => {
      stale = true
    }
  }, [userId, attempt])

  const chosen =
    sessions === null || sessions === 'error'
      ? undefined
      : sessions.find((s) => s.id === sessionId)
  // The daily challenge is per-EVENT, not per-session, so it needs the one
  // event behind the chosen session's discipline -- and there isn't one for a
  // relay, which is why the panel is omitted rather than guessing a leg.
  const dailyEvent = chosen
    ? soleEvent(parseDiscipline(chosen.discipline) ?? { kind: 'relay', events: [] })
    : null

  // `stale` is local to each run of this effect, not a ref shared across
  // runs: switching friends or events while a fetch is in flight starts a
  // new run with its own `stale` binding, so the OLD run's cleanup flips
  // only the OLD run's flag. When the old run's fetch resolves afterwards,
  // its own `stale` is true and the response is dropped -- only the newest
  // request's response can ever land. Unmounting mid-fetch runs the same
  // cleanup, so no state is written after unmount either.
  useEffect(() => {
    if (!sessionId) return
    let stale = false
    setView(null)
    friendProfile(userId, sessionId, WEEKS * 7).then((v) => {
      if (!stale) setView(v ?? 'error')
    })
    return () => {
      stale = true
    }
  }, [userId, sessionId, attempt])

  // Separate effect, same staleness pattern: this call is independent of the
  // one above, so switching event/friend/retry must not let a slow response
  // from one land after a newer request for the other has already started.
  useEffect(() => {
    if (!dailyEvent) return
    let stale = false
    setDaily(null)
    friendDaily(userId, dailyEvent).then((v) => {
      if (!stale) setDaily(v === null ? 'error' : v)
    })
    return () => {
      stale = true
    }
  }, [userId, dailyEvent, attempt])

  // The friend's ao12 is computed by the SAME function that computes yours, so
  // the two can never disagree. averageOf only reads timeMs/penalty, so the
  // bare integers are wrapped in exactly that shape -- not a fabricated Solve.
  const asSolves: Pick<Solve, 'timeMs' | 'penalty'>[] =
    view === null || view === 'error'
      ? []
      : view.recentMs.map((ms) => ({
          timeMs: ms ?? 0,
          penalty: ms === null ? 'dnf' : ('none' as const),
        }))
  const ao12 = averageOf(asSolves, 12)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="friend-profile modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>{username}</h2>
          <button className="ghost small" onClick={onClose}>
            Back
          </button>
        </div>

        {/* Their sessions, not a list of events. Each row carries its
            discipline label as well as its name, so the puzzle is never
            implicit in a name the viewer did not write. */}
        {sessions === null ? (
          <p className="note">Loading {username}&apos;s sessions…</p>
        ) : sessions === 'error' ? (
          <p className="error">
            Could not load {username}&apos;s sessions.{' '}
            <button className="link" onClick={() => setAttempt((n) => n + 1)}>
              Try again.
            </button>
          </p>
        ) : sessions.length === 0 ? (
          <p className="empty">{username} has no solves yet.</p>
        ) : (
          <label className="ctrl">
            Session
            <select
              value={sessionId ?? ''}
              onChange={(e) => setSessionId(e.target.value)}
              aria-label="Friend's session"
            >
              {sessions.map((s) => {
                const d = parseDiscipline(s.discipline)
                return (
                  <option key={s.id} value={s.id}>
                    {s.name} · {d ? disciplineLabel(d) : s.discipline} ({s.solves})
                  </option>
                )
              })}
            </select>
          </label>
        )}

        {!sessionId ? null : view === null ? (
          <p className="note">Loading {username}…</p>
        ) : view === 'error' ? (
          <p className="error">
            Could not load {username}&apos;s practice.{' '}
            <button className="link" onClick={() => setAttempt((n) => n + 1)}>
              Try again.
            </button>
          </p>
        ) : (
          <>
            {/* Today's UTC date, matching how friend_calendar/friend_stats
                bucket days and how FriendCalendar computes "today" for its
                own grid -- all three must agree on the same calendar day or
                the streak and the grid it is drawn from would disagree at
                the boundary. */}
            <table className="figures secondary">
              <tbody>
                <tr>
                  <th>best</th>
                  <td>{view.bestMs === null ? '—' : formatMs(view.bestMs)}</td>
                </tr>
                <tr>
                  <th>ao12</th>
                  <td>{typeof ao12 === 'number' ? formatMs(ao12) : ao12 === null ? 'DNF' : '—'}</td>
                </tr>
                <tr>
                  <th>solves</th>
                  <td>{view.total}</td>
                </tr>
                {(() => {
                  const streak = currentStreak(view.days, utcDay(Date.now()))
                  return (
                    <tr>
                      <th>streak</th>
                      <td>
                        {streak} day{streak === 1 ? '' : 's'}
                      </td>
                    </tr>
                  )
                })()}
              </tbody>
            </table>

            {/* Omitted entirely for a relay: there is no daily challenge for
                one, so there is nothing to be loading or missing. */}
            {dailyEvent && (
            <div className="friend-daily">
              {daily === null ? (
                <p className="note">Loading today&apos;s result…</p>
              ) : daily === 'error' ? (
                <p className="error">
                  Could not load today&apos;s result.{' '}
                  <button className="link" onClick={() => setAttempt((n) => n + 1)}>
                    Try again.
                  </button>
                </p>
              ) : daily === 'none' ? (
                <p className="empty">No result for today&apos;s challenge yet.</p>
              ) : (
                <p className="note">
                  Today: <strong>{daily.timeMs === null ? 'DNF' : formatMs(daily.timeMs)}</strong>
                </p>
              )}
            </div>
            )}

            {view.total === 0 ? (
              <p className="empty">No solves in this session yet.</p>
            ) : (
              <FriendCalendar days={view.days} weeks={WEEKS} />
            )}
          </>
        )}
      </section>
    </div>
  )
}
