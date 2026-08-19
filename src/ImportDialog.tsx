import { useState } from 'react'
import { EVENTS, type EventId, type Solve } from './types'
import { CstimerParseError, convertSession, parseCstimerExport, type ParsedCstimer } from './cstimer'

type Choice = EventId | 'skip'

/**
 * Reads a csTimer export and lets the user pick, per session, which of our
 * events it should land in. Detection is a default, never a decision -- people
 * rename sessions and reuse them for other puzzles.
 */
export function ImportDialog({
  onImport,
  onClose,
}: {
  onImport: (solves: Solve[]) => void
  onClose: () => void
}) {
  const [parsed, setParsed] = useState<ParsedCstimer | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')

  const readFile = async (file: File) => {
    setError('')
    try {
      const result = parseCstimerExport(await file.text())
      setParsed(result)
      setFileName(file.name)
      // Sessions we recognise are pre-selected; the rest default to skip.
      setChoices(
        Object.fromEntries(
          result.sessions.map((s) => [s.key, (s.detectedEvent ?? 'skip') as Choice]),
        ),
      )
    } catch (e) {
      setParsed(null)
      setError(e instanceof CstimerParseError ? e.message : 'Could not read that file.')
    }
  }

  const selected = parsed
    ? parsed.sessions.filter((s) => choices[s.key] !== 'skip' && s.solveCount > 0)
    : []
  const totalSolves = selected.reduce((n, s) => n + s.solveCount, 0)

  const doImport = () => {
    if (!parsed) return
    const solves = selected.flatMap((s) =>
      convertSession(parsed.raw[s.key], choices[s.key] as EventId),
    )
    onImport(solves)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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
              <strong>Export to file</strong>. Then pick that file here.
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
              <strong>{fileName}</strong> — {parsed.sessions.length} sessions. Choose where each
              one goes. Sessions for puzzles this site doesn't support yet are set to skip.
            </p>

            <div className="import-list">
              {parsed.sessions.map((s) => (
                <div key={s.key} className={`import-row ${s.solveCount === 0 ? 'muted' : ''}`}>
                  <div className="import-meta">
                    <strong>{s.name}</strong>
                    <span>
                      {s.solveCount} solves
                      {s.scrType ? ` · ${s.scrType}` : ''}
                      {s.from ? ` · ${new Date(s.from).getFullYear()}–${new Date(s.to!).getFullYear()}` : ''}
                    </span>
                  </div>
                  <select
                    value={choices[s.key] ?? 'skip'}
                    disabled={s.solveCount === 0}
                    onChange={(e) =>
                      setChoices((prev) => ({ ...prev, [s.key]: e.target.value as Choice }))
                    }
                  >
                    <option value="skip">skip</option>
                    {EVENTS.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <span className="note">
                {totalSolves > 0
                  ? `${totalSolves} solves from ${selected.length} session${selected.length === 1 ? '' : 's'}`
                  : 'nothing selected'}
              </span>
              <button onClick={doImport} disabled={totalSolves === 0} className="primary">
                import
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
