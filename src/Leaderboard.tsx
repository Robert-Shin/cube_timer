import { useEffect, useState } from 'react'
import type { EventId } from './types'
import { formatMs } from './format'
import { utcDay } from './daily'
import { fetchBoard, type BoardRow } from './dailyClient'

/** Ranked on the shared scramble; "best today" is shown but never ranked. */
export function Leaderboard({ event }: { event: EventId }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null)
  const day = utcDay(Date.now())

  useEffect(() => {
    let live = true
    fetchBoard(event, day).then((r) => live && setRows(r))
    return () => {
      live = false
    }
  }, [event, day])

  if (rows === null) return <p className="note">Loading the board…</p>
  if (rows.length === 0) return <p className="empty">Nobody has posted a time today.</p>

  return (
    <table className="figures board">
      <thead>
        <tr>
          <th />
          <th />
          <th>daily</th>
          <th>best today</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.username} className={r.isSelf ? 'self' : ''}>
            <th>{i + 1}</th>
            <th>{r.username}</th>
            <td>{r.challengeMs === null ? 'DNF' : formatMs(r.challengeMs)}</td>
            <td className="hi">{r.bestMs === null ? '—' : formatMs(r.bestMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
