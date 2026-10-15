import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { askTask, newPool, plan } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession, type TestCtx } from './helpers.js'

function asking(ctx: TestCtx, id: string, name: string, inHerdr: boolean, status = 'idle') {
  writeSession(ctx, { pid: id.length + 10, sessionId: id, name })
  writePool(ctx.orchHome, askTask(plan(newPool(id, '/r', 1), ['pick curve'], 2), 't1', 'Strict or lenient?', 3))
  if (inHerdr) ctx.herdr.agents.push({ name, paneId: `p-${name}`, status, sessionId: id })
}

describe('orch reply', () => {
  it('waits for a herdr session to rest, sends the answer, clears the flag', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(0)
    expect(ctx.herdr.calls).toEqual([
      ['waitIdle', 'p-course-go'],
      ['prompt', 'p-course-go', '[orch reply to: "Strict or lenient?"] strict'],
    ])
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBeUndefined()
  })

  it('gives up on a busy session after the wait and keeps the question open', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: wait timed out (timeout)', 'timeout')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.stderr).toMatch(/still busy after 90 s/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')

    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: timed out after 100000ms')
    }
    expect((await run(['reply', 'course-go', 'strict'], ctx)).stderr).toMatch(/still busy after 90 s/)
  })

  it('reports a pane that closed during the wait with herdr\'s reason', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: no such agent (agent_not_found)', 'agent_not_found')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/agent_not_found/)
    expect(out.stderr).not.toMatch(/still busy/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('keeps the question open when herdr refuses the prompt', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.prompt = async () => {
      throw new HerdrError('herdr agent prompt failed: agent is blocked (agent_blocked)', 'agent_blocked')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/permission prompt/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')

    ctx.herdr.prompt = async () => {
      throw new HerdrError('herdr agent prompt failed: timed out after 10000ms')
    }
    const lost = await run(['reply', 'course-go', 'strict'], ctx)
    expect(lost.stderr).toMatch(/may not have got the reply.*timed out.*orch reply course-go --mark-only/s)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('hands sessions outside herdr back to /orch with exit 3', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-ext', 'api-fix', false)
    const out = await run(['reply', 'api-fix', 'lenient'], ctx)
    expect(out.code).toBe(3)
    expect(JSON.parse(out.stdout)).toEqual({ route: 'sendmessage', to: 'api-fix', text: '[orch reply to: "Strict or lenient?"] lenient' })
    expect(readPool(ctx.orchHome, 's-ext')!.tasks[0].needsInput).toBe('Strict or lenient?')
    expect((await run(['reply', 'api-fix', '--mark-only'], ctx)).code).toBe(0)
    expect(readPool(ctx.orchHome, 's-ext')!.tasks[0].needsInput).toBeUndefined()
  })

  it('refuses a session with no question, a blocked one, a waiting one and an ended one', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-quiet', name: 'quiet' })
    writePool(ctx.orchHome, plan(newPool('s-quiet', '/r', 1), ['a'], 2))
    expect((await run(['reply', 'quiet', 'x'], ctx)).stderr).toMatch(/no open question/)

    asking(ctx, 's-blk', 'blocked-one', true, 'blocked')
    const blocked = await run(['reply', 'blocked-one', 'x'], ctx)
    expect(blocked.stderr).toMatch(/permission prompt/)
    expect(readPool(ctx.orchHome, 's-blk')!.tasks[0].needsInput).toBe('Strict or lenient?')

    writeSession(ctx, { pid: 40, sessionId: 's-dlg', name: 'dialog-one', status: 'waiting', waitingFor: 'dialog open' })
    writePool(ctx.orchHome, askTask(plan(newPool('s-dlg', '/r', 1), ['a'], 2), 't1', 'q', 3))
    expect((await run(['reply', 'dialog-one', 'x'], ctx)).stderr).toMatch(/waiting on a dialog \(dialog open\)/)
    expect(readPool(ctx.orchHome, 's-dlg')!.tasks[0].needsInput).toBe('q')

    writePool(ctx.orchHome, askTask(plan(newPool('s-gone', '/r', 1), ['a'], ctx.now()), 't1', 'q', ctx.now()))
    expect((await run(['reply', 's-gone', 'x'], ctx)).stderr).toMatch(/has ended/)
  })
})
