import { useEffect, useMemo, useState } from 'react'
import { utcDay } from './daily'
import {
  currentStreak,
  friendDaily,
  friendProfile,
  friendSessions,
  friendSolves,
  listFriends,
  FRIEND_SOLVE_CAP,
  type FriendDailyView,
  type FriendProfileView,
  type FriendSessionView,
} from './friends'
import { disciplineLabel, parseDiscipline, soleEvent } from './discipline'
import { formatMs } from './format'
import { StatsPane } from './StatsPane'
import { StatsView, useStatsViewState } from './StatsView'
import { SolveList } from './SolveList'
import { effectiveMs, type Solve } from './types'

const WEEKS = 12

/**
 * A friend's practice, as a page of its own at `#/friend/<uuid>`.
 *
 * You pick between the friend's SESSIONS here, not between all 17 WCA events.
 * The event picker this replaces existed only because the RPCs took an event
 * and aggregated across every session the friend had for it -- so it asked a
 * question the friend never organised their practice by, and offered 17
 * choices of which they might have solves for two.
 *
 * Two rules hold this page together, and both are security properties rather
 * than presentation:
 *
 * - The NAME is never read from the URL. The hash carries a uuid and nothing
 *   else; the display name is resolved from `listFriends()`. Until it
 *   resolves the page renders without a name rather than echoing anything a
 *   link could have carried, so a crafted link cannot put a misleading name
 *   above someone else's data.
 * - An id that is not an accepted friend gets ONE calm state, "not
 *   available", indistinguishable from "no such user". The server already
 *   conflates the two by returning zero rows; un-conflating them here would
 *   turn this page into an oracle for whether an account exists.
 *
 * Nothing here mutates a row, so nothing here goes through touch()/tombstone().
 */
