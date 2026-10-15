import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Check } from '../src/evidence.js'
import { cliGh, type GhRun } from '../src/sources/gh.js'

// bare PR and run numbers are only checked from a cwd that exists, so the fixtures need real directories
const repoA = mkdtempSync(join(tmpdir(), 'gh-test-a-'))
const repoB = mkdtempSync(join(tmpdir(), 'gh-test-b-'))
afterAll(() => {
  for (const d of [repoA, repoB]) rmSync(d, { recursive: true, force: true })
})

// a string is stdout as is, anything else is sent as JSON
function fakeRun(stdout: unknown, code = 0) {
  const calls: string[][] = []
  const cwds: string[] = []
  const run: GhRun = async (args, cwd) => {
    calls.push(args)
    cwds.push(cwd)
    return { code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) }
  }
  return { run, calls, cwds }
}

const ci = (ref: string) => ({ kind: 'ci' as const, ref })
const pr = (ref: string) => ({ kind: 'pr' as const, ref })
const done = (conclusion: unknown) => ({ status: 'completed', conclusion })

describe('cliGh', () => {
  it('reads a CI run from its URL', async () => {
    const { run, calls } = fakeRun({ status: 'completed', conclusion: 'failure' })
    expect(await cliGh(run).check(ci('https://github.com/o/r/actions/runs/77'), repoA)).toBe('fail')
    expect(calls[0]).toEqual(['run', 'view', '77', '-R', 'o/r', '--json', 'status,conclusion'])
  })

  it('reads a bare CI id from the repo in cwd', async () => {
    const { run, calls, cwds } = fakeRun(done('success'))
    expect(await cliGh(run).check(ci('77'), repoA)).toBe('pass')
    expect(calls[0]).toEqual(['run', 'view', '77', '--json', 'status,conclusion'])
    expect(cwds[0]).toBe(repoA)
  })

  it('reports a running CI run as pending', async () => {
    expect(await cliGh(fakeRun({ status: 'in_progress', conclusion: '' }).run).check(ci('77'), repoA)).toBe('pending')
    expect(await cliGh(fakeRun({ status: 'queued', conclusion: null }).run).check(ci('77'), repoA)).toBe('pending')
  })

  it.each<[unknown, Check]>([
    ['success', 'pass'],
    ['skipped', 'pass'],
    ['neutral', 'pass'],
    ['failure', 'fail'],
    ['cancelled', 'fail'],
    ['timed_out', 'fail'],
    ['startup_failure', 'fail'],
    ['stale', 'unknown'],
    ['something_new', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
  ])('grades a completed CI run with conclusion %j as %s', async (conclusion, want) => {
    expect(await cliGh(fakeRun(done(conclusion)).run).check(ci('77'), repoA)).toBe(want)
  })

  it('grades PRs by state and checks', async () => {
    const grade = (o: unknown) => cliGh(fakeRun(o).run).check(pr('41'), repoA)
    expect(await grade({ state: 'MERGED', statusCheckRollup: [] })).toBe('pass')
    expect(await grade({ state: 'CLOSED', statusCheckRollup: [] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'STARTUP_FAILURE' }] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] })).toBe('pass')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS' }] })).toBe('pending')
  })

  it('reads commit statuses by their state', async () => {
    const grade = (state: string) => cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: [{ state }] }).run).check(pr('41'), repoA)
    expect(await grade('ERROR')).toBe('fail')
    expect(await grade('FAILURE')).toBe('fail')
    expect(await grade('PENDING')).toBe('pending')
    expect(await grade('SUCCESS')).toBe('pass')
  })

  it('keeps an open PR without checks pending', async () => {
    expect(await cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: [] }).run).check(pr('41'), repoA)).toBe('pending')
    expect(await cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: null }).run).check(pr('41'), repoA)).toBe('pending')
  })

  it('says unknown when gh fails and ignores other kinds', async () => {
    expect(await cliGh(fakeRun({}, 1).run).check(ci('1'), repoA)).toBe('unknown')
    expect(await cliGh(fakeRun({}, 1).run).check(pr('1'), repoA)).toBe('unknown')
    const other = fakeRun({})
    const gh = cliGh(other.run)
    expect(await gh.check({ kind: 'commit', ref: 'a' }, repoA)).toBe('unknown')
    expect(await gh.check({ kind: 'note', ref: 'a' }, repoA)).toBe('unknown')
    expect(other.calls).toHaveLength(0)
  })

  it('says unknown when gh prints something that is not JSON', async () => {
    expect(await cliGh(fakeRun('HTTP 502 bad gateway').run).check(pr('41'), repoA)).toBe('unknown')
    expect(await cliGh(fakeRun('').run).check(ci('77'), repoA)).toBe('unknown')
  })

  it('says unknown when the runner itself rejects', async () => {
    const run: GhRun = async () => {
      throw new Error('spawn gh ENOENT')
    }
    expect(await cliGh(run).check(ci('77'), repoA)).toBe('unknown')
  })
})

