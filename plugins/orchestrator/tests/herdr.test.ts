import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { cliHerdr, HerdrError, runHerdr, type Run } from '../src/sources/herdr.js'

const listJson = readFileSync(new URL('./fixtures/herdr-agent-list.json', import.meta.url), 'utf8')

type Reply = { code?: number; stdout?: string; stderr?: string; error?: string; timedOut?: boolean }

function fakeRun(replies: Record<string, Reply>) {
  const calls: string[][] = []
  const timeouts: (number | undefined)[] = []
  const run: Run = async (args, timeoutMs) => {
    calls.push(args)
    timeouts.push(timeoutMs)
    const r = replies[args.slice(0, 2).join(' ')] ?? {}
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, timedOut: r.timedOut }
  }
  return { run, calls, timeouts }
}

const agentOf = (session: unknown, status = 'idle') =>
  JSON.stringify({ result: { agent: { agent_status: status, agent_session: session } } })

describe('cliHerdr', () => {
  it('lists claude agents only', async () => {
    const { run } = fakeRun({ 'agent list': { stdout: listJson } })
    const agents = await cliHerdr(run).list()
    expect(agents).toEqual([
      { name: 'beginner-courses', paneId: 'w1:pR', status: 'done', sessionId: 's-parent', title: 'Beginner courses for all languages' },
      { name: 'course-python', paneId: 'wS:p1', status: 'working', sessionId: 's-python', title: 'TEC-660 python-beginners course' },
    ])
  })

  it('throws OrchError when herdr fails', async () => {
    const { run } = fakeRun({ 'agent list': { code: 1, stderr: 'server not running' } })
    await expect(cliHerdr(run).list()).rejects.toThrow(OrchError)
  })

  it('creates a tab and starts claude with the given args', async () => {
    const { run, calls } = fakeRun({ 'tab create': { stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) } })
    const h = cliHerdr(run)
    expect(await h.createTab({ workspace: 'w1', cwd: '/r', label: 'go' })).toEqual({ paneId: 'w1:p9' })
    await h.startClaude({ name: 'go', paneId: 'w1:p9', args: ['--remote-control', 'go'] })
    expect(calls[0]).toEqual(['tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', 'go', '--no-focus'])
    expect(calls[1]).toEqual(['agent', 'start', 'go', '--kind', 'claude', '--pane', 'w1:p9', '--timeout', '60000', '--', '--remote-control', 'go'])
  })

  it('reads a session id, or undefined when the agent is unknown', async () => {
    const get = agentOf({ kind: 'id', value: 's-new' })
    expect(await cliHerdr(fakeRun({ 'agent get': { stdout: get } }).run).sessionIdOf('go')).toBe('s-new')
    expect(await cliHerdr(fakeRun({ 'agent get': { code: 1 } }).run).sessionIdOf('go')).toBeUndefined()
  })

  it('waits for a resting state and reports it', async () => {
    const get = JSON.stringify({ result: { agent: { agent_status: 'blocked' } } })
    const { run, calls } = fakeRun({ 'agent get': { stdout: get } })
    expect(await cliHerdr(run).waitIdle('w1:p1', 5000)).toBe('blocked')
    expect(calls[0]).toEqual(['agent', 'wait', 'w1:p1', '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '5000'])
  })

  it('prompts and focuses', async () => {
    const { run, calls } = fakeRun({})
    const h = cliHerdr(run)
    await h.prompt('w1:p1', 'hello')
    await h.focus('w1:p1')
    expect(calls).toEqual([['agent', 'prompt', 'w1:p1', 'hello'], ['agent', 'focus', 'w1:p1']])
  })
})

describe('cliHerdr failures', () => {
  // orch reply clears a flag only after prompt resolves, so a failed send must reject
  it.each([
    ['prompt', (h: ReturnType<typeof cliHerdr>) => h.prompt('w1:p1', 'hi')],
    ['wait', (h: ReturnType<typeof cliHerdr>) => h.waitIdle('w1:p1', 5000)],
    ['focus', (h: ReturnType<typeof cliHerdr>) => h.focus('w1:p1')],
    ['start', (h: ReturnType<typeof cliHerdr>) => h.startClaude({ name: 'go', paneId: 'w1:p1', args: [] })],
  ])('rejects with OrchError when agent %s exits non-zero', async (sub, call) => {
    // agent get answers fine, so only the failing call itself can make the promise reject
    const { run } = fakeRun({ [`agent ${sub}`]: { code: 1, stderr: 'nope' }, 'agent get': { stdout: agentOf(undefined) } })
    const e = await call(cliHerdr(run)).catch(x => x)
    expect(e).toBeInstanceOf(OrchError)
    expect(e.message).toBe(`herdr agent ${sub} failed: nope`)
  })

  it('turns the JSON error form into a HerdrError with its code', async () => {
    const stderr = JSON.stringify({ error: { code: 'agent_blocked', message: 'agent is waiting for input' } })
    const e = await cliHerdr(fakeRun({ 'agent prompt': { code: 1, stderr } }).run).prompt('w1:p1', 'hi').catch(x => x)
    expect(e).toBeInstanceOf(HerdrError)
    expect(e).toBeInstanceOf(OrchError)
    expect(e.message).toBe('herdr agent prompt failed: agent is waiting for input (agent_blocked)')
    expect(e.herdrCode).toBe('agent_blocked')
  })

  it('codes a killed herdr call as timeout, and keeps the code of wait\'s own timeout error', async () => {
    const killed = await cliHerdr(fakeRun({ 'agent wait': { code: 127, error: 'timed out after 15000ms', timedOut: true } }).run)
      .waitIdle('w1:p1', 5000)
      .catch(x => x)
    expect(killed).toBeInstanceOf(HerdrError)
    expect(killed.herdrCode).toBe('timeout')

    const stderr = JSON.stringify({ error: { code: 'timeout', message: 'condition not met' } })
    const own = await cliHerdr(fakeRun({ 'agent wait': { code: 1, stderr } }).run).waitIdle('w1:p1', 5000).catch(x => x)
    expect(own.herdrCode).toBe('timeout')

    const other = await cliHerdr(fakeRun({ 'agent wait': { code: 127, error: 'spawn herdr ENOENT' } }).run).waitIdle('w1:p1', 5000).catch(x => x)
    expect(other.herdrCode).toBeUndefined()
  })

  it('reads the JSON error from stdout when stderr is empty', async () => {
    const stdout = JSON.stringify({ error: { code: 'agent_not_ready', message: 'pane is not at a prompt' } })
    const e = await cliHerdr(fakeRun({ 'agent start': { code: 1, stdout } }).run)
      .startClaude({ name: 'go', paneId: 'w1:p1', args: [] })
      .catch(x => x)
    expect(e).toBeInstanceOf(HerdrError)
    expect(e.herdrCode).toBe('agent_not_ready')
    expect(e.message).toBe('herdr agent start failed: pane is not at a prompt (agent_not_ready)')
  })

  it('falls back to trimmed stderr, then stdout, then the exec error', async () => {
    const msg = async (r: Reply) => {
      const e = await cliHerdr(fakeRun({ 'agent list': { code: 1, ...r } }).run).list().catch(x => x)
      expect(e).toBeInstanceOf(HerdrError)
      expect(e.herdrCode).toBeUndefined()
      return e.message
    }
    expect(await msg({ stderr: '  server not running\n', stdout: 'ignored', error: 'ignored too' })).toBe('herdr agent list failed: server not running')
    expect(await msg({ stdout: ' only stdout \n', error: 'ignored' })).toBe('herdr agent list failed: only stdout')
    expect(await msg({ error: 'spawn herdr ENOENT' })).toBe('herdr agent list failed: spawn herdr ENOENT')
    // JSON that is not the error form is just text
    expect(await msg({ stderr: '{"oops":1}' })).toBe('herdr agent list failed: {"oops":1}')
  })

  it.each([
    ['output that is not JSON', 'herdr: oops'],
    ['JSON null', 'null'],
    ['a reply without result', '{}'],
    ['a reply without an agents array', '{"result":{}}'],
    ['agents that is not an array', '{"result":{"agents":{}}}'],
  ])('rejects agent list with %s as an OrchError', async (_what, stdout) => {
    await expect(cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()).rejects.toThrow(OrchError)
  })

  it('skips list entries that are not agents with a pane', async () => {
    const stdout = JSON.stringify({ result: { agents: [null, 'x', { agent: 'claude' }, { agent: 'claude', pane_id: 'w1:p1', agent_status: 'idle' }] } })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents.map(a => a.paneId)).toEqual(['w1:p1'])
  })

  it('rejects a tab create reply without a pane id, or without JSON', async () => {
    const make = (stdout: string) => cliHerdr(fakeRun({ 'tab create': { stdout } }).run).createTab({ workspace: 'w1', cwd: '/r', label: 'go' })
    await expect(make('{"result":{"root_pane":{}}}')).rejects.toThrow(OrchError)
    await expect(make('{"result":{}}')).rejects.toThrow(OrchError)
    await expect(make('not json')).rejects.toThrow(OrchError)
  })

  it('rejects a wait whose follow-up get has no status, or no JSON', async () => {
    const wait = (stdout: string) => cliHerdr(fakeRun({ 'agent get': { stdout } }).run).waitIdle('w1:p1', 5000)
    await expect(wait('{"result":{"agent":{}}}')).rejects.toThrow(OrchError)
    await expect(wait('not json')).rejects.toThrow(OrchError)
  })
})

