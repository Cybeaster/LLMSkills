import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { doneTask, linkChild, newPool, plan, setParent } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { fakeExec, fakeGh, fakeHerdr, makeCtx, writeSession } from './helpers.js'

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
    // other live sessions on both sides, so only the pid chain can pick s-77
    writeSession(ctx, { pid: 76, sessionId: 's-76' })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    writeSession(ctx, { pid: 78, sessionId: 's-78' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-76')).toBeUndefined()
    expect(readPool(ctx.orchHome, 's-78')).toBeUndefined()
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
    expect(json.find((r: { name: string }) => r.name === 'me').touchedAt).toBeGreaterThan(1000)
    expect(json.find((r: { name: string }) => r.name === 'other').touchedAt).toBe(0)
    const one = JSON.parse((await run(['status', 's-self', '--json'], ctx)).stdout)
    expect(one.tasks.map((t: { text: string }) => t.text)).toEqual(['a'])
    expect((await run(['status', 's-nope'], ctx)).stderr).toMatch(/no session s-nope/)
    expect((await run(['status', 's-other'], ctx)).stdout).toBe('other has no pool yet\n')
  })

  it('grades CI evidence with the live check', async () => {
    const ctx = makeCtx({ gh: { check: async () => 'pending' } })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'ci:https://github.com/o/r/actions/runs/1'], ctx)
    ctx.gh = { check: async () => 'fail' }
    expect((await run(['status'], ctx)).stdout).toMatch(/^✗ t1 /m)
  })

  it('prints help and rejects unknown commands', async () => {
    expect((await run([], makeCtx())).stdout).toMatch(/orch plan/)
    expect((await run(['frob'], makeCtx())).code).toBe(2)
  })
})

const CI = 'ci:https://github.com/o/r/actions/runs/1'

