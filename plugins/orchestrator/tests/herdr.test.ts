import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { cliHerdr, type Run } from '../src/sources/herdr.js'

const listJson = readFileSync(new URL('./fixtures/herdr-agent-list.json', import.meta.url), 'utf8')

function fakeRun(replies: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = []
  const run: Run = async args => {
    calls.push(args)
    const r = replies[args.slice(0, 2).join(' ')] ?? {}
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { run, calls }
}

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
    const get = JSON.stringify({ result: { agent: { agent_status: 'idle', agent_session: { value: 's-new' } } } })
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
