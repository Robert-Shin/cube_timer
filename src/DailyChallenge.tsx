import { useState } from 'react'
import type { EventId, Penalty } from './types'
import { formatMs } from './format'
import { recordChallengeResult, revealDaily, type Reveal } from './dailyClient'
import { useTimer } from './useTimer'
import { Leaderboard } from './Leaderboard'

/**
 * One committed attempt at the day's shared scramble.
 *
 * The scramble is not fetched until the button is pressed, so it cannot be
 * read from devtools before committing. Everything after that point is
 * deliberately one-way.
 */
export function DailyChallenge({
  event,
  onRecord,
  paused,
  hideTimeWhileSolving,
}: {
  event: EventId
  onRecord: (timeMs: number, scramble: string) => void
  /** True while a modal owns the keyboard, so space doesn't fire a phantom
   * solve that would silently burn the day's one immutable attempt. */
  paused: boolean
  /** The user's timer setting, honoured here as on the timer tab -- the
   * running count is hidden, the recorded result is not. */
  hideTimeWhileSolving: boolean
}) {
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [result, setResult] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const finish = (elapsed: number) => {
    setResult(elapsed)
    if (reveal) onRecord(elapsed, reveal.scramble)
    void recordChallengeResult(event, elapsed, 'none' as Penalty)
  }

  const { state, display } = useTimer(finish, reveal !== null && result === null && !paused)

  const start = async () => {
    setError(null)
    try {
      const r = await revealDaily(event)
      setReveal(r)
      if (r.submitted) setResult(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the server')
    }
  }

  if (!reveal) {
    return (
      <div className="challenge">
        <h2>Daily challenge</h2>
        <p className="note">
          One attempt at the same scramble everyone else gets. Revealing it commits you —
          whatever you record is your result for today, including a DNF.
        </p>
        <button className="primary" onClick={start}>
          Reveal and start
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    // The state class goes on the container, not on .timer itself: the
    // hold/ready colours are defined as `.state-holding .timer`, a descendant
    // selector, so a class on the element it is meant to colour never
    // matched and the challenge timer stayed grey through the hold.
    <div className={`challenge state-${state}`}>
      <p className="scramble">{reveal.scramble}</p>
      <div className="timer">
        {hideTimeWhileSolving && state === 'running' ? 'solving' : formatMs(result ?? display)}
      </div>
      <p className="hint">
        {result !== null ? 'Submitted. Come back tomorrow.' : 'Hold space to start'}
      </p>
      {result !== null && <Leaderboard event={event} />}
    </div>
  )
}
