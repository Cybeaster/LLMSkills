import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { checkKey, describeEvidence, grade, oneLine, parseEvidence, safeLine, stripEscapes } from '../src/evidence.js'
import type { Evidence } from '../src/model.js'

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('parseEvidence', () => {
  it('splits on the first colon', () => {
    expect(parseEvidence('ci:https://github.com/o/r/actions/runs/1')).toEqual({ kind: 'ci', ref: 'https://github.com/o/r/actions/runs/1' })
    expect(parseEvidence('cmd: npm test -- --run')).toEqual({ kind: 'cmd', ref: 'npm test -- --run' })
  })

  it('accepts every kind', () => {
    expect(parseEvidence('commit:9f3e2a1')).toEqual({ kind: 'commit', ref: '9f3e2a1' })
    expect(parseEvidence(`commit:${'a'.repeat(64)}`)).toEqual({ kind: 'commit', ref: 'a'.repeat(64) })
    expect(parseEvidence('pr:41')).toEqual({ kind: 'pr', ref: '41' })
    expect(parseEvidence('note: looked fine ')).toEqual({ kind: 'note', ref: 'looked fine' })
  })

  it('rejects unknown kinds and empty refs', () => {
    expect(() => parseEvidence('sha:abc')).toThrow(OrchError)
    expect(() => parseEvidence('commit:')).toThrow(/commit:<sha>/)
    expect(() => parseEvidence('abc')).toThrow(OrchError)
  })

  it('rejects no colon, a leading colon and a blank ref', () => {
    for (const s of ['notee', 'commitx', ':abc', 'note:   ']) expect(() => parseEvidence(s), s).toThrow(OrchError)
  })

  it('fails with exit code 2', () => {
    const err = thrown(() => parseEvidence('sha:abc'))
    expect(err).toBeInstanceOf(OrchError)
    expect(err).toMatchObject({ code: 2 })
  })

  it('requires a commit ref that looks like a sha', () => {
    for (const s of ['commit:fixed the login bug', 'commit:HEAD', 'commit:done', 'commit:abc', `commit:${'a'.repeat(65)}`]) {
      expect(() => parseEvidence(s), s).toThrow(/commit needs a sha, e\.g\. commit:\$\(git rev-parse --short HEAD\)/)
    }
    expect(thrown(() => parseEvidence('commit:HEAD'))).toMatchObject({ code: 2 })
    expect(parseEvidence('commit:abc1')).toEqual({ kind: 'commit', ref: 'abc1' })
    expect(parseEvidence('commit:9F3E2A1')).toEqual({ kind: 'commit', ref: '9F3E2A1' })
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(parseEvidence(`commit:${sha}`)).toEqual({ kind: 'commit', ref: sha })
  })
})

describe('grade', () => {
  it('trusts commits and commands orch ran, not notes', () => {
    expect(grade({ kind: 'commit', ref: 'a' })).toBe('proven')
    expect(grade({ kind: 'cmd', ref: 'x', exit: 0 })).toBe('proven')
    expect(grade({ kind: 'note', ref: 'x' })).toBe('claimed')
    expect(grade(undefined)).toBe('claimed')
  })

  it('contradicts a command that failed', () => {
    expect(grade({ kind: 'cmd', ref: 'x', exit: 1 })).toBe('contradicted')
  })

  it('follows the live check for CI and PRs', () => {
    expect(grade({ kind: 'ci', ref: 'u' }, 'pass')).toBe('proven')
    expect(grade({ kind: 'pr', ref: '4' }, 'fail')).toBe('contradicted')
    expect(grade({ kind: 'pr', ref: '4' }, 'pending')).toBe('unverified')
    expect(grade({ kind: 'ci', ref: 'u' })).toBe('unverified')
  })

  it('leaves CI unverified, never contradicted, when gh could not tell', () => {
    expect(grade({ kind: 'ci', ref: 'u' }, 'unknown')).toBe('unverified')
  })
})

describe('describeEvidence', () => {
  it('formats each kind', () => {
    expect(describeEvidence({ kind: 'commit', ref: '9f3e2a1c0ffee' })).toBe('commit 9f3e2a1')
    expect(describeEvidence({ kind: 'cmd', ref: 'npm test', exit: 0 })).toBe('cmd npm test (exit 0)')
    expect(describeEvidence({ kind: 'note', ref: 'looked fine' })).toBe('note: looked fine')
    expect(describeEvidence({ kind: 'pr', ref: '41' })).toBe('pr 41')
    expect(describeEvidence({ kind: 'ci', ref: 'u' })).toBe('ci u')
  })

  it('keeps the result on one line without escape codes', () => {
    expect(describeEvidence({ kind: 'note', ref: 'line1\nline2' })).toBe('note: line1 line2')
    const out = describeEvidence({ kind: 'note', ref: '\u001b[31mred' })
    expect(out).not.toContain('\u001b')
    expect(out).toBe('note: [31mred')
  })

  it('does not throw on a hand-edited pool entry without a ref', () => {
    expect(() => describeEvidence({ kind: 'commit' } as unknown as Evidence)).not.toThrow()
  })
})

describe('oneLine', () => {
  it('folds whitespace and control characters into single spaces', () => {
    expect(oneLine('a\n b\t\tc')).toBe('a b c')
    expect(oneLine('  x  ')).toBe('x')
    expect(oneLine('a\u001b]0;t\u0007b')).toBe('a ]0;t b')
    expect(oneLine('\u001b\u0007')).toBe('')
  })

  it('turns anything that is not text into text', () => {
    expect(oneLine(undefined)).toBe('')
    expect(oneLine(null)).toBe('')
    expect(oneLine(42)).toBe('42')
    expect(oneLine('')).toBe('')
  })
})

describe('checkKey', () => {
  it('keys a check by repo as well as by ref', () => {
    const pr: Evidence = { kind: 'pr', ref: '41' }
    expect(checkKey(pr, '/a')).toBe('/a\0pr:41')
    expect(checkKey(pr, '/a')).not.toBe(checkKey(pr, '/b'))
    expect(checkKey(pr, '/a')).not.toBe(checkKey({ kind: 'ci', ref: '41' }, '/a'))
  })
})

describe('stripEscapes and safeLine', () => {
  it('removes whole CSI and OSC sequences', () => {
    expect(stripEscapes('a\x1b[31mred\x1b[0m b')).toBe('ared b')
    expect(stripEscapes('x\x1b]0;PWNED\x07y')).toBe('xy')
    expect(stripEscapes('x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\y')).toBe('xlinky')
  })

  it('folds what is left onto one line', () => {
    expect(safeLine('a\x1b]0;PWNED\x07b\nc')).toBe('ab c')
    expect(safeLine(new Error('x').message)).toBe('x')
  })

  it('drops invisible format characters such as the bidi override', () => {
    expect(oneLine('a‮b​c')).toBe('abc')
  })
})
