import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { Ctx } from './ctx.js'
import { clearQuestions, linkChild, newPool, setParent, startTurn } from './model.js'
import { ok, type Out } from './out.js'
import { log, readPool, update, updateIfExists } from './store.js'

type HookInput = { session_id?: string; cwd?: string; transcript_path?: string }
type Input = HookInput & { session_id: string }

const WORK = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const NO_POOL =
  '[orch] Your last turn changed files or ran commands, and this session has no task pool. If this is multi-step work, run `orch plan "step" "step" …` (see the orch-pool skill).'
const STALE =
  '[orch] Your task pool was not updated during your last turn. Run `orch status`, then tick finished tasks with evidence or re-plan.'

const context = (event: string, text: string): Out =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`)

// A hook must never break the session: every error is logged and swallowed.
export async function runHook(ctx: Ctx, name: string | undefined): Promise<Out> {
  try {
    const input = JSON.parse((await ctx.readStdin()) || '{}') as HookInput
    if (!input.session_id) return ok()
    if (name === 'session-start') return await sessionStart(ctx, input as Input)
    if (name === 'prompt-submit') return await promptSubmit(ctx, input as Input)
    log(ctx.orchHome, `unknown hook ${name}`)
  } catch (e) {
    log(ctx.orchHome, `hook ${name}: ${e instanceof Error ? e.stack : String(e)}`)
  }
  return ok()
}

async function sessionStart(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  // ORCH_* are set only when the person started this child by hand (spawn-child outside herdr).
  const parentId = ctx.env.ORCH_PARENT
  const taskId = ctx.env.ORCH_PARENT_TASK
  const pool = await update(ctx.orchHome, id, p => {
    const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
    return parentId && taskId && !q.parent ? setParent(q, { sessionId: parentId, taskId }, ctx.env.ORCH_BRIEF, now) : q
  })

  // Only after `update` has vetted the id (poolPath throws on anything unsafe): the env file is sourced by a shell.
  if (ctx.env.CLAUDE_ENV_FILE) appendFileSync(ctx.env.CLAUDE_ENV_FILE, `export CLAUDE_SESSION_ID=${id}\n`)
  if (parentId && taskId && pool.parent?.sessionId === parentId)
    await updateIfExists(ctx.orchHome, parentId, p => linkChild(p, taskId, id, now))

  if (!pool.parent || !pool.brief) return ok()
  const parent = readPool(ctx.orchHome, pool.parent.sessionId)
  const task = parent?.tasks.find(t => t.id === pool.parent!.taskId)
  return context(
    'SessionStart',
    `[orch] This session is a child of "${parent?.title || pool.parent.sessionId}" for its task ${pool.parent.taskId}${task ? ` ("${task.text}")` : ''}. Read ${pool.brief} first, then run \`orch plan\` for your part and tick each task with evidence.`,
  )
}

async function promptSubmit(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  const before = readPool(ctx.orchHome, id)
  const since = before?.turnStartedAt
  const didWork = since !== undefined && !!input.transcript_path && workedSince(input.transcript_path, since)

  await update(ctx.orchHome, id, p => {
    const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
    return startTurn(clearQuestions(q, now) ?? q, now)
  })

  if (!didWork || !before) return ok()
  if (!before.tasks.length) return context('UserPromptSubmit', NO_POOL)
  if ((before.touchedAt ?? 0) < since!) return context('UserPromptSubmit', STALE)
  return ok()
}

export function workedSince(path: string, since: number): boolean {
  for (const line of readTail(path, 4 << 20).split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let o: { type?: string; timestamp?: string; message?: { content?: { type?: string; name?: string }[] } }
    try {
      o = JSON.parse(line)
    } catch {
      continue // the first line of a tail read is usually cut
    }
    if (o.type !== 'assistant' || Date.parse(o.timestamp ?? '') < since) continue
    if (o.message?.content?.some(b => b?.type === 'tool_use' && WORK.has(b.name ?? ''))) return true
  }
  return false
}

function readTail(path: string, max: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
