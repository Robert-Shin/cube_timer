/**
 * Parses a hand-typed time into ms. Bare digits are read as the digits of a
 * displayed time, filled right to left -- m:ss.cc -- so you type what you see:
 *
 *   1234   -> 12.34
 *   12345  -> 1:23.45
 *   123456 -> 12:34.56
 *
 * That means the seconds field is a real seconds field: "9999" is not 99.99s,
 * it is a typo, because no display shows 99 seconds. 1:39.99 is typed 13999.
 *
 * An explicit separator overrides all of this and means what it looks like:
 * "12.34" is 12.34s, "1:05.43" is 65.43s.
 *
 * Returns null if the input isn't a time.
 */
export function parseTime(input: string): number | null {
  const text = input.trim().replace(',', '.')
  if (!text) return null

  // Bare digits -> the digits of a displayed time, filled right to left.
  if (/^\d+$/.test(text)) {
    const digits = text.padStart(3, '0')
    const cs = Number(digits.slice(-2))
    const sec = Number(digits.slice(-4, -2) || '0')
    const min = Number(digits.slice(0, -4) || '0')
    // A displayed seconds field never exceeds 59, so anything above it is a
    // mistyped entry rather than a large number of seconds.
    if (sec > 59) return null
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