describe('orch help and free text', () => {
  it('prints help for --help and -h without touching the pool', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b', 'c'], ctx)
    const before = readPool(ctx.orchHome, 's-self')
    for (const argv of [['plan', '--help'], ['plan', '-h'], ['plan', 'x', '--help'], ['title', '-h'], ['task', 'add', '--help'], ['task', 'done', 't1', '-h'], ['ask', 't1', '--help'], ['status', '--help']]) {
      const out = await run(argv, ctx)
      expect(out, argv.join(' ')).toMatchObject({ code: 0, stderr: '' })
      expect(out.stdout, argv.join(' ')).toMatch(/orch plan/)
    }
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
    expect(before!.tasks.map(t => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('exits 2 on an unknown option instead of turning it into text', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const before = readPool(ctx.orchHome, 's-self')
    for (const argv of [['plan', '-x'], ['plan', 'b', '--nope'], ['title', '-z'], ['task', 'add', '--oops'], ['task', 'block', 't1', '-q'], ['ask', 't1', '-q']]) {
      const out = await run(argv, ctx)
      expect(out.code, argv.join(' ')).toBe(2)
      expect(out.stderr, argv.join(' ')).toMatch(/^orch: /)
    }
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
  })

  it('takes text that starts with a dash after --', async () => {
    const ctx = makeCtx()
    expect((await run(['plan', '--', '-x'], ctx)).code).toBe(0)
    await run(['task', 'add', '--', '--help', 'me'], ctx)
    await run(['title', '--', '-v2'], ctx)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p.tasks.map(t => t.text)).toEqual(['-x', '--help me'])
    expect(p.title).toBe('-v2')
  })

  it('refuses a plan with no steps or a blank one, and changes nothing', async () => {
    const ctx = makeCtx()
    const none = await run(['plan'], ctx)
    expect(none.code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toBeUndefined()
    expect((await run(['plan', '', '  '], ctx)).code).toBe(2)
    expect((await run(['plan', 'real', ' '], ctx)).code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toBeUndefined()
    await run(['plan', '  padded  '], ctx)
    expect(readPool(ctx.orchHome, 's-self')!.tasks.map(t => t.text)).toEqual(['padded'])
    const before = readPool(ctx.orchHome, 's-self')
    expect((await run(['plan'], ctx)).code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
  })

  it('names what is missing without dumping the help', async () => {
    const out = await run(['task', 'add'], makeCtx())
    expect(out.code).toBe(2)
    expect(out.stderr).toBe('orch: missing task text (orch help lists the commands)\n')
  })
})

describe('orch task done --evidence', () => {
  it('treats an empty --evidence as a usage error and keeps the evidence it has', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'commit:abc1234'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', ''], ctx)
    expect(out.code).toBe(2)
    expect(out.stderr).toMatch(/bad evidence/)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('runs cmd evidence in the session cwd, not the pool cwd, and says where', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s-self', '/elsewhere', 1), ['a', 'b'], 2))
    const good = await run(['task', 'done', 't1', '--evidence', 'cmd:npm test'], ctx)
    expect(ctx.exec.calls).toEqual([['npm test', ctx.cwd]])
    expect(good.stdout).toBe(`t1 done (cmd npm test (exit 0) in ${ctx.cwd})\n`)
    const bad = await run(['task', 'done', 't2', '--evidence', 'cmd:npm run fail'], ctx)
    expect(ctx.exec.calls[1]).toEqual(['npm run fail', ctx.cwd])
    expect(bad.stderr).toContain(`\`npm run fail\` exited 1 in ${ctx.cwd}, so t2 stays open`)
  })

  it('does not run the command for a task that is not there', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't9', '--evidence', 'cmd:npm test'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/no task t9/)
    expect(ctx.exec.calls).toEqual([])
  })

  it('refuses a command that timed out, shows what it printed and says how to prove long work', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: 'building…\nwaiting for lock\n', signal: 'SIGTERM', timedOut: true })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:make all'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toBe(`orch: refused: \`make all\` timed out after 110 s in ${ctx.cwd}, so t1 stays open; run long commands yourself and tick with commit:, ci: or note:\nbuilding…\nwaiting for lock\n`)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('pending')
  })

  it('leaves no blank line when a refused command printed nothing', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: '', timedOut: true })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:make all'], ctx)
    expect(out.stderr).toMatch(/or note:\n$/)
    expect(out.stderr).not.toMatch(/\n\n/)
    const quiet = makeCtx({ exec: fakeExec(() => ({ code: 2, out: '' })) })
    await run(['plan', 'a'], quiet)
    expect((await run(['task', 'done', 't1', '--evidence', 'cmd:true'], quiet)).stderr).toMatch(/stays open\n$/)
  })

  it('names the signal that killed the command instead of calling it an exit', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: 'Segmentation fault\n', signal: 'SIGSEGV' })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:./crash'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`\`./crash\` was killed by SIGSEGV in ${ctx.cwd}, so t1 stays open`)
    expect(out.stderr).not.toMatch(/exited/)
  })

  it('shows a cleaned tail of a failing command: no escape sequences or control characters, 20 lines, about 4 KB', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const dirty = makeCtx({
      exec: fakeExec(() => ({
        code: 1,
        // a title (OSC ended by BEL), a colour (CSI), a hyperlink (OSC ended by ESC \), a tab, NUL and DEL
        out: `${lines}\nprogress 1\rprogress 2\r\n\x1b]0;evil\x07\x1b[31mred\x1b[0m \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ tab\there\x00\x7f\n`,
      })),
    })
    await run(['plan', 'a'], dirty)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:build'], dirty)
    // eslint-disable-next-line no-control-regex
    expect(out.stderr.replace(/\n/g, '').replace(/\t/g, '')).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(out.stderr).toContain('progress 1\nprogress 2\n')
    expect(out.stderr).toContain('red link tab\there')
    for (const left of ['evil', '[31m', '[0m', 'http://x', ']8;;', ']0;']) expect(out.stderr, left).not.toContain(left)
    // 33 cleaned lines, so the last 20 start at line 14
    expect(out.stderr).toContain('line 14\n')
    expect(out.stderr).not.toMatch(/line 13\n/)
    expect(out.stderr.trimEnd().split('\n').length).toBeLessThanOrEqual(22)

    const huge = makeCtx({ exec: fakeExec(() => ({ code: 1, out: `${'x'.repeat(50_000)}END\n` })) })
    await run(['plan', 'a'], huge)
    const big = await run(['task', 'done', 't1', '--evidence', 'cmd:build'], huge)
    expect(big.stderr.length).toBeLessThan(4096 + 300)
    expect(big.stderr).toContain('xxxEND')
  })
})

describe('who is calling', () => {
  it('prefers CLAUDE_CODE_SESSION_ID over our own CLAUDE_SESSION_ID', async () => {
    const ctx = makeCtx({ env: { CLAUDE_CODE_SESSION_ID: 's-code', CLAUDE_SESSION_ID: 's-hook' } })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-code')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-hook')).toBeUndefined()
  })

  it('falls back to CLAUDE_SESSION_ID when Claude Code sets none', async () => {
    const ctx = makeCtx({ env: { CLAUDE_SESSION_ID: 's-hook' } })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-hook')).toBeDefined()
  })

  it('looks CLAUDE_PID up in the live registry without walking /proc', async () => {
    const ctx = makeCtx({
      env: { CLAUDE_PID: '77' },
      ppidOf: () => {
        throw new Error('walked the process tree')
      },
    })
    writeSession(ctx, { pid: 76, sessionId: 's-76' })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    writeSession(ctx, { pid: 78, sessionId: 's-78' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-76')).toBeUndefined()
    expect(readPool(ctx.orchHome, 's-78')).toBeUndefined()
  })

  it('walks the process tree when CLAUDE_PID is not a registered session', async () => {
    const parents = new Map([[4242, 77]])
    const ctx = makeCtx({ env: { CLAUDE_PID: '999' }, ppidOf: pid => parents.get(pid) })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
  })
})

