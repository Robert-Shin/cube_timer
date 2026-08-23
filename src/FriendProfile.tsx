import { useEffect, useState } from 'react'
import { friendProfile, type FriendProfileView } from './friends'
import { FriendCalendar } from './FriendCalendar'
import { formatMs } from './format'
import { averageOf } from './stats'
import type { EventId, Solve } from './types'

const WEEKS = 12

export function FriendProfile({
  userId,
  username,
  event,
  onClose,
}: {
  userId: string
  username: string
  event: EventId
  onClose: () => void
}) {
  // null = loading, 'error' = the call genuinely failed, an object = success
  // (possibly with total: 0, which is a normal empty state, not an error).
  const [view, setView] = useState<FriendProfileView | null | 'error'>(null)
  // Bumped by the retry button to force the effect below to run again for
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

  if (view === null)
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
          <p className="note">Loading {username}…</p>
        </div>
      </div>
    )
  if (view === 'error')
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
          <p className="error">
            Could not load {username}&apos;s practice.{' '}
            <button className="link" onClick={() => setAttempt((n) => n + 1)}>
              Try again.
            </button>
          </p>
        </div>
      </div>
    )

  // The friend's ao12 is computed by the SAME function that computes yours, so
  // the two can never disagree. averageOf only reads timeMs/penalty, so the
  // bare integers are wrapped in exactly that shape -- not a fabricated Solve.
  const asSolves: Pick<Solve, 'timeMs' | 'penalty'>[] = view.recentMs.map((ms) => ({
    timeMs: ms ?? 0,
    penalty: ms === null ? 'dnf' : 'none',
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
          </tbody>
        </table>

        {view.total === 0 ? (
          <p className="empty">No solves for this event yet.</p>
        ) : (
          <FriendCalendar days={view.days} weeks={WEEKS} />
        )}
      </section>
    </div>
  )
}
