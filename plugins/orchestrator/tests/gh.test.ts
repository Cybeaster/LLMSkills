import { describe, expect, it } from 'vitest'
import { cliGh, type GhRun } from '../src/sources/gh.js'

function fakeRun(stdout: unknown, code = 0) {
  const calls: string[][] = []
  const run: GhRun = async args => {
    calls.push(args)
    return { code, stdout: JSON.stringify(stdout) }
  }
  return { run, calls }
}

describe('cliGh', () => {
  it('reads a CI run from its URL', async () => {
    const { run, calls } = fakeRun({ status: 'completed', conclusion: 'failure' })
    expect(await cliGh(run).check({ kind: 'ci', ref: 'https://github.com/o/r/actions/runs/77' }, '/r')).toBe('fail')
    expect(calls[0]).toEqual(['run', 'view', '77', '-R', 'o/r', '--json', 'status,conclusion'])
  })

  it('reports a running CI run as pending', async () => {
    expect(await cliGh(fakeRun({ status: 'in_progress', conclusion: '' }).run).check({ kind: 'ci', ref: '77' }, '/r')).toBe('pending')
  })

  it('grades PRs by state and checks', async () => {
    const pr = (o: unknown) => cliGh(fakeRun(o).run).check({ kind: 'pr', ref: '41' }, '/r')
    expect(await pr({ state: 'MERGED', statusCheckRollup: [] })).toBe('pass')
    expect(await pr({ state: 'CLOSED', statusCheckRollup: [] })).toBe('fail')
    expect(await pr({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe('fail')
    expect(await pr({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] })).toBe('pass')
    expect(await pr({ state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS' }] })).toBe('pending')
  })

  it('says unknown when gh fails and ignores other kinds', async () => {
    expect(await cliGh(fakeRun({}, 1).run).check({ kind: 'ci', ref: '1' }, '/r')).toBe('unknown')
    expect(await cliGh(fakeRun({}).run).check({ kind: 'commit', ref: 'a' }, '/r')).toBe('unknown')
  })

  it('caches answers for 60 s per repo', async () => {
    const { run, calls } = fakeRun({ status: 'completed', conclusion: 'success' })
    let now = 0
    const gh = cliGh(run, () => now)
    const ev = { kind: 'ci' as const, ref: '1' }
    await gh.check(ev, '/r')
    now = 59_000
    await gh.check(ev, '/r')
    expect(calls).toHaveLength(1)
    now = 61_000
    await gh.check(ev, '/r')
    expect(calls).toHaveLength(2)
    await gh.check(ev, '/other')
    expect(calls).toHaveLength(3)
  })
})