describe('session ids', () => {
  const claude = (agent_session: unknown) => ({ agent: 'claude', pane_id: 'w1:p1', agent_status: 'idle', agent_session })

  it('only counts an agent_session of kind id', async () => {
    const stdout = JSON.stringify({
      result: { agents: [claude({ kind: 'path', value: '/x/s.jsonl' }), claude({ value: 's-nokind' }), claude({ kind: 'id', value: 's-ok' })] },
    })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents.map(a => a.sessionId)).toEqual([undefined, undefined, 's-ok'])
  })

  it('gives sessionIdOf undefined for a path kind, no kind, or an empty value', async () => {
    const of = (s: unknown) => cliHerdr(fakeRun({ 'agent get': { stdout: agentOf(s) } }).run).sessionIdOf('go')
    expect(await of({ kind: 'path', value: '/x/s.jsonl' })).toBeUndefined()
    expect(await of({ value: 's-nokind' })).toBeUndefined()
    expect(await of({ kind: 'id', value: '' })).toBeUndefined()
    expect(await of(undefined)).toBeUndefined()
  })

  it('gives list an undefined sessionId for an empty id value', async () => {
    const stdout = JSON.stringify({ result: { agents: [claude({ kind: 'id', value: '' })] } })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents[0].sessionId).toBeUndefined()
  })
})

