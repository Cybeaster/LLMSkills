import { parseArgs } from 'node:util'
import { collect } from './collect.js'
import { CMD_TIMEOUT_MS, type Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { describeEvidence, parseEvidence } from './evidence.js'
import { flatten, renderList, renderPool } from './format.js'
import { runHook } from './hooks.js'
import { linkSessions } from './link.js'
import { addTask, askTask, blockTask, doneTask, newPool, plan, setTitle, startTask, type Evidence, type Pool } from './model.js'
import { ok, type Out } from './out.js'
import { briefFile } from './paths.js'
import { buildOverview } from './overview.js'
import { reply } from './reply.js'
import { resolveSelf, trySelf } from './self.js'
import { spawnChild } from './spawn.js'
import { listPools, readPool, update } from './store.js'
import { resolveSession } from './targets.js'

const HELP = `orch — task pools for Claude Code sessions

  orch plan "step" "step" …              replace the pending part of this session's pool
  orch title "what this session is for"
  orch task add "text"
  orch task start <id>
  orch task block <id> "why"
  orch task done <id> [--evidence commit:<sha> | pr:<n|url> | ci:<run-url> | cmd:<command> | note:<text>]
  orch ask <id> "question"               flag a question for the person (⚑)
  orch status [<session-id>] [--json]    this (or that) session's pool
  orch status --all [--json]             every session
  orch link <child> <parent> <taskId> [--brief <file>]
                                         attach a session under a parent task
  orch spawn-child <taskId> --name <n> --cwd <dir> --brief <file> [--prompt <text>]
  orch reply <session> "text" [--mark-only]
  orch tui
`

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new OrchError(`missing ${what} (orch help lists the commands)`, 2)
  return v
}

// The words of a free-text command. An option-looking word (-x) is an error rather than task text;
// a word that starts with a dash goes after `--`.
const words = (args: string[]): string[] => parseArgs({ args, allowPositionals: true }).positionals

function mutateSelf(ctx: Ctx, f: (p: Pool) => Pool): Promise<Pool> {
  const id = resolveSelf(ctx)
  return update(ctx.orchHome, id, p => f(p ?? newPool(id, ctx.cwd, ctx.now())))
}

// Built from the whole store, so a task that waits on children shows their real progress.
function poolText(ctx: Ctx, p: Pool): string {
  const rows = buildOverview({ pools: listPools(ctx.orchHome), live: [], agents: null, checks: new Map(), now: ctx.now() })
  const row = flatten(rows).map(l => l.row).find(r => r.sessionId === p.sessionId)
  return row ? renderPool(row) : ''
}

async function cmdPlan(ctx: Ctx, args: string[]): Promise<Out> {
  const steps = words(args).map(s => s.trim())
  if (!steps.length) throw new OrchError('orch plan needs at least one step', 2)
  if (steps.some(s => !s)) throw new OrchError('orch plan steps cannot be blank', 2)
  const p = await mutateSelf(ctx, p => plan(p, steps, ctx.now()))
  return ok(poolText(ctx, p))
}

async function cmdTitle(ctx: Ctx, args: string[]): Promise<Out> {
  const title = need(words(args).join(' ').trim() || undefined, 'title')
  await mutateSelf(ctx, p => setTitle(p, title, ctx.now()))
  return ok(`title: ${title}\n`)
}

// What a failing command printed, safe to show: whole escape sequences (CSI such as colours, OSC such as
// titles and links) gone, then every other control character but newline and tab (\r becomes a line
// break), the last 20 lines, about 4 KB.
function tailOf(out: string): string {
  const clean = out
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cc}/gu, c => (c === '\n' || c === '\t' ? c : ''))
    .trimEnd()
    .split('\n')
    .slice(-20)
    .join('\n')
  return clean.length > 4096 ? `…${clean.slice(-4096)}` : clean
}

// A refusal, followed by the tail of what the command printed when it printed anything.
function refusal(message: string, out: string): OrchError {
  const tail = tailOf(out)
  return new OrchError(tail ? `${message}\n${tail}` : message)
}

async function cmdDone(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { evidence: { type: 'string' } }, allowPositionals: true })
  const id = need(positionals[0], 'task id')
  if (positionals.length > 1) throw new OrchError(`orch task done takes one task id, got "${positionals.join(' ')}"; quote the evidence, e.g. --evidence "note:looked fine"`, 2)
  let evidence: Evidence | undefined
  if (values.evidence !== undefined) {
    const e = parseEvidence(values.evidence)
    if (e.kind === 'cmd') {
      const self = readPool(ctx.orchHome, resolveSelf(ctx))
      if (!self?.tasks.some(t => t.id === id)) throw new OrchError(`no task ${id} in this pool`)
      // where the session is (the Bash tool's current directory), which is not always where its pool began
      const r = await ctx.exec(e.ref, ctx.cwd)
      if (r.timedOut) {
        throw refusal(`refused: \`${e.ref}\` timed out after ${CMD_TIMEOUT_MS / 1000} s in ${ctx.cwd}, so ${id} stays open; run long commands yourself and tick with commit:, ci: or note:`, r.out)
      }
      if (r.signal || r.code !== 0) {
        const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.code}`
        throw refusal(`refused: \`${e.ref}\` ${how} in ${ctx.cwd}, so ${id} stays open`, r.out)
      }
      evidence = { kind: 'cmd', ref: e.ref, exit: 0 }
    } else {
      evidence = e
    }
  }
  await mutateSelf(ctx, p => doneTask(p, id, evidence, ctx.now()))
  const where = evidence?.kind === 'cmd' ? ` in ${ctx.cwd}` : ''
  return ok(evidence ? `${id} done (${describeEvidence(evidence)}${where})\n` : `${id} done, but only claimed: add --evidence to prove it\n`)
}

