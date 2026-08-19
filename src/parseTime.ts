/**
 * Parses a hand-typed time into ms, using csTimer's keypad convention:
 * bare digits are read right-to-left as centiseconds, so "1234" is 12.34s
 * and "12" is 0.12s. This makes bulk entry of old times fast -- no
 * punctuation to reach for.
 *
 * An explicit separator overrides that and means what it looks like:
 * "12.34" is 12.34s, "1:05.43" is 65.43s.
 *
 * Returns null if the input isn't a time.
 */
export function parseTime(input: string): number | null {
  const text = input.trim().replace(',', '.')
  if (!text) return null

  // Bare digits -> keypad style: last 2 digits are centiseconds,
  // the 2 before that are seconds, the rest are minutes.
  if (/^\d+$/.test(text)) {
    const digits = text.padStart(3, '0')
    const cs = Number(digits.slice(-2))
    const sec = Number(digits.slice(-4, -2) || '0')
    const min = Number(digits.slice(0, -4) || '0')
    // No 59-second cap here: "9999" legitimately means 99.99s (1:39.99).
    const total = min * 60000 + sec * 1000 + cs * 10
    return total > 0 ? total : null
  }

  const match = /^(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/.exec(text)
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
