import { useEffect, useState } from 'react'
import type { SyncState } from './sync/engine'
import type { ClaimResult, OptInResult, Profile } from './profile'
import { normalizeUsername, shouldClaimUsername, validateUsername } from './profile'

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
  profile,
  profileLoading,
  profileFailed,
  onSignIn,
  onSignOut,
  onSyncNow,
  onClose,
  onClaim,
  submittedToday,
  onSetOptIn,
  onReload,
}: {
  state: SyncState
  email: string | null
  error: string | null
  lastSyncedAt: number | null
  profile: Profile | null
  profileLoading: boolean
  profileFailed: boolean
  onSignIn: (email: string) => Promise<{ error: string | null }>
  onSignOut: () => void
  onSyncNow: () => void
  onClose: () => void
  onClaim: (name: string) => Promise<ClaimResult>
  submittedToday: boolean | null
  onSetOptIn: (value: boolean) => Promise<OptInResult>
  onReload: () => Promise<void>
}) {
  const [address, setAddress] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [optBusy, setOptBusy] = useState(false)
  const [optInError, setOptInError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    setRetrying(true)
    await onReload()
    setRetrying(false)
  }

  // The profile lives in App, not here, so a failure from an earlier load
  // survives closing and reopening this panel. Reopening it is the user's
  // obvious "try again", so make it one. Empty deps on purpose: the panel is
  // unmounted when closed, so this fires once per open, and depending on
  // profileFailed would re-fire on every retry that fails.
  useEffect(() => {
    if (profileFailed) void retry()
  }, [])

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

  // Returns the outcome rather than swallowing it: a claim that fails must
  // leave the form open with what the user typed still in it.
  const claim = async (e: React.FormEvent): Promise<ClaimResult> => {
    e.preventDefault()
    const tidy = normalizeUsername(name)
    const bad = validateUsername(tidy)
    if (bad) {
      setClaimError(bad)
      return 'invalid'
    }
    setClaiming(true)
    setClaimError(null)
    const result = await onClaim(tidy)
    setClaiming(false)
    if (result === 'taken') setClaimError('That name is taken. Try another.')
    else if (result === 'invalid') setClaimError('That name was refused. Please report this.')
    else if (result === 'retry') setClaimError('Could not reach the server. Try again.')
    return result
  }

  // Shared with App, which uses the same predicate to force this panel open.
  // See shouldClaimUsername for why a load failure must not gate.
  const gateActive = shouldClaimUsername({
    email,
    loading: profileLoading,
    failed: profileFailed,
    profile,
  })

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!gateActive) onClose()
      }}
    >
      <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Account</h2>
          {!gateActive && (
            <button className="ghost small" onClick={onClose}>
              Close
            </button>
          )}
        </div>

        {email ? (
          profileLoading ? (
            <p className="note">Loading your account…</p>
          ) : profileFailed ? (
            <>
              <p className="error">
                Could not load your account. Check your connection and try again.
              </p>
              <div className="modal-actions">
                <button className="primary" onClick={retry} disabled={retrying}>
                  {retrying ? 'trying…' : 'try again'}
                </button>
                <button className="ghost" onClick={onSignOut}>
                  Sign out
                </button>
              </div>
            </>
          ) : !profile ? (
            <>
              <p className="note">
                Pick a name to finish signing in. It is how you appear on the daily
                leaderboard, and you can change it later.
              </p>
              <form className="auth-form" onSubmit={claim}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  aria-label="Username"
                  maxLength={20}
                  autoFocus
                />
                <button className="primary" type="submit" disabled={claiming || !name.trim()}>
                  {claiming ? 'saving…' : 'claim'}
                </button>
              </form>
              {claimError && <p className="error">{claimError}</p>}
              <p className="note">
                3–20 characters: letters, numbers, and single spaces.
              </p>
              <div className="modal-actions">
                <button className="ghost" onClick={onSignOut}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="note">
                Signed in as <strong>{email}</strong>. Your solves sync to every device you sign in
                from.
              </p>
              <div className="stat">
                <span>Name</span>
                <strong>{profile.username}</strong>
              </div>
              {renaming ? (
                <>
                  <form
                    className="auth-form"
                    onSubmit={async (e) => {
                      // Only close on success -- a taken name must keep the
                      // form open with its message, not silently discard the
                      // edit.
                      if ((await claim(e)) === 'claimed') setRenaming(false)
                    }}
                  >
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="New name"
                      aria-label="New username"
                      maxLength={20}
                      autoFocus
                    />
                    <button className="primary" type="submit" disabled={claiming || !name.trim()}>
                      {claiming ? 'saving…' : 'save'}
                    </button>
                    {/* Opening the rename form replaces the button that opened
                        it, so without this the only exits are a successful save
                        or closing the whole panel. */}
                    <button
                      className="ghost"
                      type="button"
                      disabled={claiming}
                      onClick={() => {
                        setRenaming(false)
                        setClaimError(null)
                      }}
                    >
                      cancel
                    </button>
                  </form>
                  {claimError && <p className="error">{claimError}</p>}
                </>
              ) : (
                <button
                  className="ghost small"
                  onClick={() => {
                    setName(profile.username)
                    setRenaming(true)
                  }}
                >
                  change name
                </button>
              )}

              <div className="setting">
                <div>
                  <strong>Show me on the leaderboard</strong>
                  <p>
                    {submittedToday === null
                      ? "Today's status could not be confirmed, so this is locked for now."
                      : submittedToday
                        ? 'You have already posted today, so this takes effect tomorrow.'
                        : 'Your username and your daily time become visible to other signed-in users.'}
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={profile.optedIn}
                    disabled={submittedToday !== false || optBusy}
                    onChange={async (e) => {
                      setOptBusy(true)
                      // The handler re-checks the lock before writing and can
                      // refuse, so say which of the four things happened — the
                      // checkbox is controlled by profile.optedIn and will snap
                      // back on its own, which alone reads as a broken control.
                      const result = await onSetOptIn(e.target.checked)
                      setOptInError(
                        result === 'saved'
                          ? null
                          : result === 'locked'
                            ? 'You have already posted today, so this cannot change until tomorrow.'
                            : result === 'unknown'
                              ? "Today's status could not be confirmed, so this is locked for now."
                              : 'Could not save that. Check your connection and try again.',
                      )
                      setOptBusy(false)
                    }}
                  />
                  <span />
                </label>
              </div>
              {optInError && <p className="error">{optInError}</p>}

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
          )
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
              timer works fully without an account; your solves are saved in this browser.
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
