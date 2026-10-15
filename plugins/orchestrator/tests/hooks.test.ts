import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { askTask, newPool, plan } from '../src/model.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, type TestCtx } from './helpers.js'

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

describe('hook session-start', () => {
  it('registers the session and exports its id', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    const out = await hook(ctx, 'session-start', { session_id: 's-new', cwd: '/repo' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(readPool(ctx.orchHome, 's-new')).toMatchObject({ sessionId: 's-new', cwd: '/repo' })
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-new\n')
  })

  it('links a hand-started child from ORCH_* and points it at the brief', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make courses'], 2), title: 'Courses' })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't1', ORCH_BRIEF: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r/wt' })
    expect(readPool(ctx.orchHome, 's-kid')).toMatchObject({ parent: { sessionId: 's-par', taskId: 't1' }, brief: '/r/brief.md' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0]).toMatchObject({ children: ['s-kid'], status: 'in_progress' })
    expect(contextOf(out.stdout)).toMatch(/child of "Courses".*t1 \("Make courses"\).*Read \/r\/brief\.md first/)
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

  it('stays quiet after a read-only turn or on the first prompt', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Read', at: 6000 }, { name: 'Edit', at: 4000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
    expect((await hook(ctx, 'prompt-submit', { session_id: 's-first', transcript_path: path })).stdout).toBe('')
  })
})
