/**
 * Paging and completeness for the pull half of sync.
 *
 * Both of these exist because of the same incident: a device whose local
 * store held 1023 solve rows while the server held ~4500, with the pull
 * cursor sitting at today -- so every missing row was older than the cursor
 * and was never requested again. Two separate defects combined to produce
 * that, and each is fixed here.
 */

/**
 * Rows per request. PostgREST applies its own `max-rows` ceiling (1000 by
 * default) whether or not a range is asked for, so pages are requested
 * explicitly at that size rather than left to the server's discretion.
 */
export const PAGE = 1000

/**
 * Reads every row of a cursor query, one page at a time.
 *
 * The pull used to be a single unbounded `select`. That is silently lossy:
 * PostgREST truncates at `max-rows`, the request still SUCCEEDS, and the
 * caller then advances its high-water cursor past the newest row it received
 * -- permanently skipping every row the truncation dropped. A short page is
 * the only reliable end-of-data signal, so that is what terminates this.
 *
 * `page` must impose a total order, or a row can shift between pages and be
 * returned twice or not at all. mergeRows tolerates a duplicate; a skip is
 * exactly the bug being fixed.
 */
export async function paginate<T>(
  // PromiseLike, not Promise: a PostgREST filter builder is thenable but not
  // a real Promise, and wrapping every call site to satisfy the narrower type
  // would add noise for nothing -- `await` only needs `then`.
  page: (from: number, to: number) => PromiseLike<T[]>,
  size = PAGE,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += size) {
    const rows = await page(from, from + size - 1)
    out.push(...rows)
    if (rows.length < size) return out
  }
}

/** Row totals for one side of the sync, tombstones included. */
export interface RowTotals {
  sessions: number
  solves: number
}

/**
 * Whether the cursor must be ignored and everything re-read.
 *
 * The incremental cursor assumes a local store that has received every row
 * it has already moved past -- an assumption it never checks. Once local
 * loses rows for ANY reason (a truncated page, a failed localStorage write,
 * cleared site data), `updated_at > pulledAt` can never return them: they
 * are older than the cursor, and the cursor only moves forward.
 *
 * Comparing totals is what makes that recoverable without knowing the cause.
 * Deletes are soft, so a row never leaves either side and the server total is
 * a floor for the local one. More rows there than here means local is missing
 * some, and the only query that can find them ignores the cursor.
 *
 * Local ahead of remote is normal -- rows written here and not yet pushed --
 * and is not a reason to re-read anything.
 */
export function needsFullPull(remote: RowTotals, local: RowTotals): boolean {
  return remote.sessions > local.sessions || remote.solves > local.solves
}