async function cmdTask(ctx: Ctx, args: string[]): Promise<Out> {
  const [sub, ...rest] = args
  const now = ctx.now()
  switch (sub) {
    case 'add': {
      const text = need(words(rest).join(' ').trim() || undefined, 'task text')
      const p = await mutateSelf(ctx, p => addTask(p, text, now))
      return ok(`added ${p.tasks.at(-1)!.id}\n`)
    }
    case 'start': {
      const id = need(words(rest)[0], 'task id')
      await mutateSelf(ctx, p => startTask(p, id, now))
      return ok(`${id} in progress\n`)
    }
    case 'block': {
      const [id, ...reason] = words(rest)
      need(id, 'task id')
      const why = need(reason.join(' ').trim() || undefined, 'reason')
      await mutateSelf(ctx, p => blockTask(p, id, why, now))
      return ok(`${id} blocked: ${why}\n`)
    }
    case 'done':
      return cmdDone(ctx, rest)
    default:
      throw new OrchError(`usage: orch task add|start|block|done …\n\n${HELP}`, 2)
  }
}

async function cmdAsk(ctx: Ctx, args: string[]): Promise<Out> {
  const [id, ...rest] = words(args)
  need(id, 'task id')
  const question = need(rest.join(' ').trim() || undefined, 'question')
  await mutateSelf(ctx, p => askTask(p, id, question, ctx.now()))
  return ok(`⚑ ${id}: ${question}\nNow send the person a push notification naming this session and the question.\n`)
}

async function cmdStatus(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true })
  // --all --json drops task lists and indentation so /orch's Bash output stays small; /orch then asks for one session by id.
  // The overview asks gh nothing: it would wait on one call per finished task of every session.
  if (values.all) {
    const rows = await collect(ctx)
    return ok(values.json ? `${JSON.stringify(rows, (k, v) => (k === 'tasks' ? undefined : v))}\n` : renderList(rows))
  }
  // the id first, so outside a session this fails before herdr or gh is asked; gh only about the pool shown
  const id = positionals[0] ?? resolveSelf(ctx)
  const rows = await collect(ctx, { checks: new Set([id]) })
  const row = flatten(rows).map(l => l.row).find(r => r.sessionId === id)
  if (positionals[0] && !row) throw new OrchError(`no session ${id}`)
  if (values.json) return ok(`${JSON.stringify(row ?? null)}\n`)
  if (row?.tasks.length) return ok(renderPool(row))
  return ok(row && positionals[0] ? `${row.name} has no pool yet\n` : 'no pool yet: run orch plan "step" "step" …\n')
}

// How main prints a failure that run did not turn into an Out: the message alone, never a stack trace.
export function describeFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  const sandbox = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
  return `orch: ${message}\n${sandbox ? `if Claude Code's Bash sandbox is on, add "orch *" to sandbox.excludedCommands in ~/.claude/settings.json\n` : ''}`
}

async function cmdLink(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { brief: { type: 'string' } }, allowPositionals: true })
  const [child, parent, taskId] = [need(positionals[0], 'child session'), need(positionals[1], 'parent session'), need(positionals[2], 'parent task id')]
  const brief = values.brief === undefined ? undefined : briefFile(ctx, values.brief)
  const rows = await collect(ctx)
  const c = await resolveSession(ctx, rows, child, { herdr: true })
  const p = await resolveSession(ctx, rows, parent)
  await linkSessions(ctx, c.sessionId, p.sessionId, taskId, { brief, byParent: trySelf(ctx) === p.sessionId })
  return ok(`${c.name} is now under ${p.name} ${taskId}\n`)
}

async function cmdSpawn(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, cwd: { type: 'string' }, brief: { type: 'string' }, prompt: { type: 'string' } },
    allowPositionals: true,
  })
  return spawnChild(ctx, {
    taskId: need(positionals[0], 'task id'),
    name: need(values.name, '--name'),
    cwd: need(values.cwd, '--cwd'),
    brief: need(values.brief, '--brief'),
    prompt: values.prompt,
  })
}

async function cmdReply(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { 'mark-only': { type: 'boolean' } }, allowPositionals: true })
  const session = need(positionals[0], 'session')
  return reply(ctx, session, positionals.slice(1).join(' ').trim() || undefined, !!values['mark-only'])
}

export async function run(argv: string[], ctx: Ctx): Promise<Out> {
  const [cmd, ...rest] = argv
  // --help or -h anywhere before a `--` is a request for help, never task text
  const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (flags.includes('--help') || flags.includes('-h')) return ok(HELP)
  try {
    switch (cmd) {
      case 'plan':
        return await cmdPlan(ctx, rest)
      case 'title':
        return await cmdTitle(ctx, rest)
      case 'task':
        return await cmdTask(ctx, rest)
      case 'ask':
        return await cmdAsk(ctx, rest)
      case 'status':
        return await cmdStatus(ctx, rest)
      case 'hook':
        return await runHook(ctx, rest[0])
      case 'link':
        return await cmdLink(ctx, rest)
      case 'spawn-child':
        return await cmdSpawn(ctx, rest)
      case 'reply':
        return await cmdReply(ctx, rest)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return ok(HELP)
      default:
        return { code: 2, stdout: '', stderr: `orch: unknown command ${cmd}\n\n${HELP}` }
    }
  } catch (e) {
    if (e instanceof OrchError) return { code: e.code, stdout: '', stderr: `orch: ${e.message}\n` }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) return { code: 2, stdout: '', stderr: `orch: ${e.message}\n` }
    throw e
  }
}
