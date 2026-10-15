import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { OrchError } from '../src/errors.js'
import { newPool, plan } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, type TestCtx } from './helpers.js'

function parent(ctx: TestCtx) {
  writePool(ctx.orchHome, { ...plan(newPool('s-self', ctx.cwd, 1), ['Brief', 'Course per language'], 2), title: 'Courses' })
  writeFileSync(join(ctx.cwd, 'brief.md'), '# brief\n')
}

describe('orch spawn-child', () => {
  it('opens a herdr tab, links the child, then sends the intro', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    ctx.herdr.agents.push({ name: 'course-go', paneId: 'w1:p0', status: 'idle', sessionId: 's-other' })
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'course-go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ sessionId: 's-child', agent: 'course-go-2', paneId: 'w9:p1' })
    expect(ctx.herdr.calls[0]).toEqual(['createTab', 'w1', ctx.cwd, 'course-go-2'])
    expect(ctx.herdr.calls[1]).toEqual(['startClaude', 'course-go-2', 'w9:p1', '--remote-control', 'course-go-2'])
    const [, target, intro] = ctx.herdr.calls[2]
    expect(target).toBe('course-go-2')
    expect(intro).toMatch(/child session of "Courses".*t2: "Course per language".*Read .*brief\.md first/s)
    expect(readPool(ctx.orchHome, 's-child')).toMatchObject({ parent: { sessionId: 's-self', taskId: 't2' }, brief: join(ctx.cwd, 'brief.md') })
    expect(readPool(ctx.orchHome, 's-self')!.tasks[1]).toMatchObject({ children: ['s-child'], status: 'in_progress' })
    // spawning is the parent's own work: it must not look stale to the prompt-submit hook
    expect(readPool(ctx.orchHome, 's-self')!.touchedAt).toBeGreaterThan(1000)
  })

  it('prints a command to run by hand outside herdr', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).toMatch(/ORCH_PARENT=s-self ORCH_PARENT_TASK=t2 ORCH_BRIEF='.*brief\.md' claude --remote-control 'go'/)
    expect(ctx.herdr.calls).toEqual([])
  })

  it('explains a child stuck on the folder-trust prompt', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    ctx.herdr.startClaude = async () => {
      throw new HerdrError('herdr agent start failed: agent not ready (agent_not_ready)', 'agent_not_ready')
    }
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/agent_not_ready.*trust this folder.*orch link go s-self t2/s)

    // any other failure still says how to link the child, without the trust hint
    ctx.herdr.startClaude = async () => {
      throw new OrchError('herdr agent start failed: name taken')
    }
    const other = await run(['spawn-child', 't2', '--name', 'go2', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(other.stderr).toMatch(/name taken.*orch link go2 s-self t2/s)
    expect(other.stderr).not.toMatch(/trust this folder/)
  })

  it('needs the brief to exist and the task to be real', async () => {
    const ctx = makeCtx()
    parent(ctx)
    expect((await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'nope.md'], ctx)).stderr).toMatch(/write the brief first/)
    expect((await run(['spawn-child', 't9', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)).stderr).toMatch(/no task t9/)
  })
})
