import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { askTask, linkChild, newPool, plan } from '../src/model.js'
import { poolPath, readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession, type TestCtx } from './helpers.js'

const hook = (ctx: TestCtx, name: string, input: object) => {
  ctx.stdin = JSON.stringify(input)
  return run(['hook', name], ctx)
}
const contextOf = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string

function transcript(ctx: TestCtx, tools: { name: string; at: number }[]): string {
  const path = join(ctx.cwd, 't.jsonl')
  writeFileSync(path, tools.map(t => JSON.stringify({ type: 'assistant', timestamp: new Date(t.at).toISOString(), message: { content: [{ type: 'tool_use', name: t.name, input: {} }] } })).join('\n') + '\n')
  return path
}

describe('hook prompt-submit and orch reply', () => {
  const twoQuestions = (ctx: TestCtx) => {
    let p = plan(newPool('s-self', '/r', 1), ['a', 'b', 'c'], 2)
    p = askTask(p, 't2', 'Strict or "lenient"?', 3)
    writePool(ctx.orchHome, askTask(p, 't3', 'Which curve?', 4))
  }
  const asked = (ctx: TestCtx) => readPool(ctx.orchHome, 's-self')!.tasks.map(t => t.needsInput)

  it('clears only the question an orch reply frame quotes', async () => {
    const ctx = makeCtx()
    twoQuestions(ctx)
    await hook(ctx, 'prompt-submit', { session_id: 's-self', prompt: `[orch reply to: ${JSON.stringify('Strict or "lenient"?')}] lenient` })
    expect(asked(ctx)).toEqual([undefined, undefined, 'Which curve?'])
  })

  it('clears nothing when the quoted question matches no task', async () => {
    const ctx = makeCtx()
    twoQuestions(ctx)
    await hook(ctx, 'prompt-submit', { session_id: 's-self', prompt: `[orch reply to: "something else"] yes` })
    expect(asked(ctx)).toEqual([undefined, 'Strict or "lenient"?', 'Which curve?'])
  })

  it('still clears every question for a prompt the person typed', async () => {
    const ctx = makeCtx()
    twoQuestions(ctx)
    await hook(ctx, 'prompt-submit', { session_id: 's-self', prompt: 'lenient, and the second curve' })
    expect(asked(ctx)).toEqual([undefined, undefined, undefined])
  })
})

describe('pruning empty pools at session start', () => {
  const D = 86_400_000
  const NOW = 30 * D
  const empty = (id: string, at: number, extra: object = {}) => ({ ...newPool(id, '/r', at), ...extra })
  const start = (ctx: TestCtx) => hook(ctx, 'session-start', { session_id: 's-new', cwd: '/r', source: 'startup' })
  const gone = (ctx: TestCtx, id: string) => !existsSync(poolPath(ctx.orchHome, id))

  it('deletes old ended pools with no tasks, and keeps everything else', async () => {
    const ctx = makeCtx({ now: () => NOW })
    writePool(ctx.orchHome, empty('old-empty', NOW - 8 * D))
    writePool(ctx.orchHome, empty('recent-empty', NOW - 6 * D))
    writePool(ctx.orchHome, plan(empty('old-tasks', NOW - 8 * D), ['a'], NOW - 8 * D))
    writePool(ctx.orchHome, empty('old-touched', NOW - 8 * D, { touchedAt: NOW - D }))
    writePool(ctx.orchHome, empty('old-live', NOW - 8 * D))
    writePool(ctx.orchHome, empty('old-parent', NOW - 8 * D))
    writePool(ctx.orchHome, empty('old-kid', NOW - 8 * D, { parent: { sessionId: 'old-parent', taskId: 't1' } }))
    writePool(ctx.orchHome, plan(empty('holder', NOW - D), ['x'], NOW - D))
    writePool(ctx.orchHome, linkChild(readPool(ctx.orchHome, 'holder')!, 't1', 'old-listed', NOW - D))
    writePool(ctx.orchHome, empty('old-listed', NOW - 8 * D))
    writeSession(ctx, { pid: 7, sessionId: 'old-live' })
    await start(ctx)
    expect(['old-empty'].every(id => gone(ctx, id))).toBe(true)
    for (const id of ['recent-empty', 'old-tasks', 'old-touched', 'old-live', 'old-parent', 'old-kid', 'old-listed', 's-new']) expect(gone(ctx, id), id).toBe(false)
  })

  it('prunes at most once an hour', async () => {
    let now = NOW
    const ctx = makeCtx({ now: () => now })
    writePool(ctx.orchHome, empty('first', NOW - 8 * D))
    await start(ctx)
    expect(gone(ctx, 'first')).toBe(true)
    expect(existsSync(join(ctx.orchHome, '.pruned'))).toBe(true)
    writePool(ctx.orchHome, empty('second', NOW - 8 * D))
    now += 30 * 60_000
    await start(ctx)
    expect(gone(ctx, 'second')).toBe(false)
    now += 40 * 60_000
    await start(ctx)
    expect(gone(ctx, 'second')).toBe(true)
  })
})

