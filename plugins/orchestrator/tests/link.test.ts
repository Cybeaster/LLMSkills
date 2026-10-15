import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('moves a child between two tasks of the same parent', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 90, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a', 'b'], 2))
    await run(['link', 's-kid', 's-par', 't1'], ctx)
    await run(['link', 's-kid', 's-par', 't2'], ctx)
    const par = readPool(ctx.orchHome, 's-par')!
    expect(par.tasks[0].children).toBeUndefined()
    expect(par.tasks[1].children).toEqual(['s-kid'])
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't2' })
  })

  it('does not count a link by someone else as the parent writing', async () => {
    const ctx = makeCtx({ env: { CLAUDE_SESSION_ID: 's-other' } })
    writeSession(ctx, { pid: 90, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    const before = readPool(ctx.orchHome, 's-par')!.touchedAt
    expect((await run(['link', 's-kid', 's-par', 't1'], ctx)).code).toBe(0)
    expect(readPool(ctx.orchHome, 's-par')!.touchedAt).toBe(before)
  })

  it('links the new parent first and survives a corrupt old parent, leaving it untouched', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 90, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-old', '/r', 1), ['x'], 2))
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    await run(['link', 's-kid', 's-old', 't1'], ctx)
    writeFileSync(join(ctx.orchHome, 's-old.json'), '{broken')
    const out = await run(['link', 's-kid', 's-par', 't1'], ctx)
    expect(out.code).toBe(0)
    expect(readFileSync(join(ctx.orchHome, 's-old.json'), 'utf8')).toBe('{broken')
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['s-kid'])
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/could not unlink s-kid from s-old/)
  })

  it('says to rerun when the child cannot be written, after the parent already lists it', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 90, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    writeFileSync(join(ctx.orchHome, 's-kid.json'), '{broken')
    const out = await run(['link', 's-kid', 's-par', 't1'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/; rerun orch link/)
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['s-kid'])
  })

  it('records --brief as an absolute path and checks it is a file', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 90, sessionId: 's-kid', name: 'kid' })
    writeSession(ctx, { pid: 91, sessionId: 's-k2', name: 'k2' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    writeFileSync(join(ctx.cwd, 'b.md'), 'x')
    mkdirSync(join(ctx.cwd, 'adir'))
    expect((await run(['link', 's-kid', 's-par', 't1', '--brief', 'b.md'], ctx)).code).toBe(0)
    expect(readPool(ctx.orchHome, 's-kid')!.brief).toBe(join(ctx.cwd, 'b.md'))
    expect((await run(['link', 's-k2', 's-par', 't1', '--brief', 'nope.md'], ctx)).stderr).toMatch(/brief not found/)
    expect((await run(['link', 's-k2', 's-par', 't1', '--brief', 'adir'], ctx)).stderr).toMatch(/brief is not a file/)
  })

  describe('finding the child', () => {
    it('falls back to a herdr agent by name and uses its session id', async () => {
      const ctx = makeCtx()
      writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
      ctx.herdr.agents.push({ name: 'go-2', paneId: 'w1:p1', status: 'idle', sessionId: 's-from-herdr' })
      expect((await run(['link', 'go-2', 's-par', 't1'], ctx)).code).toBe(0)
      expect(readPool(ctx.orchHome, 's-from-herdr')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    })

    it('refuses a herdr agent that has no session id yet', async () => {
      const ctx = makeCtx()
      writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
      ctx.herdr.agents.push({ name: 'go-2', paneId: 'w1:p1', status: 'idle' })
      expect((await run(['link', 'go-2', 's-par', 't1'], ctx)).stderr).toMatch(/no id yet.*orch status --all/)
    })

    it('resolves an exact session id that has a pool but no overview row', async () => {
      const DAY = 24 * 60 * 60 * 1000
      const ctx = makeCtx({ now: () => 10 * DAY })
      writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['a'], 2), updatedAt: 1 })
      writePool(ctx.orchHome, { ...newPool('s-kid', '/r', 1), updatedAt: 1 })
      // neither pool is recent, so neither is in the overview
      expect((await run(['link', 's-kid', 's-par', 't1'], ctx)).code).toBe(0)
      expect(readPool(ctx.orchHome, 's-kid')!.parent?.sessionId).toBe('s-par')
    })

    it('prefers a live session over an ended one with the same name', async () => {
      const ctx = makeCtx()
      writeSession(ctx, { pid: 1, sessionId: 's-live', name: 'dup' })
      writePool(ctx.orchHome, { ...plan(newPool('s-dead', '/r', 1), ['x'], 2), title: 'dup' })
      writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
      expect((await run(['link', 'dup', 's-par', 't1'], ctx)).code).toBe(0)
      expect(readPool(ctx.orchHome, 's-live')!.parent?.sessionId).toBe('s-par')
      expect(readPool(ctx.orchHome, 's-dead')!.parent).toBeUndefined()
    })

    it('matches by session id prefix and by title', async () => {
      const ctx = makeCtx()
      writeSession(ctx, { pid: 1, sessionId: 's-abcdef123', name: 'kid' })
      writeSession(ctx, { pid: 2, sessionId: 's-par', name: 'p' })
      writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['a'], 2), title: 'Big Plan' })
      expect((await run(['link', 's-abcde', 'Big Plan', 't1'], ctx)).code).toBe(0)
      expect(readPool(ctx.orchHome, 's-abcdef123')!.parent?.sessionId).toBe('s-par')
      // a short query is never a prefix
      expect((await run(['link', 's-ab', 'Big Plan', 't1'], ctx)).stderr).toMatch(/no session matches/)
    })
  })
})
