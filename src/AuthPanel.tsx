import { useState } from 'react'
import type { SyncState } from './sync/engine'

/** Sign-in and sync status. Hidden entirely when sync is not configured. */
export function AuthPanel({
  state,
  email,
  error,
  lastSyncedAt,
  onSignIn,
  onSignOut,
  onSyncNow,
  onClose,
}: {
  state: SyncState
  email: string | null
  error: string | null
  lastSyncedAt: number | null
  onSignIn: (email: string) => Promise<{ error: string | null }>
  onSignOut: () => void
  onSyncNow: () => void
  onClose: () => void
}) {
  const [address, setAddress] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!address.includes('@')) return
    setSending(true)
    setFailed(null)
    const { error: e2 } = await onSignIn(address.trim())
    setSending(false)
    if (e2) setFailed(e2)
    else setSent(true)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>account</h2>
          <button className="ghost small" onClick={onClose}>
            close
          </button>
        </div>

        {email ? (
          <>
            <p className="note">
              Signed in as <strong>{email}</strong>. Your solves sync to every device you sign in
              from.
            </p>
            <div className="stat">
              <span>status</span>
              <strong>{state === 'error' ? 'error' : state}</strong>
            </div>
            <div className="stat">
              <span>last synced</span>
              <strong>{lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : '—'}</strong>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button onClick={onSyncNow} disabled={state === 'syncing'}>
                {state === 'syncing' ? 'syncing…' : 'sync now'}
              </button>
              <button className="ghost" onClick={onSignOut}>
                sign out
              </button>
            </div>
            <p className="note">
              Signing out leaves your solves on this device — it only stops syncing.
            </p>
          </>
        ) : sent ? (
          <>
            <p className="note">
              Check <strong>{address}</strong> for a sign-in link. Opening it on this device
              finishes signing in.
            </p>
            <button className="ghost" onClick={() => setSent(false)}>
              use a different email
            </button>
          </>
        ) : (
          <>
            <p className="note">
              Sign in to keep your solves across devices. No password — we email you a link.
              Everything you have recorded so far comes with you.
            </p>
            <form className="auth-form" onSubmit={submit}>
              <input
                type="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email address"
                autoFocus
              />
              <button className="primary" type="submit" disabled={sending || !address.includes('@')}>
                {sending ? 'sending…' : 'send link'}
              </button>
            </form>
            {failed && <p className="error">{failed}</p>}
          </>
        )}
      </div>
    </div>
  )
}
