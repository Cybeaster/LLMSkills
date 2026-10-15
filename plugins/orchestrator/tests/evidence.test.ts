import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { checkKey, describe as describeEv, grade, parseEvidence } from '../src/evidence.js'

describe('parseEvidence', () => {
  it('splits on the first colon', () => {
    expect(parseEvidence('ci:https://github.com/o/r/actions/runs/1')).toEqual({ kind: 'ci', ref: 'https://github.com/o/r/actions/runs/1' })
    expect(parseEvidence('cmd: npm test -- --run')).toEqual({ kind: 'cmd', ref: 'npm test -- --run' })
  })

  it('rejects unknown kinds and empty refs', () => {
    expect(() => parseEvidence('sha:abc')).toThrow(OrchError)
    expect(() => parseEvidence('commit:')).toThrow(/commit:<sha>/)
    expect(() => parseEvidence('abc')).toThrow(OrchError)
  })
})

describe('grade', () => {
  it('trusts commits and commands orch ran, not notes', () => {
    expect(grade({ kind: 'commit', ref: 'a' })).toBe('proven')
    expect(grade({ kind: 'cmd', ref: 'x', exit: 0 })).toBe('proven')
    expect(grade({ kind: 'note', ref: 'x' })).toBe('claimed')
    expect(grade(undefined)).toBe('claimed')
  })

  it('follows the live check for CI and PRs', () => {
    expect(grade({ kind: 'ci', ref: 'u' }, 'pass')).toBe('proven')
    expect(grade({ kind: 'pr', ref: '4' }, 'fail')).toBe('contradicted')
    expect(grade({ kind: 'pr', ref: '4' }, 'pending')).toBe('unverified')
    expect(grade({ kind: 'ci', ref: 'u' })).toBe('unverified')
  })
})

describe('describe', () => {
  it('formats each kind', () => {
    expect(describeEv({ kind: 'commit', ref: '9f3e2a1c0ffee' })).toBe('commit 9f3e2a1')
    expect(describeEv({ kind: 'cmd', ref: 'npm test', exit: 0 })).toBe('cmd npm test (exit 0)')
    expect(describeEv({ kind: 'note', ref: 'looked fine' })).toBe('note: looked fine')
    expect(describeEv({ kind: 'pr', ref: '41' })).toBe('pr 41')
    expect(checkKey({ kind: 'pr', ref: '41' })).toBe('pr:41')
  })
})