describe('cliGh cache', () => {
  const passed = done('success')

  it('caches answers for 60 s per repo', async () => {
    const { run, calls } = fakeRun(passed)
    let now = 0
    const gh = cliGh(run, () => now)
    const ev = ci('1')
    await gh.check(ev, repoA)
    now = 59_000
    await gh.check(ev, repoA)
    expect(calls).toHaveLength(1)
    now = 61_000
    await gh.check(ev, repoA)
    expect(calls).toHaveLength(2)
    await gh.check(ev, repoB)
    expect(calls).toHaveLength(3)
  })

  it('asks again about an unknown after 15 s', async () => {
    const calls: string[][] = []
    let reply = { code: 1, stdout: '' }
    const run: GhRun = async args => {
      calls.push(args)
      return reply
    }
    let now = 0
    const gh = cliGh(run, () => now)
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    reply = { code: 0, stdout: JSON.stringify(passed) }
    now = 14_000
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    expect(calls).toHaveLength(1)
    now = 16_000
    expect(await gh.check(ci('1'), repoA)).toBe('pass')
    expect(calls).toHaveLength(2)
  })

  it('keeps a pass for 60 s, not the 15 s an unknown gets', async () => {
    const { run, calls } = fakeRun(passed)
    let now = 0
    const gh = cliGh(run, () => now)
    await gh.check(ci('1'), repoA)
    now = 20_000
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(1)
  })

  it('runs gh once for two checks of the same key at the same time', async () => {
    const { run, calls } = fakeRun(passed)
    const gh = cliGh(run)
    const got = await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoA)])
    expect(got).toEqual(['pass', 'pass'])
    expect(calls).toHaveLength(1)
  })

  it('does not share a check across repos while it is in flight', async () => {
    const { run, calls } = fakeRun(passed)
    const gh = cliGh(run)
    await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoB)])
    expect(calls).toHaveLength(2)
  })

  it('lets a late asker join a check that is still in flight', async () => {
    const calls: string[][] = []
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const run: GhRun = async args => {
      calls.push(args)
      await gate
      return { code: 0, stdout: JSON.stringify(passed) }
    }
    let now = 0
    const gh = cliGh(run, () => now)
    const first = gh.check(ci('1'), repoA)
    now = 1_000_000
    const second = gh.check(ci('1'), repoA)
    open()
    expect(await Promise.all([first, second])).toEqual(['pass', 'pass'])
    expect(calls).toHaveLength(1)
  })

  it('measures freshness from when the answer arrived, not from when gh was asked', async () => {
    const calls: string[][] = []
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    let first = true
    const run: GhRun = async args => {
      calls.push(args)
      if (first) {
        first = false
        await gate
      }
      return { code: 0, stdout: JSON.stringify(passed) }
    }
    let now = 0
    const gh = cliGh(run, () => now)
    const pending = gh.check(ci('1'), repoA)
    now = 50_000
    open()
    await pending
    now = 100_000 // 100 s after the ask, but only 50 s after the answer
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(1)
    now = 111_000
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(2)
  })

  it('turns a rejection into unknown for everyone waiting, and asks again after 15 s', async () => {
    let calls = 0
    const run: GhRun = async () => {
      calls++
      throw new Error('boom')
    }
    let now = 0
    const gh = cliGh(run, () => now)
    expect(await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoA)])).toEqual(['unknown', 'unknown'])
    expect(calls).toBe(1)
    now = 16_000
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    expect(calls).toBe(2)
  })
})

describe('cliGh when the cwd is gone', () => {
  const gone = [join(tmpdir(), 'orch-gh-test-no-such-dir'), '']

  it.each(gone)('runs a URL ref from an existing directory, not orch\'s own (cwd %j)', async cwd => {
    const ciRun = fakeRun(done('success'))
    expect(await cliGh(ciRun.run).check(ci('https://github.com/o/r/actions/runs/77'), cwd)).toBe('pass')
    expect(ciRun.calls).toEqual([['run', 'view', '77', '-R', 'o/r', '--json', 'status,conclusion']])
    expect(ciRun.cwds[0]).toBe(tmpdir())
    expect(existsSync(ciRun.cwds[0])).toBe(true)

    const prRun = fakeRun({ state: 'MERGED', statusCheckRollup: [] })
    expect(await cliGh(prRun.run).check(pr('https://github.com/o/r/pull/41'), cwd)).toBe('pass')
    expect(prRun.calls).toEqual([['pr', 'view', 'https://github.com/o/r/pull/41', '--json', 'state,statusCheckRollup']])
    expect(prRun.cwds[0]).toBe(tmpdir())
  })

  it.each(gone)('says unknown for a bare number without running gh (cwd %j)', async cwd => {
    const { run, calls } = fakeRun(done('success'))
    const gh = cliGh(run)
    expect(await gh.check(ci('77'), cwd)).toBe('unknown')
    expect(await gh.check(pr('41'), cwd)).toBe('unknown')
    expect(calls).toHaveLength(0)
  })
})
