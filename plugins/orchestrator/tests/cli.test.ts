import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { doneTask, linkChild, newPool, plan, setParent } from '../src/model.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession } from './helpers.js'

describe('orch plan / task / ask / title', () => {
  it('counts finished children in the pool it prints', async () => {
    const ctx = makeCtx()
    await run(['plan', 'fan out'], ctx)
    writePool(ctx.orchHome, linkChild(readPool(ctx.orchHome, 's-self')!, 't1', 's-kid', ctx.now()))
    const kid = setParent(plan(newPool('s-kid', '/k', 1), ['write'], 2), { sessionId: 's-self', taskId: 't1' }, undefined, 3)
    writePool(ctx.orchHome, doneTask(kid, 't1', undefined, 4))
    expect((await run(['plan', 'next'], ctx)).stdout).toMatch(/^✓ t1 /m)
  })

  it('creates the pool of the calling session', async () => {
    const ctx = makeCtx()
    const out = await run(['plan', 'Create course', 'Run audit'], ctx)
    expect(out.code).toBe(0)
    expect(out.stdout).toMatch(/· t1\s+Create course/)
    expect(readPool(ctx.orchHome, 's-self')!.tasks.map(t => t.text)).toEqual(['Create course', 'Run audit'])
  })

  it('re-plans without losing finished work', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'commit:abc1234'], ctx)
    await run(['plan', 'c'], ctx)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p.tasks.map(t => t.id)).toEqual(['t1', 't3'])
    expect(p.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('says a tick without evidence is only claimed', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1'], ctx)
    expect(out.stdout).toMatch(/claimed/)
  })

  it('runs cmd evidence itself and refuses a failing command', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b'], ctx)
    const bad = await run(['task', 'done', 't1', '--evidence', 'cmd:npm run fail'], ctx)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/exited 1.*\n.*boom/s)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('pending')
    const good = await run(['task', 'done', 't2', '--evidence', 'cmd:npm test'], ctx)
    expect(good.code).toBe(0)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[1].evidence).toEqual({ kind: 'cmd', ref: 'npm test', exit: 0 })
  })

  it('rejects bad evidence and unknown tasks', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    expect((await run(['task', 'done', 't1', '--evidence', 'sha:1'], ctx)).code).toBe(2)
    const split = await run(['task', 'done', 't1', '--evidence', 'note:looked', 'fine'], ctx)
    expect(split.code).toBe(2)
    expect(split.stderr).toMatch(/quote the evidence/)
    const missing = await run(['task', 'start', 't9'], ctx)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/no task t9/)
  })

  it('adds, starts, blocks, titles and asks', async () => {
    const ctx = makeCtx()
    await run(['task', 'add', 'Re-check', 'CI'], ctx)
    await run(['task', 'block', 't1', 'waiting', 'on', 'runner'], ctx)
    await run(['title', 'Beginner courses'], ctx)
    const ask = await run(['ask', 't1', 'Strict or lenient?'], ctx)
    expect(ask.stdout).toMatch(/push notification/)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p).toMatchObject({ title: 'Beginner courses' })
    expect(p.tasks[0]).toMatchObject({ text: 'Re-check CI', status: 'blocked', blockedReason: 'waiting on runner', needsInput: 'Strict or lenient?' })
  })

  it('finds its session through the parent pid chain', async () => {
    const parents = new Map([[4242, 300], [300, 77]])
    const ctx = makeCtx({ env: {}, ppidOf: pid => parents.get(pid) })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
  })

  it('fails clearly outside a Claude session', async () => {
    const out = await run(['plan', 'a'], makeCtx({ env: {} }))
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/Claude Code session/)
  })
})

describe('orch status', () => {
  it('shows this session, then every session as text and JSON', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me', bridgeSessionId: 'session_01Me' })
    writeSession(ctx, { pid: 2, sessionId: 's-other', name: 'other' })
    expect((await run(['status'], ctx)).stdout).toMatch(/no pool yet/)
    await run(['plan', 'a'], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^me\n· t1\s+a/)
    const all = await run(['status', '--all'], ctx)
    expect(all.stdout).toMatch(/ORCHESTRATOR  2 live/)
    expect(all.stdout).toContain('→ https://claude.ai/code/session_01Me')
    const json = JSON.parse((await run(['status', '--all', '--json'], ctx)).stdout)
    expect(json.map((r: { name: string }) => r.name).sort()).toEqual(['me', 'other'])
    expect(json.some((r: object) => 'tasks' in r)).toBe(false)
    const one = JSON.parse((await run(['status', 's-self', '--json'], ctx)).stdout)
    expect(one.tasks.map((t: { text: string }) => t.text)).toEqual(['a'])
    expect((await run(['status', 's-nope'], ctx)).stderr).toMatch(/no session s-nope/)
    expect((await run(['status', 's-other'], ctx)).stdout).toBe('other has no pool yet\n')
  })

  it('grades CI evidence with the live check', async () => {
    const ctx = makeCtx({ gh: { check: async () => 'fail' } })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'ci:https://github.com/o/r/actions/runs/1'], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^✗ t1 /m)
  })

  it('prints help and rejects unknown commands', async () => {
    expect((await run([], makeCtx())).stdout).toMatch(/orch plan/)
    expect((await run(['frob'], makeCtx())).code).toBe(2)
  })
})