describe('orch task done with ci: and pr: evidence', () => {
  const doneWith = async (answer: 'pass' | 'fail' | 'pending' | 'unknown', evidence: string) => {
    const gh = fakeGh(answer)
    const ctx = makeCtx({ gh })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', evidence], ctx)
    return { out, gh, ctx }
  }

  it.each(['ci:https://github.com/o/r/actions/runs/1', 'pr:41'])('refuses %s while it is failing', async ev => {
    const { out, gh, ctx } = await doneWith('fail', ev)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/refused: (ci|pr) .* is failing, so t1 stays open/)
    expect(gh.calls).toHaveLength(1)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('pending')
  })

  it('accepts evidence that passes', async () => {
    const { out, ctx } = await doneWith('pass', 'pr:41')
    expect(out).toMatchObject({ code: 0, stdout: 't1 done (pr 41)\n' })
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0]).toMatchObject({ status: 'done', evidence: { kind: 'pr', ref: '41' } })
  })

  it.each(['pending', 'unknown'] as const)('accepts evidence that is %s and says orch will keep checking', async verdict => {
    const { out, ctx } = await doneWith(verdict, 'ci:77')
    expect(out.code).toBe(0)
    expect(out.stdout).toBe(`t1 done; ci 77 is ${verdict}, orch will keep checking it\n`)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('done')
  })

  it('does not ask gh about other evidence', async () => {
    const { gh } = await doneWith('fail', 'note:fine')
    expect(gh.calls).toEqual([])
  })
})

describe('orch status and gh', () => {
  it('asks gh nothing for status --all, as text or JSON', async () => {
    const gh = fakeGh('pass')
    const ctx = makeCtx({ gh })
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me' })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    gh.calls.length = 0 // done asked once itself
    expect((await run(['status', '--all'], ctx)).code).toBe(0)
    expect((await run(['status', '--all', '--json'], ctx)).code).toBe(0)
    expect(gh.calls).toEqual([])
  })

  it('asks gh only about the pool it shows, even with another pool holding PR evidence', async () => {
    const gh = fakeGh('pass')
    const ctx = makeCtx({ gh })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    gh.calls.length = 0
    writePool(ctx.orchHome, doneTask(plan(newPool('s-other', '/o', 1), ['x'], 2), 't1', { kind: 'pr', ref: '7' }, 3))
    await run(['status'], ctx)
    expect(gh.calls.map(([ev]) => ev.kind)).toEqual(['ci'])
    gh.calls.length = 0
    await run(['status', 's-other', '--json'], ctx)
    expect(gh.calls.map(([ev, cwd]) => [ev.kind, ev.ref, cwd])).toEqual([['pr', '7', '/o']])
  })

  it('fails fast outside a session, before herdr or gh is asked', async () => {
    const herdr = fakeHerdr()
    let listed = 0
    herdr.list = async () => {
      listed++
      return []
    }
    const gh = fakeGh()
    const out = await run(['status'], makeCtx({ env: {}, herdr, gh }))
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/Claude Code session/)
    expect(listed).toBe(0)
    expect(gh.calls).toEqual([])
  })

  it('starts herdr and the gh checks together', async () => {
    let ghStarted!: () => void
    const started = new Promise<void>(r => (ghStarted = r))
    const herdr = fakeHerdr()
    // herdr answers only once a gh check is under way, so asking them one after the other would hang
    herdr.list = async () => {
      await started
      return []
    }
    const gh = { check: async () => (ghStarted(), 'pass' as const) }
    const ctx = makeCtx({ herdr, gh })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^✓ t1 /m)
  }, 1500)

  it('still lists sessions, as external, when herdr is down', async () => {
    const herdr = fakeHerdr()
    herdr.list = async () => {
      throw new HerdrError('herdr is not running')
    }
    const ctx = makeCtx({ herdr })
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me' })
    writeSession(ctx, { pid: 2, sessionId: 's-other', name: 'other' })
    const all = await run(['status', '--all', '--json'], ctx)
    expect(all.code).toBe(0)
    expect(JSON.parse(all.stdout).map((r: { tag: string }) => r.tag)).toEqual(['external', 'external'])
    expect((await run(['status', '--all'], ctx)).stdout).toMatch(/external/)
    expect((await run(['status', 's-other'], ctx)).stdout).toBe('other has no pool yet\n')
  })
})
