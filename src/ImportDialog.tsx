import { useState } from 'react'
import { EVENTS, MAX_SESSIONS, type EventId, type Session, type Solve } from './types'
import { CstimerParseError, convertSession, parseCstimerExport, type ParsedCstimer } from './cstimer'

interface Row {
  include: boolean
  name: string
  event: EventId
}

/**
 * Reads a csTimer export and creates one of our sessions per csTimer session
 * the user selects. Detection sets the defaults; it never decides -- people
 * rename sessions and reuse them for other puzzles.
 */
export function ImportDialog({
  slotsLeft,
  onImport,
  onClose,
}: {
  slotsLeft: number
  onImport: (sessions: Session[], solves: Solve[]) => void
  onClose: () => void
}) {
  const [parsed, setParsed] = useState<ParsedCstimer | null>(null)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')

  const readFile = async (file: File) => {
    setError('')
    try {
      const result = parseCstimerExport(await file.text())
      setParsed(result)
      setFileName(file.name)
      setRows(
        Object.fromEntries(
          result.sessions.map((s) => [
            s.key,
            {
              // Only pre-select what we recognised and that has solves.
              include: s.detectedEvent !== null && s.solveCount > 0,
              name: s.name,
              event: s.detectedEvent ?? '333',
            },
          ]),
        ),
      )
    } catch (e) {
      setParsed(null)
      setError(e instanceof CstimerParseError ? e.message : 'Could not read that file.')
    }
  }

  const patch = (key: string, fields: Partial<Row>) =>
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...fields } }))

  const chosen = parsed ? parsed.sessions.filter((s) => rows[s.key]?.include) : []
  const totalSolves = chosen.reduce((n, s) => n + s.solveCount, 0)
  const overflow = Math.max(0, chosen.length - slotsLeft)

  const doImport = () => {
    if (!parsed || overflow > 0) return
    const sessions: Session[] = []
    const solves: Solve[] = []
    for (const s of chosen) {
      const row = rows[s.key]
      const session: Session = {
        id: crypto.randomUUID(),
        name: row.name.trim() || s.name,
        event: row.event,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      sessions.push(session)
      solves.push(...convertSession(parsed.raw[s.key], session.id))
    }
    onImport(sessions, solves)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>import from csTimer</h2>
          <button className="ghost small" onClick={onClose}>
            close
          </button>
        </div>

        {!parsed && (
          <>
            <p className="note">
              In csTimer, open the session dropdown and choose <strong>Export</strong> →{' '}
              <strong>Export to file</strong>. Then pick that file here. Each session you import
              becomes a session here, keeping its scrambles and dates.
            </p>
            <input
              type="file"
              accept=".txt,.json,application/json,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void readFile(f)
              }}
            />
            {error && <p className="error">{error}</p>}
          </>
        )}

        {parsed && (
          <>
            <p className="note">
              <strong>{fileName}</strong> — {parsed.sessions.length} sessions found. Rename them
              or change the event before importing.
            </p>

            <div className="import-list">
              {parsed.sessions.map((s) => {
                const row = rows[s.key]
                const empty = s.solveCount === 0
                return (
                  <div key={s.key} className={`import-row ${empty ? 'muted' : ''}`}>
                    <input
                      type="checkbox"
                      checked={row?.include ?? false}
                      disabled={empty}
                      onChange={(e) => patch(s.key, { include: e.target.checked })}
                      aria-label={`Import ${s.name}`}
                    />
                    <input
                      className="name-input"
                      value={row?.name ?? s.name}
                      disabled={empty}
                      onChange={(e) => patch(s.key, { name: e.target.value })}
                      aria-label="Session name"
                    />
                    <select
                      value={row?.event ?? '333'}
                      disabled={empty}
                      onChange={(e) => patch(s.key, { event: e.target.value as EventId })}
                      aria-label="Event"
                    >
                      {EVENTS.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {ev.name}
                        </option>
                      ))}
                    </select>
                    <span className="import-meta">
                      <span>
                        {s.solveCount} solves
                        {s.detectedEvent === null && s.scrType ? ` · ${s.scrType}` : ''}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="modal-actions">
              <span className="note">
                {overflow > 0 ? (
                  <span className="error">
                    {chosen.length} sessions selected but only {slotsLeft} slot
                    {slotsLeft === 1 ? '' : 's'} left of {MAX_SESSIONS} — deselect {overflow}
                  </span>
                ) : totalSolves > 0 ? (
                  `${totalSolves} solves into ${chosen.length} new session${chosen.length === 1 ? '' : 's'}`
                ) : (
                  'nothing selected'
                )}
              </span>
              <button
                onClick={doImport}
                disabled={totalSolves === 0 || overflow > 0}
                className="primary"
              >
                import
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
