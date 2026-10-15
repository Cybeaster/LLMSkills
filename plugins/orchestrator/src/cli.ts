import { parseArgs } from 'node:util'
import { collect } from './collect.js'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { describeEvidence, parseEvidence } from './evidence.js'
import { flatten, renderList, renderPool } from './format.js'
import { addTask, askTask, blockTask, doneTask, newPool, plan, setTitle, startTask, type Evidence, type Pool } from './model.js'
import { ok, type Out } from './out.js'
import { buildOverview } from './overview.js'
import { resolveSelf } from './self.js'
import { listPools, readPool, update } from './store.js'

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
  orch link <child> <parent> <taskId>    attach a session under a parent task
  orch spawn-child <taskId> --name <n> --cwd <dir> --brief <file> [--prompt <text>]
  orch reply <session> "text" [--mark-only]
  orch tui
`

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new OrchError(`missing ${what}\n\n${HELP}`, 2)
  return v
}

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
  if (!args.length) throw new OrchError('orch plan needs at least one step', 2)
  const p = await mutateSelf(ctx, p => plan(p, args, ctx.now()))
  return ok(poolText(ctx, p))
}

async function cmdTitle(ctx: Ctx, args: string[]): Promise<Out> {
  const title = need(args.join(' ').trim() || undefined, 'title')
  await mutateSelf(ctx, p => setTitle(p, title, ctx.now()))
  return ok(`title: ${title}\n`)
}

async function cmdDone(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { evidence: { type: 'string' } }, allowPositionals: true })
  const id = need(positionals[0], 'task id')
  if (positionals.length > 1) throw new OrchError(`orch task done takes one task id, got "${positionals.join(' ')}"; quote the evidence, e.g. --evidence "note:looked fine"`, 2)
  let evidence: Evidence | undefined
  if (values.evidence) {
    const e = parseEvidence(values.evidence)
    if (e.kind === 'cmd') {
      const self = readPool(ctx.orchHome, resolveSelf(ctx))
      if (!self?.tasks.some(t => t.id === id)) throw new OrchError(`no task ${id} in this pool`)
      const r = await ctx.exec(e.ref, self.cwd || ctx.cwd)
      if (r.code !== 0) {
        const tail = r.out.trimEnd().split('\n').slice(-20).join('\n')
        throw new OrchError(`refused: \`${e.ref}\` exited ${r.code}, so ${id} stays open\n${tail}`)
      }
      evidence = { kind: 'cmd', ref: e.ref, exit: 0 }
    } else {
      evidence = e
    }
  }
  await mutateSelf(ctx, p => doneTask(p, id, evidence, ctx.now()))
  return ok(evidence ? `${id} done (${describeEvidence(evidence)})\n` : `${id} done, but only claimed: add --evidence to prove it\n`)
}

async function cmdTask(ctx: Ctx, args: string[]): Promise<Out> {
  const [sub, ...rest] = args
  const now = ctx.now()
  switch (sub) {
    case 'add': {
      const text = need(rest.join(' ').trim() || undefined, 'task text')
      const p = await mutateSelf(ctx, p => addTask(p, text, now))
      return ok(`added ${p.tasks.at(-1)!.id}\n`)
    }
    case 'start': {
      const id = need(rest[0], 'task id')
      await mutateSelf(ctx, p => startTask(p, id, now))
      return ok(`${id} in progress\n`)
    }
    case 'block': {
      const id = need(rest[0], 'task id')
      const why = need(rest.slice(1).join(' ').trim() || undefined, 'reason')
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
  const id = need(args[0], 'task id')
  const question = need(args.slice(1).join(' ').trim() || undefined, 'question')
  await mutateSelf(ctx, p => askTask(p, id, question, ctx.now()))
  return ok(`⚑ ${id}: ${question}\nNow send the person a push notification naming this session and the question.\n`)
}

async function cmdStatus(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true })
  const rows = await collect(ctx)
  // --all --json drops task lists and indentation so /orch's Bash output stays small; /orch then asks for one session by id
  if (values.all) return ok(values.json ? `${JSON.stringify(rows, (k, v) => (k === 'tasks' ? undefined : v))}\n` : renderList(rows))
  const id = positionals[0] ?? resolveSelf(ctx)
  const row = flatten(rows).map(l => l.row).find(r => r.sessionId === id)
  if (positionals[0] && !row) throw new OrchError(`no session ${id}`)
  if (values.json) return ok(`${JSON.stringify(row ?? null)}\n`)
  if (row?.tasks.length) return ok(renderPool(row))
  return ok(row && positionals[0] ? `${row.name} has no pool yet\n` : 'no pool yet: run orch plan "step" "step" …\n')
}

export async function run(argv: string[], ctx: Ctx): Promise<Out> {
  const [cmd, ...rest] = argv
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
