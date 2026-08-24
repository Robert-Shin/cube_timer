/**
 * Per-leg durations from the cumulative boundaries stored on a solve.
 *
 * `splits` holds N-1 boundaries for an N-leg relay -- the final stop is the
 * solve's own timeMs, so it is not stored and is supplied here instead.
 *
 * Returns null, not [], when splits were never recorded: an untracked solve
 * has no leg data at all, while `[]` legitimately means "tracked, and the
 * whole attempt was one leg".
 */
export function legDurations(splits: number[] | undefined, timeMs: number): number[] | null {
  if (splits === undefined) return null
  const bounds = [...splits, timeMs]
  return bounds.map((at, i) => (i === 0 ? at : at - bounds[i - 1]))
}