export function FriendStats({ userId, onLeave }: { userId: string; onLeave: () => void }) {
  // null = loading, 'error' = the lookup failed, 'unavailable' = this id is
  // not an accepted friend, an object = an accepted friend. `name` inside it
  // may still be null when the profile row did not come back -- the page
  // renders without a name in that case; it never falls back to the URL.
  const [friend, setFriend] = useState<{ name: string | null } | 'unavailable' | 'error' | null>(
    null,
  )
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
  // The friend's solves for the chosen session. Named `solves`, not
  // `friendSolves`: that is the imported function's name.
  //
  // Three states again, and the distinction matters most here: 'error' is a
  // failed call, while an EMPTY array is a friend who has not solved in this
  // session yet -- an ordinary state, never an error. src/friends.ts
  // documents that twice.
  const [solves, setSolves] = useState<Solve[] | null | 'error'>(null)
  // Bumped by the retry buttons to force the effects below to run again for
  // the same userId/session.
  const [attempt, setAttempt] = useState(0)

  // Resolving the name is also the access check: `accepted` below gates every
  // other fetch, so an id that is not a friend makes no RPCs at all.
  useEffect(() => {
    let stale = false
    setFriend(null)
    listFriends().then((v) => {
      if (stale) return
      if (!v) {
        setFriend('error')
        return
      }
      if (!v.partitioned.accepted.includes(userId)) {
        setFriend('unavailable')
        return
      }
      setFriend({ name: v.names.get(userId) ?? null })
    })
    return () => {
      stale = true
    }
  }, [userId, attempt])

  const accepted = typeof friend === 'object' && friend !== null
  const name = accepted ? friend.name : null

  // Same staleness pattern as the effects below. Selecting the first session
  // here (rather than leaving it null) is what makes the page land on
  // something useful immediately: friend_sessions orders by most recent
  // solve, so that is the log they are actually practising.
  useEffect(() => {
    if (!accepted) return
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
  }, [userId, accepted, attempt])

  const chosen =
    sessions === null || sessions === 'error'
      ? undefined
      : sessions.find((s) => s.id === sessionId)
  const chosenDiscipline = chosen ? parseDiscipline(chosen.discipline) : null
  // The daily challenge is per-EVENT, not per-session, so it needs the one
  // event behind the chosen session's discipline -- and there isn't one for a
  // relay, which is why the panel is omitted rather than guessing a leg.
  const dailyEvent = chosenDiscipline ? soleEvent(chosenDiscipline) : null
  // The charts need an event even for a relay, where there is no single one.
  // '333' is the same fallback App uses, and it only decides parity labelling
  // -- which is off on this page anyway.
  const event = dailyEvent ?? '333'

  // `stale` is local to each run of this effect, not a ref shared across
  // runs: switching sessions while a fetch is in flight starts a new run with
  // its own `stale` binding, so the OLD run's cleanup flips only the OLD
  // run's flag. When the old run's fetch resolves afterwards, its own `stale`
  // is true and the response is dropped -- only the newest request's response
  // can ever land. Unmounting mid-fetch runs the same cleanup, so no state is
  // written after unmount either.
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
  // one above, so switching session/retry must not let a slow response from
  // one land after a newer request for the other has already started.
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

  // The fourth fetch, and the one this page exists for: the solves
  // themselves, in the same `Solve` shape the owner's own charts consume.
  useEffect(() => {
    if (!sessionId) return
    let stale = false
    setSolves(null)
    friendSolves(userId, sessionId).then((v) => {
      if (!stale) setSolves(v ?? 'error')
    })
    return () => {
      stale = true
    }
  }, [userId, sessionId, attempt])

  const rows = useMemo(() => (Array.isArray(solves) ? solves : []), [solves])

  // friend_solves discloses a DAY, not a timestamp, so toSolves anchors
  // createdAt at midnight UTC. The practice grid buckets by LOCAL calendar
  // day, so west of UTC every one of those solves would land on the previous
  // day and shift the whole grid by one column. Re-anchoring to local
  // midnight of the same UTC date keeps the grid on the days the server
  // actually reported, without pretending to a precision the wire never had.
  const shown = useMemo(
    () =>
      rows.map((s) => {
        const d = new Date(s.createdAt)
        return {
          ...s,
          createdAt: new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime(),
        }
      }),
    [rows],
  )

  // The single fastest solve in the session: the one result worth marking.
  const pbId = useMemo(() => {
    let bestId: string | null = null
    let bestMs = Infinity
    for (const s of shown) {
      if (s.penalty === 'dnf') continue
      const ms = effectiveMs(s)
      if (ms !== null && ms < bestMs) {
        bestMs = ms
        bestId = s.id
      }
    }
    return bestId
  }, [shown])

  // Called at the top level, like App's, so a hand-picked bucket width or
  // rolling window survives every re-render of this page. Keyed on the
  // session, not its name.
  const statsState = useStatsViewState(sessionId ?? '')

  const retry = (
    <button className="link" onClick={() => setAttempt((n) => n + 1)}>
      Try again.
    </button>
  )

  // No "viewing a friend" label when there is no friend to be viewing: the
  // unavailable state must not imply an account is behind the id.
  const header = (labelled: boolean) => (
    <header className="friend-bar">
      <div className="friend-bar-who">
        {labelled && <span className="friend-bar-label">Viewing a friend</span>}
        {name && <h1>{name}</h1>}
      </div>
      <button className="ghost" onClick={onLeave}>
        Back to your timer
      </button>
    </header>
  )

  if (friend === null) {
    return (
      <div className="friend-page">
        {header(false)}
        <p className="note">Loading…</p>
      </div>
    )
  }

  if (friend === 'error') {
    return (
      <div className="friend-page">
        {header(false)}
        <p className="error">Could not load this page. {retry}</p>
      </div>
    )
  }

  if (friend === 'unavailable') {
    // ONE state for "not your friend" and "no such user" alike. Do not add a
    // second, more specific message here -- the server conflates them on
    // purpose and this page must not be the thing that tells them apart.
    return (
      <div className="friend-page">
        {header(false)}
        <p className="empty">This page is not available.</p>
      </div>
    )
  }

  return (
    <div className="friend-page">
      {header(true)}

      {/* Their sessions, not a list of events. Each row carries its
          discipline label as well as its name, so the puzzle is never
          implicit in a name the viewer did not write. */}
      {sessions === null ? (
        <p className="note">Loading sessions…</p>
      ) : sessions === 'error' ? (
        <p className="error">Could not load these sessions. {retry}</p>
      ) : sessions.length === 0 ? (
        <p className="empty">No solves yet.</p>
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

      {sessionId && (
        <>
          {/* The streak, and only the streak. Best, ao12 and the solve count
              all come from the solves themselves now, one panel down,
              computed by the SAME functions that compute yours -- so keeping
              the server's aggregate copies here would put two numbers for
              one quantity on the page, and they part company as soon as the
              2,000-solve cap bites. The streak is the one figure the solves
              cannot supply: it is computed from friend_calendar's UTC days,
              which run past the cap. */}
          {view === null ? (
            <p className="note">Loading practice…</p>
          ) : view === 'error' ? (
            <p className="error">Could not load this practice. {retry}</p>
          ) : (
            <table className="figures secondary">
              <tbody>
                {/* Today's UTC date, matching how friend_calendar/friend_stats
                    bucket days -- both must agree on the same calendar day or
                    the streak would jump at the boundary. */}
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
          )}

          {/* Omitted entirely for a relay: there is no daily challenge for
              one, so there is nothing to be loading or missing. */}
          {dailyEvent && (
            <div className="friend-daily">
              {daily === null ? (
                <p className="note">Loading today&apos;s result…</p>
              ) : daily === 'error' ? (
                <p className="error">Could not load today&apos;s result. {retry}</p>
              ) : daily === 'none' ? (
                <p className="empty">No result for today&apos;s challenge yet.</p>
              ) : (
                <p className="note">
                  Today: <strong>{daily.timeMs === null ? 'DNF' : formatMs(daily.timeMs)}</strong>
                </p>
              )}
            </div>
          )}

          {solves === null ? (
            <p className="note">Loading solves…</p>
          ) : solves === 'error' ? (
            <p className="error">Could not load these solves. {retry}</p>
          ) : solves.length === 0 ? (
            // Zero rows is never an error: this is a friend who has not
            // solved in this session yet.
            <p className="empty">No solves in this session yet.</p>
          ) : (
            <>
              <StatsPane solves={shown} goalMs={null} />
              {/* Placed above the charts rather than under one of them: it
                  qualifies everything below it, so it has to be read first. */}
              {rows.length === FRIEND_SOLVE_CAP && (
                <p className="note">
                  Showing the most recent {FRIEND_SOLVE_CAP.toLocaleString()} solves.
                </p>
              )}
              <div className="friend-stats-grid">
                <StatsView
                  solves={shown}
                  // No wider set of solves exists here -- friend_solves is
                  // per-session -- so the calendar's "All sessions" scope is
                  // deliberately the same array, a no-op rather than a lie.
                  calendarSolves={shown}
                  title={chosen?.name ?? 'Session'}
                  event={event}
                  // Parity is never recorded on the wire (toSolves leaves it
                  // undefined, meaning "untracked"), so there is nothing
                  // honest to draw.
                  showParity={false}
                  state={statsState}
                />
                {/* No onOpen/onPenalty/onDelete/onClear: someone else's
                    solves are read-only, and SolveList renders no controls
                    and no clickable rows when the handlers are absent. */}
                <SolveList
                  solves={shown}
                  event={event}
                  pbId={pbId}
                  latestId={null}
                  showParityTags={false}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
