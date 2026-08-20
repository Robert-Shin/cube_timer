import { useState } from 'react'
import type { SyncState } from './sync/engine'

/** Sign-in and sync status. Hidden entirely when sync is not configured. */
/**
 * Supabase's built-in mailer allows only a couple of messages an hour, so a
 * shared link hits this often. The raw message is accurate but reads like a
 * fault in the app; say what happened and that nothing was lost.
 */
function friendlyError(message: string): string {
  if (/rate limit|too many/i.test(message)) {
    return 'Too many sign-in emails have been sent recently. Try again in an hour — your solves are saved on this device either way.'
  }
  return message
}

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
    if (e2) setFailed(friendlyError(e2))
    else setSent(true)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Account</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        {email ? (
          <>
            <p className="note">
              Signed in as <strong>{email}</strong>. Your solves sync to every device you sign in
              from.
            </p>
            <div className="stat">
              <span>Status</span>
              <strong>{state === 'error' ? 'error' : state}</strong>
            </div>
            <div className="stat">
              <span>Last synced</span>
              <strong>{lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : '—'}</strong>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="modal-actions">
              <button onClick={onSyncNow} disabled={state === 'syncing'}>
                {state === 'syncing' ? 'syncing…' : 'sync now'}
              </button>
              <button className="ghost" onClick={onSignOut}>
                Sign out
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
            <p className="note">
              Sign-in is still limited while this is in testing, so the email may not arrive. The
              The timer works fully without an account; your solves are saved in this browser.
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
