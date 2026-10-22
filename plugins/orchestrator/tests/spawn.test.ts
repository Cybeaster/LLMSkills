import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  it('starts the child on the policy spawn default, flags first', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    parent(ctx)
    mkdirSync(join(ctx.claudeHome, 'routing'), { recursive: true })
    writeFileSync(join(ctx.claudeHome, 'routing', 'policy.json'), JSON.stringify({ spawn: { model: 'fable' } }))
    await run(['spawn-child', 't2', '--name', 'a', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(ctx.herdr.calls[1].slice(-4)).toEqual(['--model', 'fable', '--effort', 'xhigh'])
    await run(['spawn-child', 't2', '--name', 'b', '--cwd', '.', '--brief', 'brief.md', '--model', 'haiku', '--effort', 'low'], ctx)
    expect(ctx.herdr.calls.find(c => c[0] === 'startClaude' && c[1] === 'b')!.slice(-4)).toEqual(['--model', 'haiku', '--effort', 'low'])
  })

  it('puts the model and effort in the command printed outside herdr', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).toMatch(/claude --remote-control='go' --model 'opus' --effort 'xhigh' '/)
  })

  it('ignores a spawn model that is not a string', async () => {
    const ctx = makeCtx()
    parent(ctx)
    mkdirSync(join(ctx.claudeHome, 'routing'), { recursive: true })
    writeFileSync(join(ctx.claudeHome, 'routing', 'policy.json'), JSON.stringify({ spawn: { model: 7 } }))
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).toMatch(/--model 'opus' --effort 'xhigh'/)
  })

  it('refuses an effort that is not a level', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md', '--effort', 'huge'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/--effort must be one of low, medium, high, xhigh, max/)
  })

  it('opens a herdr tab, links the child, then sends the intro', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    ctx.herdr.agents.push({ name: 'course-go', paneId: 'w1:p0', status: 'idle', sessionId: 's-other' })
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'course-go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ sessionId: 's-child', agent: 'course-go-2', paneId: 'w9:p1' })
    expect(ctx.herdr.calls[0]).toEqual(['createTab', 'w1', ctx.cwd, 'course-go-2'])
    expect(ctx.herdr.calls[1]).toEqual(['startClaude', 'course-go-2', 'w9:p1', '--remote-control', 'course-go-2', '--model', 'opus', '--effort', 'xhigh'])
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
    expect(out.stdout).toMatch(/ORCH_PARENT=s-self ORCH_PARENT_TASK=t2 ORCH_BRIEF='.*brief\.md' claude --remote-control='go'/)
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
    expect(out.stderr).toMatch(/agent_not_ready.*trust this folder.*orch link go s-self t2.*herdr agent prompt w9:p1 /s)

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

  const inHerdr = (ctx: TestCtx) => Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
  const spawn = (ctx: TestCtx, ...extra: string[]) => run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md', ...extra], ctx)

  it('never lets a name become a claude flag', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name=-p', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).not.toMatch(/--remote-control '-p'/)
    expect(out.stdout).toMatch(/--remote-control='p' /)
    const flag = await run(['spawn-child', 't2', '--name=--dangerously-skip-permissions', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(flag.stdout).toMatch(/--remote-control='dangerously-skip-permissions' /)
  })

  it('names the herdr agent the same way: lower case, no leading non-letter', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', '12Go Now', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(JSON.parse(out.stdout).agent).toBe('go-now')
  })

  it('quotes a quote in a path', async () => {
    const ctx = makeCtx()
    parent(ctx)
    mkdirSync(join(ctx.cwd, "it's"))
    writeFileSync(join(ctx.cwd, "it's", 'brief.md'), 'x')
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', "it's", '--brief', "it's/brief.md"], ctx)
    expect(out.stdout).toContain(`cd '${ctx.cwd}/it'\\''s' && `)
    expect(out.stdout).toContain(`ORCH_BRIEF='${ctx.cwd}/it'\\''s/brief.md'`)
  })

  it('strips control characters from what it prints', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-self', ctx.cwd, 1), ['do\x1b[31m this\nnow'], 2), title: 'Ti\x07tle' })
    writeFileSync(join(ctx.cwd, 'brief.md'), 'x')
    const out = await run(['spawn-child', 't1', '--name', 'go', '--cwd', '.', '--brief', 'brief.md', '--prompt', 'a\nb\x1bc'], ctx)
    expect(out.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
    expect(out.stdout).toMatch(/Ti tle.*do \[31m this now/s)
  })

  it('appends --prompt to the intro', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    await spawn(ctx, '--prompt', 'Start with the tests.')
    expect(ctx.herdr.calls[2][2]).toMatch(/with evidence\. Start with the tests\.$/)
  })

  it('sends the intro to herdr as one line, even with a multi-line --prompt', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    await spawn(ctx, '--prompt', 'one\ntwo\x1b[31m\n\nthree')
    const sent = ctx.herdr.calls[2][2]
    expect(sent).not.toMatch(/[\x00-\x1f]/)
    expect(sent).toMatch(/with evidence\. one two \[31m three$/)
  })

  it('prints the command when HERDR_ENV is set but there is no workspace', async () => {
    const ctx = makeCtx()
    ctx.env.HERDR_ENV = '1'
    parent(ctx)
    const out = await spawn(ctx)
    expect(out.stdout).toMatch(/Not inside herdr/)
    expect(ctx.herdr.calls).toEqual([])
  })

  it('checks the folder and the brief are what they should be', async () => {
    const ctx = makeCtx()
    parent(ctx)
    mkdirSync(join(ctx.cwd, 'adir'))
    const r = (...a: string[]) => run(['spawn-child', 't2', '--name', 'go', ...a], ctx)
    expect((await r('--cwd', 'missing', '--brief', 'brief.md')).stderr).toMatch(/cwd does not exist/)
    expect((await r('--cwd', 'brief.md', '--brief', 'brief.md')).stderr).toMatch(/cwd is not a directory/)
    expect((await r('--cwd', '.', '--brief', 'adir')).stderr).toMatch(/brief is not a file/)
  })

  it('does not show the trust hint for another herdr error code', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    ctx.herdr.startClaude = async () => {
      throw new HerdrError('herdr agent start failed: blocked', 'agent_blocked')
    }
    const out = await spawn(ctx)
    expect(out.stderr).not.toMatch(/trust this folder/)
    expect(out.stderr).toMatch(/orch link go s-self t2 --brief '.*brief\.md'/)
  })

  it('gives a recovery that links with the brief and sends the intro, after a failed start', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    ctx.herdr.startClaude = async () => {
      throw new OrchError('boom')
    }
    const out = await spawn(ctx)
    expect(out.stderr).toMatch(/orch link go s-self t2 --brief '[^']*brief\.md'/)
    expect(out.stderr).toMatch(/herdr agent prompt w9:p1 'You are a child session of "Courses"/)
    expect(out.stderr).toMatch(/no id yet.*orch status --all/)
  })

  it('stops waiting for the session id after a deadline, not a count', async () => {
    let t = 0
    const ctx = makeCtx({ now: () => t, sleep: async ms => void (t += ms) })
    inHerdr(ctx)
    parent(ctx)
    ctx.herdr.startClaude = async o => void ctx.herdr.agents.push({ name: o.name, paneId: o.paneId, status: 'idle' })
    let polls = 0
    ctx.herdr.sessionIdOf = async () => (polls++, undefined)
    const out = await spawn(ctx)
    expect(out.code).toBe(1)
    expect(polls).toBeGreaterThanOrEqual(100)
    expect(polls).toBeLessThanOrEqual(125)
    expect(out.stderr).toMatch(/did not report its session id within 60s/)
    expect(out.stderr).toMatch(/orch link go s-self t2 --brief .*herdr agent prompt go '/s)
    expect(out.stderr).toMatch(/orch status --all/)
  })

  it('tells how to finish by hand when the link fails, naming the session id', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    writeFileSync(join(ctx.orchHome, 's-child.json'), '{broken')
    const out = await spawn(ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/linking failed.*orch link 's-child' s-self t2 --brief .*herdr agent prompt go /s)
    expect(ctx.herdr.calls.some(c => c[0] === 'prompt')).toBe(false)
  })

  it('has linked before the intro goes out: a failed prompt leaves the link and prints the prompt command', async () => {
    const ctx = makeCtx()
    inHerdr(ctx)
    parent(ctx)
    ctx.herdr.prompt = async () => {
      throw new OrchError('herdr agent prompt failed')
    }
    const out = await spawn(ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/is linked under s-self t2.*herdr agent prompt go 'You are a child/s)
    expect(readPool(ctx.orchHome, 's-child')!.parent).toEqual({ sessionId: 's-self', taskId: 't2' })
    expect(readPool(ctx.orchHome, 's-self')!.tasks[1].children).toEqual(['s-child'])
  })

  it('strips control characters from the folder and brief paths it prints, still quoted', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const dir = 'a\x07b'
    mkdirSync(join(ctx.cwd, dir))
    writeFileSync(join(ctx.cwd, dir, 'brief.md'), 'x')
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', dir, '--brief', `${dir}/brief.md`], ctx)
    expect(out.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
    expect(out.stdout).toMatch(/cd '[^']*a b' && ORCH_PARENT=s-self ORCH_PARENT_TASK=t2 ORCH_BRIEF='[^']*a b\/brief\.md'/)
  })
})