describe('hook session-start', () => {
  it('registers the session and exports its id', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    const out = await hook(ctx, 'session-start', { session_id: 's-new', cwd: '/repo', source: 'startup' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(readPool(ctx.orchHome, 's-new')).toMatchObject({ sessionId: 's-new', cwd: '/repo' })
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-new\n')
  })

  it('links a hand-started child from ORCH_* and points it at the brief', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make courses'], 2), title: 'Courses' })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't1', ORCH_BRIEF: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r/wt', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')).toMatchObject({ parent: { sessionId: 's-par', taskId: 't1' }, brief: '/r/brief.md' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0]).toMatchObject({ children: ['s-kid'], status: 'in_progress' })
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(contextOf(out.stdout)).toMatch(/child of "Courses".*t1 \("Make courses"\).*Read \/r\/brief\.md first/)
  })

  it('folds the parent title and task text onto one line', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make\x1b]0;x\x07\ncourses'], 2), title: 'Cour\nses' })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't1', ORCH_BRIEF: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r/wt', source: 'startup' })
    expect(contextOf(out.stdout)).toContain('child of "Cour ses" for its task t1 ("Make ]0;x courses")')
  })

  it('does not export an id that failed vetting into the env file', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    const out = await hook(ctx, 'session-start', { session_id: 'x; touch /tmp/pwned', cwd: '/repo' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(envFile)).toBe(false)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/invalid session id/)
  })

  const parentPool = (ctx: TestCtx) => writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make courses'], 2), title: 'Courses' })
  const orchEnv = (ctx: TestCtx, task = 't1', parent = 's-par') =>
    Object.assign(ctx.env, { ORCH_PARENT: parent, ORCH_PARENT_TASK: task, ORCH_BRIEF: '/r/brief.md' })
  const lockDir = (ctx: TestCtx, id: string) => mkdirSync(`${poolPath(ctx.orchHome, id)}.lock`, { recursive: true })

  it('keeps the brief when ORCH_PARENT_TASK names no task', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx, 't9')
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    const kid = readPool(ctx.orchHome, 's-kid')!
    expect(kid.parent).toBeUndefined()
    expect(kid.brief).toBe('/r/brief.md')
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toBeUndefined()
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/t9/)
  })

  it('keeps the brief when ORCH_PARENT is not a valid session id', async () => {
    const ctx = makeCtx()
    orchEnv(ctx, 't1', '../x')
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')).toMatchObject({ brief: '/r/brief.md' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toBeUndefined()
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/invalid session id/)
  })

  it('links only on startup, so /clear cannot add a duplicate child', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    await hook(ctx, 'session-start', { session_id: 'kid2', cwd: '/r', source: 'clear' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['kid1'])
    expect(readPool(ctx.orchHome, 'kid2')!.parent).toBeUndefined()
  })

  it('does not re-parent or duplicate a resumed child', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    const out = await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'resume' })
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['kid1'])
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
  })

  it('does not link into a parent other than the one the child already has', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    writePool(ctx.orchHome, { ...newPool('s-kid', '/r', 1), parent: { sessionId: 's-other', taskId: 't1' } })
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-other', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toBeUndefined()
  })

  it('does not link under a task other than the one the child is already under', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['one', 'two'], 2), title: 'Courses' })
    writePool(ctx.orchHome, { ...newPool('s-kid', '/r', 1), parent: { sessionId: 's-par', taskId: 't1' } })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't2', ORCH_BRIEF: '/r/brief.md' })
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[1].children).toBeUndefined()
  })

  it('unsets ORCH_* in the env file so nested claude runs do not inherit them', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-kid\nunset ORCH_PARENT ORCH_PARENT_TASK ORCH_BRIEF\n')
  })

  it('exports the id even when its own pool is locked', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    lockDir(ctx, 's-busy')
    const out = await hook(ctx, 'session-start', { session_id: 's-busy', cwd: '/r', source: 'startup' })
    expect(out.code).toBe(0)
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-busy\n')
  })

  it('tells a child that already has tasks to pick up where it left off', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    writePool(ctx.orchHome, { ...plan(newPool('s-kid', '/r', 1), ['a'], 2), parent: { sessionId: 's-par', taskId: 't1' }, brief: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'resume' })
    expect(contextOf(out.stdout)).toMatch(/orch status.*where you left off/)
    expect(contextOf(out.stdout)).not.toMatch(/orch plan/)
  })

  it('never fails the session, and logs what went wrong', async () => {
    const ctx = makeCtx()
    ctx.stdin = '{broken'
    expect(await run(['hook', 'session-start'], ctx)).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/hook session-start/)
  })
})

