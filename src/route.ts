import { useEffect, useState } from 'react'

/**
 * The app's only route. Hash-based on purpose: a hash never reaches the
 * server, so there is no SPA-fallback rewrite to get wrong on Vercel and no
 * router dependency to add.
 */
export type Route = { kind: 'self' } | { kind: 'friend'; userId: string }

const FRIEND = /^#\/friend\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Anything that is not exactly a friend route falls back to your own app.
 *
 * The uuid is matched in full rather than merely split on '/': the value goes
 * straight into an RPC argument, and a route parser is the right place to
 * reject a malformed id -- not the server, and not a component.
 */
export function parseRoute(hash: string): Route {
  const m = FRIEND.exec(hash)
  return m ? { kind: 'friend', userId: m[1] } : { kind: 'self' }
}

export function friendHash(userId: string): string {
  return `#/friend/${userId}`
}

/** The current route, kept in step with the address bar and the Back button. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    // The hash can have changed between the initial useState and this
    // subscription -- a redirect during mount, say -- so read it once more.
    onChange()
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
