import { describe, expect, it } from 'vitest'
import { clip, pad, width } from '../src/width.js'

describe('width', () => {
  it.each([
    ['abc', 3],
    ['', 0],
    ['日本語', 6],
    ['한글', 4],
    ['ＡＢ', 4],
    ['🚀', 2],
    ['⚑', 1],
    ['✓', 1],
    ['©', 1],
    ['❤', 1],
    ['™', 1],
    ['✈️', 2],
    ['⌚', 2],
    ['⭐', 2],
    ['👍🏽', 2],
    ['🇯🇵', 2],
    ['❤️', 2],
    ['👨‍👩‍👧', 2],
    ['é', 1],
    ['a​b', 2],
    ['‮', 0],
    ['🚀 rocket', 9],
  ])('%j is %i columns wide', (s, n) => {
    expect(width(s)).toBe(n)
  })

  it('clips by columns and never splits a wide character or an emoji', () => {
    expect(clip('日本語日本語', 7)).toBe('日本語…')
    expect(clip('日本語', 6)).toBe('日本語')
    expect(clip('a🚀b🚀c', 4)).toBe('a🚀…')
    expect(width(clip('x'.repeat(50), 24))).toBe(24)
  })

  it('pads to exactly n columns', () => {
    expect(width(pad('日本', 10))).toBe(10)
    expect(pad('ab', 4)).toBe('ab  ')
    expect(width(pad('😀'.repeat(20), 8))).toBe(7 + 1)
  })
})