describe('timeouts', () => {
  it('bounds start and wait, and leaves every other call on the default', async () => {
    const { run, calls, timeouts } = fakeRun({
      'agent list': { stdout: listJson },
      'tab create': { stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) },
      'agent get': { stdout: agentOf({ kind: 'id', value: 's-1' }) },
    })
    const h = cliHerdr(run)
    await h.list()
    await h.focus('w1:p1')
    await h.createTab({ workspace: 'w1', cwd: '/r', label: 'go' })
    await h.startClaude({ name: 'go', paneId: 'w1:p9', args: [] })
    await h.prompt('w1:p9', 'hi')
    await h.waitIdle('w1:p9', 5000)
    await h.sessionIdOf('go')
    expect(calls.map((c, i) => [c.slice(0, 2).join(' '), timeouts[i]])).toEqual([
      ['agent list', undefined],
      ['agent focus', undefined],
      ['tab create', undefined],
      ['agent start', 75_000],
      ['agent prompt', undefined],
      ['agent wait', 15_000],
      ['agent get', undefined],
      ['agent get', undefined],
    ])
  })
})

describe('runHerdr', () => {
  const savedPath = process.env.PATH
  const dirs: string[] = []
  afterEach(() => {
    process.env.PATH = savedPath
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // PATH starts at a throwaway dir, so the real herdr is never reached; with no script the dir is all of
  // PATH, since herdr may also live in /usr/bin
  function fakeHerdr(script?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'fake-herdr-'))
    dirs.push(dir)
    if (script) {
      writeFileSync(join(dir, 'herdr'), `#!/bin/sh\n${script}\n`)
      chmodSync(join(dir, 'herdr'), 0o755)
    }
    process.env.PATH = script ? `${dir}:/usr/bin:/bin` : dir
  }

  it('hands back exit code, stdout and stderr', async () => {
    fakeHerdr('echo "args: $*"; echo bad >&2; exit 3')
    const r = await runHerdr(['agent', 'list'])
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('args: agent list\n')
    expect(r.stderr).toBe('bad\n')
  })

  it('reports why when the binary is missing', async () => {
    fakeHerdr()
    const r = await runHerdr(['agent', 'list'])
    expect(r.code).not.toBe(0)
    expect(r.error).toMatch(/ENOENT/)
    expect(r.timedOut).toBeFalsy()
  })

  it('kills a call that outlives its timeout and says so', async () => {
    fakeHerdr('exec sleep 3')
    const t0 = Date.now()
    const r = await runHerdr(['agent', 'list'], 100)
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(r.code).not.toBe(0)
    expect(r.error).toBe('timed out after 100ms')
    expect(r.timedOut).toBe(true)
  })
})
