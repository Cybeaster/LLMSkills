// Display width without a dependency: the CLI bundle must load on Node 18, and the width packages
// (string-width 8) build RegExps with the `v` flag, which Node 18 rejects at load. Only the `u` flag is used here.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const INVISIBLE = /^[\p{Mn}\p{Me}\p{Cf}]+$/u
// emoji drawn as emoji by default; text-style symbols (⚑ ✓ © ❤) are one column unless U+FE0F asks for emoji
const EMOJI = /\p{Emoji_Presentation}/u

// East Asian wide and fullwidth blocks
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]

function graphemeWidth(g: string): number {
  if (INVISIBLE.test(g)) return 0
  if (EMOJI.test(g) || g.includes('\ufe0f')) return 2
  const cp = g.codePointAt(0)!
  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1
}

export function width(s: string): number {
  let n = 0
  for (const { segment } of graphemes.segment(s)) n += graphemeWidth(segment)
  return n
}

// Cuts to at most n terminal columns with a trailing …, by grapheme, so a wide character or an emoji
// sequence at the cut is never split. Text that already fits is returned as is.
export function clip(s: string, n: number): string {
  if (width(s) <= n) return s
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(s)) {
    const w = graphemeWidth(segment)
    if (used + w > n - 1) break
    out += segment
    used += w
  }
  return `${out}…`
}

// Clips, then pads with spaces to exactly n columns.
export function pad(s: string, n: number): string {
  const c = clip(s, n)
  return c + ' '.repeat(Math.max(0, n - width(c)))
}
