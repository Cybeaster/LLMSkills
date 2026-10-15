import stringWidth from 'string-width'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Cuts to at most n terminal columns with a trailing …, by grapheme, so a wide character or an emoji
// sequence at the cut is never split. Text that already fits is returned as is.
export function clip(s: string, n: number): string {
  if (stringWidth(s) <= n) return s
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(s)) {
    const w = stringWidth(segment)
    if (used + w > n - 1) break
    out += segment
    used += w
  }
  return `${out}…`
}

// Clips, then pads with spaces to exactly n columns.
export function pad(s: string, n: number): string {
  const c = clip(s, n)
  return c + ' '.repeat(Math.max(0, n - stringWidth(c)))
}
