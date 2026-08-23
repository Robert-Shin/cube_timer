import { useEffect, useRef, useState } from 'react'
import { friendProfile, type FriendProfileView } from './friends'
import { PracticeCalendar } from './PracticeCalendar'
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

  // Consulted after the fetch below. Reset at the start of every run of this
  // effect, not just once on mount: switching friends or events while a
  // fetch is in flight must not let the stale response land on the new
  // selection, and unmounting mid-fetch must not write state at all.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    setView(null)
    friendProfile(userId, event, WEEKS * 7).then((v) => {
      if (mounted.current) setView(v ?? 'error')
    })
    return () => {
      mounted.current = false
    }
  }, [userId, event])

  if (view === null) return <p className="note">Loading {username}…</p>
  if (view === 'error') return <p className="error">Could not load {username}&apos;s practice. Try again.</p>

  // The friend's ao12 is computed by the SAME function that computes yours, so
  // the two can never disagree. averageOf only reads timeMs/penalty, so the
  // bare integers are wrapped in exactly that shape -- not a fabricated Solve.
  const asSolves: Pick<Solve, 'timeMs' | 'penalty'>[] = view.recentMs.map((ms) => ({
    timeMs: ms ?? 0,
    penalty: ms === null ? 'dnf' : 'none',
  }))
  const ao12 = averageOf(asSolves, 12)

  return (
    <section className="friend-profile">
      <h2>{username}</h2>
      <button onClick={onClose}>Back</button>

      <dl className="figures">
        <dt>best</dt>
        <dd>{view.bestMs === null ? '—' : formatMs(view.bestMs)}</dd>
        <dt>ao12</dt>
        <dd>{typeof ao12 === 'number' ? formatMs(ao12) : ao12 === null ? 'DNF' : '—'}</dd>
        <dt>solves</dt>
        <dd>{view.total}</dd>
      </dl>

      {view.total === 0 ? (
        <p className="empty">No solves for this event yet.</p>
      ) : (
        <PracticeCalendar days={view.days} weeks={WEEKS} />
      )}
    </section>
  )
}
