/**
 * An activity grid: one column per week, one cell per day, intensity by solve
 * count. Renders from per-day COUNTS only -- it never sees a solve.
 *
 * `role="img"` on the grid would remove its children from the accessibility
 * tree, so the per-cell `title` attributes (also unusable on touch) would be
 * unreachable -- a screen-reader user would get only the aria-label and none
 * of the actual data. Instead the grid stays a plain container and a visually
 * hidden text summary next to it carries the same information sighted users
 * get from scanning the cells: total solves and how many days were active.
 */
export function FriendCalendar({
  days,
  weeks = 12,
}: {
  days: { day: string; solves: number }[]
  weeks?: number
}) {
  const byDay = new Map(days.map((d) => [d.day, d.solves]))
  const cells: { day: string; solves: number }[] = []
  const today = new Date()
  for (let i = weeks * 7 - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000)
    const key = d.toISOString().slice(0, 10)
    cells.push({ day: key, solves: byDay.get(key) ?? 0 })
  }

  // Five buckets, so the ramp has fixed meaning rather than rescaling per
  // friend: a dark cell means the same thing on every profile.
  const level = (n: number) => (n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 40 ? 3 : 4)

  const totalSolves = cells.reduce((sum, c) => sum + c.solves, 0)
  const activeDays = cells.filter((c) => c.solves > 0).length

  return (
    <div>
      <p className="visually-hidden">
        Practice over the last {weeks} weeks: {totalSolves} solve{totalSolves === 1 ? '' : 's'} across{' '}
        {activeDays} active day{activeDays === 1 ? '' : 's'}.
      </p>
      <div className="friend-calendar" aria-hidden="true">
        {cells.map((c) => (
          <span
            key={c.day}
            className={`cell l${level(c.solves)}`}
            title={`${c.day}: ${c.solves} solve${c.solves === 1 ? '' : 's'}`}
          />
        ))}
      </div>
    </div>
  )
}
