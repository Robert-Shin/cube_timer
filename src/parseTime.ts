/**
 * Parses a hand-typed time into ms. Accepts "12.34", "1:05.43", "9", "1:05".
 * Returns null if it isn't a time. Bare digits are read as seconds, not the
 * keypad-style centiseconds some timers use -- typing "12" means 12s here.
 */
export function parseTime(input: string): number | null {
  const text = input.trim()
  if (!text) return null

  const match = /^(?:(\d+):)?(\d{1,2}|\d+)(?:[.,](\d{1,3}))?$/.exec(text)
  if (!match) return null

  const [, minStr, secStr, fracStr] = match
  const min = minStr ? Number(minStr) : 0
  const sec = Number(secStr)
  if (minStr && sec >= 60) return null // "1:75" is not a time

  // Pad so ".5" reads as 500ms and ".05" as 50ms.
  const ms = fracStr ? Number(fracStr.padEnd(3, '0')) : 0
  const total = min * 60000 + sec * 1000 + ms
  return total > 0 ? total : null
}
