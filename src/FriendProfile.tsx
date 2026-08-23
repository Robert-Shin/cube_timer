import { useEffect, useState } from 'react'
import {
  currentStreak,
  friendDaily,
  friendProfile,
  type FriendDailyView,
  type FriendProfileView,
} from './friends'
import { FriendCalendar } from './FriendCalendar'
import { formatMs } from './format'
import { averageOf } from './stats'
import { EVENTS, type EventId, type Solve } from './types'

const WEEKS = 12

export function FriendProfile({
  userId,
  username,
  event,
  onEventChange,
  onClose,
}: {
  userId: string
  username: string
  event: EventId
  onEventChange: (event: EventId) => void
  onClose: () => void
}) {
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
  // the same userId/event.
  const [attempt, setAttempt] = useState(0)

  // `stale` is local to each run of this effect, not a ref shared across
  // runs: switching friends or events while a fetch is in flight starts a
  // new run with its own `stale` binding, so the OLD run's cleanup flips
  // only the OLD run's flag. When the old run's fetch resolves afterwards,
  // its own `stale` is true and the response is dropped -- only the newest
  // request's response can ever land. Unmounting mid-fetch runs the same
  // cleanup, so no state is written after unmount either.
  useEffect(() => {
    let stale = false
    setView(null)
    friendProfile(userId, event, WEEKS * 7).then((v) => {
      if (!stale) setView(v ?? 'error')
    })
    return () => {
      stale = true
    }
  }, [userId, event, attempt])

  // Separate effect, same staleness pattern: this call is independent of the
  // one above, so switching event/friend/retry must not let a slow response
  // from one land after a newer request for the other has already started.
  useEffect(() => {
    let stale = false
    setDaily(null)
    friendDaily(userId, event).then((v) => {
      if (!stale) setDaily(v === null ? 'error' : v)
    })
    return () => {
      stale = true
    }
  }, [userId, event, attempt])

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

        {/* Defaults to the viewer's own session event (via the `event` prop),
            then is freely changeable -- otherwise a friend's 4x4 can only be
            seen while the viewer is themselves on 4x4. Reuses the same
            EVENTS list SessionManager/ImportDialog use for their event
            pickers, so this never drifts from what the rest of the app
            considers a choosable event. */}
        <label className="ctrl">
          Event
          <select
            value={event}
            onChange={(e) => onEventChange(e.target.value as EventId)}
            aria-label="Friend's event"
          >
            {EVENTS.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </label>

        {view === null ? (
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
                  const streak = currentStreak(view.days, new Date().toISOString().slice(0, 10))
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

            {view.total === 0 ? (
              <p className="empty">No solves for this event yet.</p>
            ) : (
              <FriendCalendar days={view.days} weeks={WEEKS} />
            )}
          </>
        )}
      </section>
    </div>
  )
}
