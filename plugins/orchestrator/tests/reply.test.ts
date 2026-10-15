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
    expect(ctx.herdr.waitTimeouts).toEqual([90000])
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
      throw new HerdrError('herdr agent wait failed: killed', 'timeout')
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
    expect(lost.stderr).toMatch(/may not have got the reply.*timed out.*orch reply s-go --task t1 --mark-only/s)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('hands sessions outside herdr back to /orch with exit 3', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-ext', 'api-fix', false)
    const out = await run(['reply', 'api-fix', 'lenient'], ctx)
    expect(out.code).toBe(3)
    expect(JSON.parse(out.stdout)).toEqual({
      route: 'sendmessage',
      sessionId: 's-ext',
      name: 'api-fix',
      cwd: '/r',
      taskId: 't1',
      text: '[orch reply to: "Strict or lenient?"] lenient',
    })
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

  it('refuses to send when the question was answered during the wait', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      writePool(ctx.orchHome, plan(newPool('s-go', '/r', 1), ['pick curve'], 5))
      return 'idle'
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/course-go already answered that question in the session; nothing sent/)
    expect(ctx.herdr.calls.filter(c => c[0] === 'prompt')).toEqual([])
  })

  describe('several questions', () => {
    function two(ctx: TestCtx, inHerdr = false) {
      writeSession(ctx, { pid: 12, sessionId: 's-two', name: 'two' })
      writePool(ctx.orchHome, askTask(askTask(plan(newPool('s-two', '/r', 1), ['a', 'b', 'c'], 2), 't1', 'first?', 3), 't3', 'third?', 4))
      if (inHerdr) ctx.herdr.agents.push({ name: 'two', paneId: 'p-two', status: 'idle', sessionId: 's-two' })
    }

    it('asks for --task when more than one is open', async () => {
      const ctx = makeCtx()
      two(ctx)
      const out = await run(['reply', 'two', '--', 'x'], ctx)
      expect(out.code).toBe(1)
      expect(out.stderr).toMatch(/two has 2 open questions \(t1, t3\); pass --task <id>/)
      expect((await run(['reply', 'two', '--mark-only'], ctx)).stderr).toMatch(/pass --task/)
    })

    it('answers and clears only the chosen one', async () => {
      const ctx = makeCtx()
      two(ctx, true)
      expect((await run(['reply', 'two', '--task', 't3', '--', 'yes'], ctx)).code).toBe(0)
      expect(ctx.herdr.calls[1]).toEqual(['prompt', 'p-two', '[orch reply to: "third?"] yes'])
      const tasks = readPool(ctx.orchHome, 's-two')!.tasks
      expect(tasks.find(t => t.id === 't1')!.needsInput).toBe('first?')
      expect(tasks.find(t => t.id === 't3')!.needsInput).toBeUndefined()

      const ext = makeCtx()
      two(ext)
      expect(JSON.parse((await run(['reply', 'two', '--task', 't1', '--', 'ok'], ext)).stdout).taskId).toBe('t1')
      expect((await run(['reply', 'two', '--task', 't1', '--mark-only'], ext)).code).toBe(0)
      const left = readPool(ext.orchHome, 's-two')!.tasks
      expect(left.find(t => t.id === 't1')!.needsInput).toBeUndefined()
      expect(left.find(t => t.id === 't3')!.needsInput).toBe('third?')
    })

    it('refuses a --task with no question', async () => {
      const ctx = makeCtx()
      two(ctx)
      expect((await run(['reply', 'two', '--task', 't2', '--', 'x'], ctx)).stderr).toMatch(/t2 has no open question/)
      expect((await run(['reply', 'two', '--task', 'nope', '--mark-only'], ctx)).code).toBe(1)
    })
  })

  describe('the message', () => {
    it('quotes a one-line, capped question and strips control characters from the text', async () => {
      const ctx = makeCtx()
      writeSession(ctx, { pid: 13, sessionId: 's-q', name: 'q' })
      const q = `line one\nline "two" ${'x'.repeat(300)}`
      writePool(ctx.orchHome, askTask(plan(newPool('s-q', '/r', 1), ['a'], 2), 't1', q, 3))
      ctx.herdr.agents.push({ name: 'q', paneId: 'p-q', status: 'idle', sessionId: 's-q' })
      await run(['reply', 'q', '--', 'a\x1b[31mb\x00c\u202ed\u200be\r\nf\tg'], ctx)
      const sent = ctx.herdr.calls[1][2]
      const quoted = JSON.stringify(`line one line "two" ${'x'.repeat(300)}`.slice(0, 200))
      // herdr gets one line; the control and format characters are gone
      expect(sent).toBe(`[orch reply to: ${quoted}] a[31mbcde f g`)
    })

    it('refuses a reply over 4000 characters instead of cutting it', async () => {
      const ctx = makeCtx()
      asking(ctx, 's-go', 'course-go', true)
      const out = await run(['reply', 'course-go', '--', 'y'.repeat(4001)], ctx)
      expect(out.code).toBe(2)
      expect(out.stderr).toMatch(/4000/)
      expect(ctx.herdr.calls).toEqual([])
      expect((await run(['reply', 'course-go', '--', 'y'.repeat(4000)], ctx)).code).toBe(0)
    })
  })

  it('treats a coded timeout as busy whatever the message says', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent get failed: killed', 'timeout')
    }
    expect((await run(['reply', 'course-go', 'x'], ctx)).stderr).toMatch(/still busy after 90 s/)
  })

  it('sends only after idle or done; blocked and other states keep the question open', async () => {
    for (const state of ['idle', 'done']) {
      const ctx = makeCtx()
      asking(ctx, 's-go', 'course-go', true)
      ctx.herdr.waitIdle = async () => state
      expect((await run(['reply', 'course-go', 'x'], ctx)).code).toBe(0)
    }
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => 'blocked'
    expect((await run(['reply', 'course-go', 'x'], ctx)).stderr).toMatch(/permission prompt/)
    ctx.herdr.waitIdle = async () => 'working'
    const out = await run(['reply', 'course-go', 'x'], ctx)
    expect(out.stderr).toMatch(/course-go is working; its question stays open, try again later/)
    expect(ctx.herdr.calls.filter(c => c[0] === 'prompt')).toEqual([])
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('takes text that starts with a dash after --', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    await run(['reply', 'course-go', '--', '-1 is fine'], ctx)
    expect(ctx.herdr.calls[1]).toEqual(['prompt', 'p-course-go', '[orch reply to: "Strict or lenient?"] -1 is fine'])
  })

  it('refuses --mark-only with text, and missing text, with exit 2 and no herdr calls', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    const both = await run(['reply', 'course-go', '--mark-only', 'x'], ctx)
    expect(both.code).toBe(2)
    expect((await run(['reply', 'course-go'], ctx)).code).toBe(2)
    expect(ctx.herdr.calls).toEqual([])
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('can still mark an ended session by its id', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, askTask(plan(newPool('s-old', '/r', 1), ['a'], ctx.now()), 't1', 'q', ctx.now()))
    expect((await run(['reply', 's-old', '--mark-only'], ctx)).code).toBe(0)
    expect(readPool(ctx.orchHome, 's-old')!.tasks[0].needsInput).toBeUndefined()
  })

  it('keeps the newlines for SendMessage', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-ext', 'api-fix', false)
    const out = await run(['reply', 'api-fix', '--', 'one\ntwo'], ctx)
    expect(JSON.parse(out.stdout).text).toBe('[orch reply to: "Strict or lenient?"] one\ntwo')
  })

  it('cuts the question at 200 code points, not in the middle of an emoji', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 14, sessionId: 's-e', name: 'e' })
    const q = `${'a'.repeat(199)}😀tail`
    writePool(ctx.orchHome, askTask(plan(newPool('s-e', '/r', 1), ['a'], 2), 't1', q, 3))
    ctx.herdr.agents.push({ name: 'e', paneId: 'p-e', status: 'idle', sessionId: 's-e' })
    await run(['reply', 'e', '--', 'x'], ctx)
    expect(ctx.herdr.calls[1][2]).toBe(`[orch reply to: "${'a'.repeat(199)}😀"] x`)
  })

  it('says an old ended session with no overview row has ended', async () => {
    const ctx = makeCtx({ now: () => 500_000_000 })
    writePool(ctx.orchHome, askTask(plan(newPool('s-old', '/r', 1), ['a'], 2), 't1', 'q', 3))
    const out = await run(['reply', 's-old', '--', 'x'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/has ended/)
  })
})
