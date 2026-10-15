import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { newPool, plan } from '../src/model.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession } from './helpers.js'

describe('orch link', () => {
  it('still links when an ancestor pool is unreadable', async () => {
    const ctx = makeCtx()
    for (const id of ['s-x', 's-b', 's-c']) writePool(ctx.orchHome, plan(newPool(id, '/r', 1), ['a'], ctx.now()))
    expect((await run(['link', 's-b', 's-x', 't1'], ctx)).code).toBe(0)
    writeFileSync(join(ctx.orchHome, 's-x.json'), '{broken')
    expect((await run(['link', 's-c', 's-b', 't1'], ctx)).code).toBe(0)
  })

  it('refuses a link that would make a cycle', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s-a', '/r', 1), ['a'], ctx.now()))
    writePool(ctx.orchHome, plan(newPool('s-b', '/r', 1), ['b'], ctx.now()))
    expect((await run(['link', 's-b', 's-a', 't1'], ctx)).code).toBe(0)
    expect((await run(['link', 's-a', 's-b', 't1'], ctx)).stderr).toMatch(/cycle/)
  })

  it('attaches a session under a parent task by name and moves it off its old parent', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-par', name: 'courses' })
    writeSession(ctx, { pid: 2, sessionId: 's-old', name: 'old' })
    writeSession(ctx, { pid: 3, sessionId: 's-kid', name: 'course-go' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['fan out'], 2))
    writePool(ctx.orchHome, plan(newPool('s-old', '/r', 1), ['x'], 2))
    await run(['link', 'course-go', 'old', 't1'], ctx)
    const out = await run(['link', 'course-go', 'courses', 't1'], ctx)
    expect(out.code).toBe(0)
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['s-kid'])
    expect(readPool(ctx.orchHome, 's-old')!.tasks[0].children).toBeUndefined()
  })

  it('counts the parent linking a child under its own task as its own write', async () => {
    // no CLAUDE_SESSION_ID: orch (pid 4242) finds the parent Claude process (pid 11) by walking up
    const parents = new Map([[4242, 11]])
    const ctx = makeCtx({ env: {}, ppidOf: pid => parents.get(pid) })
    writeSession(ctx, { pid: 11, sessionId: 's-par', name: 'courses' })
    writeSession(ctx, { pid: 12, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['fan out'], 2))
    await run(['link', 'kid', 'courses', 't1'], ctx)
    expect(readPool(ctx.orchHome, 's-par')!.touchedAt).toBeGreaterThan(1000)
  })

  it('refuses unknown tasks, self-links and ambiguous names', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-par', name: 'dup' })
    writeSession(ctx, { pid: 2, sessionId: 's-two', name: 'dup' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    expect((await run(['link', 's-two', 's-par', 't9'], ctx)).stderr).toMatch(/no task t9/)
    expect((await run(['link', 's-par', 's-par', 't1'], ctx)).stderr).toMatch(/own parent/)
    expect((await run(['link', 'dup', 's-par', 't1'], ctx)).stderr).toMatch(/matches several/)
  })
})
