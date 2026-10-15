import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { oneLine } from './evidence.js'
import { findFrame, frameQuestion } from './frame.js'
import { clearQuestions, linkChild, newPool, setParent, startTurn, type Pool } from './model.js'
import { ok, type Out } from './out.js'
import { pruneEmptyPools } from './prune.js'
import { log, poolPath, readPool, update, updateIfExists } from './store.js'

type HookInput = { session_id?: string; cwd?: string; transcript_path?: string; source?: string; prompt?: string }
type Input = HookInput & { session_id: string }

const WORK = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task']) // subagent edits never show up in this transcript
const NO_POOL =
  '[orch] Your last turn changed files or ran commands, and this session has no task pool. If this is multi-step work, run `orch plan "step" "step" …` (see the orch-pool skill).'
const STALE =
  '[orch] Your task pool was not updated during your last turn. Run `orch status`, then tick finished tasks with evidence or re-plan.'

const context = (event: string, text: string): Out =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`)

// A hook must never wait long on a lock: a stuck one would delay every prompt.
const LOCK_WAIT_MS = 1500

// A hook must never break the session: every error is logged and swallowed.
export async function runHook(ctx: Ctx, name: string | undefined): Promise<Out> {
  try {
    const input = JSON.parse((await ctx.readStdin()) || '{}') as HookInput
    if (!input.session_id) return ok()
    if (name === 'session-start') return await sessionStart(ctx, input as Input)
    if (name === 'prompt-submit') return await promptSubmit(ctx, input as Input)
    log(ctx.orchHome, `unknown hook ${name}`)
  } catch (e) {
    log(ctx.orchHome, `hook ${name}: ${e instanceof OrchError ? e.message : e instanceof Error ? e.stack : String(e)}`)
  }
  return ok()
}

async function sessionStart(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  // poolPath vets the id; the env file is sourced by a shell, so nothing is written before it passes.
  poolPath(ctx.orchHome, id)
  // ORCH_* are set only when the person started this child by hand (spawn-child outside herdr).
  const parentId = ctx.env.ORCH_PARENT
  const taskId = ctx.env.ORCH_PARENT_TASK
  const brief = ctx.env.ORCH_BRIEF
  if (ctx.env.CLAUDE_ENV_FILE) {
    const unset = parentId || taskId || brief ? 'unset ORCH_PARENT ORCH_PARENT_TASK ORCH_BRIEF\n' : ''
    appendFileSync(ctx.env.CLAUDE_ENV_FILE, `export CLAUDE_SESSION_ID=${id}\n${unset}`)
  }

  // /clear, resume and compact start a session again; only a fresh start may link, or a child would be added twice.
  const linking = input.source === 'startup' && !!(parentId && taskId)
  let linkable = false
  if (linking) {
    try {
      linkable = !!readPool(ctx.orchHome, parentId!)?.tasks.some(t => t.id === taskId)
      if (!linkable) log(ctx.orchHome, `hook session-start: parent ${parentId} has no task ${taskId}; keeping only the brief`)
    } catch (e) {
      log(ctx.orchHome, `hook session-start: cannot use parent ${parentId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const pool = await update(
    ctx.orchHome,
    id,
    p => {
      const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
      if (!linking || q.parent) return q
      if (linkable) return setParent(q, { sessionId: parentId!, taskId: taskId! }, brief, now)
      return brief ? { ...q, brief, updatedAt: now } : q
    },
    LOCK_WAIT_MS,
  )
  if (linkable && pool.parent?.sessionId === parentId && pool.parent?.taskId === taskId) {
    try {
      await updateIfExists(ctx.orchHome, parentId!, p => linkChild(p, taskId!, id, now), LOCK_WAIT_MS)
    } catch (e) {
      log(ctx.orchHome, `hook session-start: cannot link ${id} under ${parentId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  try {
    await pruneEmptyPools(ctx, id)
  } catch (e) {
    log(ctx.orchHome, `hook session-start: prune: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!pool.brief) return ok()
  const next = pool.tasks.length ? 'run `orch status` to pick up where you left off' : 'then run `orch plan` for your part and tick each task with evidence'
  if (!pool.parent) return context('SessionStart', `[orch] Read ${pool.brief} first, ${next}.`)
  let parent
  try {
    parent = readPool(ctx.orchHome, pool.parent.sessionId)
  } catch {
    // an unreadable parent only costs the title
  }
  const task = parent?.tasks.find(t => t.id === pool.parent!.taskId)
  return context(
    'SessionStart',
    `[orch] This session is a child of "${oneLine(parent?.title) || pool.parent.sessionId}" for its task ${pool.parent.taskId}${task ? ` ("${oneLine(task.text)}")` : ''}. Read ${pool.brief} first, ${next}.`,
  )
}

// An orch reply answers one question, and its frame says which. Any other prompt answers everything.
function clearAnswered(pool: Pool, prompt: string | undefined, now: number): Pool | undefined {
  const frame = typeof prompt === 'string' ? findFrame(prompt) : undefined
  if (!frame) return clearQuestions(pool, now)
  const task = pool.tasks.find(t => t.needsInput && frameQuestion(t.needsInput) === frame)
  return task ? clearQuestions(pool, now, task.id) : undefined
}

async function promptSubmit(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  const before = readPool(ctx.orchHome, id)
  const since = before?.turnStartedAt

  // The pool update comes first: an unreadable transcript must not keep the question flag or the turn clock stale.
  await update(
    ctx.orchHome,
    id,
    p => {
      const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
      return startTurn(clearAnswered(q, input.prompt, now) ?? q, now)
    },
    LOCK_WAIT_MS,
  )

  let didWork = false
  if (since !== undefined && input.transcript_path) {
    try {
      didWork = workedSince(input.transcript_path, since)
    } catch (e) {
      log(ctx.orchHome, `hook prompt-submit: cannot read transcript: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
    if (o.type !== 'assistant' || !(Date.parse(o.timestamp ?? '') >= since)) continue
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