describe('hook prompt-submit', () => {
  it('clears open questions and starts the turn clock', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, askTask(plan(newPool('s1', '/r', 1), ['a'], 2), 't1', 'q?', 3))
    await hook(ctx, 'prompt-submit', { session_id: 's1' })
    const p = readPool(ctx.orchHome, 's1')!
    expect(p.tasks[0].needsInput).toBeUndefined()
    expect(p.turnStartedAt).toBeGreaterThan(0)
  })

  it('nudges when the last turn worked but the pool was not touched', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Edit', at: 6000 }])
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(contextOf(out.stdout)).toMatch(/was not updated during your last turn/)
  })

  it('stays quiet when the pool was touched during the turn', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 7000), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Bash', at: 6000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('suggests a pool when the session worked without one', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...newPool('s1', '/r', 1), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Write', at: 6000 }])
    expect(contextOf((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout)).toMatch(/has no task pool/)
  })

  it('still clears the question when the transcript cannot be read', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...askTask(plan(newPool('s1', '/r', 1), ['a'], 2), 't1', 'q?', 3), turnStartedAt: 5000 })
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: '/nonexistent' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    const p = readPool(ctx.orchHome, 's1')!
    expect(p.tasks[0].needsInput).toBeUndefined()
    expect(p.turnStartedAt).toBeGreaterThan(5000)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/transcript/)
  })

  it('gives up quickly on a leftover lock', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s1', '/r', 1), ['a'], 2))
    mkdirSync(`${poolPath(ctx.orchHome, 's1')}.lock`)
    const t0 = Date.now()
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/locked/)
  })

  it('counts a subagent run as work', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    for (const name of ['Agent', 'Task']) {
      const path = transcript(ctx, [{ name, at: 6000 }])
      expect(contextOf((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout)).toMatch(/not updated/)
      writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    }
  })

  it('treats the pool as touched when touchedAt equals the turn start', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 5000), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Edit', at: 6000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('ignores transcript lines without a timestamp or of another type', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = join(ctx.cwd, 'u.jsonl')
    const use = { content: [{ type: 'tool_use', name: 'Edit' }] }
    writeFileSync(path, [{ type: 'api-request-blob', timestamp: new Date(6000).toISOString(), message: use }, { type: 'assistant', message: use }].map(o => JSON.stringify(o)).join('\n') + '\n')
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('stays quiet after a read-only turn or on the first prompt', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Read', at: 6000 }, { name: 'Edit', at: 4000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
    expect((await hook(ctx, 'prompt-submit', { session_id: 's-first', transcript_path: path })).stdout).toBe('')
  })
})
