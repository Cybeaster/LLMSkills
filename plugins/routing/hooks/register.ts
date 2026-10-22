import type { EngineInterface, Register } from 'claude-code'
import { agentHeader, check, classOf, denyText, merge, ruleText, type Budget, type Layer, type Policy } from './policy.ts'
import { logPath } from './log.ts'

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as T) : undefined
  } catch {
    return undefined
  }
}

// read on every call, so an edited policy applies at once
async function loadPolicy($: EngineInterface): Promise<Policy> {
  const home = await $.env.get('HOME')
  const base = await readJson<Policy>($, `${$.plugin.root}/policy.json`)
  if (!base) throw new Error('routing: the plugin policy.json is missing or broken')
  const user = home ? await readJson<Layer>($, `${home}/.claude/routing/policy.json`) : undefined
  return merge(base, user, await readJson<Layer>($, await projectFile($)))
}

// <project root>/.claude/routing.json, so a subagent or a shell `cd` elsewhere still finds it; relative if the root is unknown
async function projectFile($: EngineInterface): Promise<string> {
  const root = await $.session.root().catch(() => '')
  return root ? `${root.replace(/\/+$/, '')}/.claude/routing.json` : '.claude/routing.json'
}

// One chain for every row: $.fs has no append, so two hooks must never read-modify-write the file at once.
let tail: Promise<void> = Promise.resolve()

function logRow($: EngineInterface, row: object): Promise<void> {
  tail = tail
    .then(async () => {
      const path = logPath((await $.env.get('HOME')) ?? '', new Date(), await $.session.id())
      const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      await $.fs.write(path, prev + JSON.stringify(row) + '\n')
    })
    .catch(() => {}) // a lost row never fails the call it describes
  return tail
}

// workflow agents whose first turn.step has not come yet; a remote agent never steps, so the oldest are dropped
const PENDING_CAP = 500
const pending = new Set<string>()

function awaitFirstStep(agentId: string) {
  pending.add(agentId)
  for (const id of pending) {
    if (pending.size <= PENDING_CAP) break
    pending.delete(id)
  }
}

// an allowed Agent call's class, model and effort, kept by tool_use_id until its agent.spawn reads them:
// AgentSpawnInput has no effort, so the spawn learns it here
const BUDGET_CAP = 200
const budgets = new Map<string, Budget>()

function keepBudget(id: string, b: Budget) {
  budgets.set(id, b)
  for (const k of budgets.keys()) {
    if (budgets.size <= BUDGET_CAP) break
    budgets.delete(k)
  }
}

function takeBudget(id: string): Budget | undefined {
  const b = budgets.get(id)
  budgets.delete(id)
  return b
}

export const register: Register = on => {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // only the model's own calls are held to the table; another plugin's programmatic call passes
    if (next.origin.plugin !== 'engine') return next(e)
    const p = await loadPolicy($)
    const v = check(p, e)
    const row = { ts: new Date().toISOString(), surface: 'agent', cls: v.cls, model: e.model, effort: e.effort, subagentType: e.subagent_type, label: e.description }
    if (!v.ok) {
      await logRow($, { ...row, verdict: 'deny', reason: v.reason })
      return { deny: denyText(p, v.reason) }
    }
    if (!v.exempt) keepBudget(e.tool_use_id, { cls: v.cls, model: e.model, effort: e.effort })
    const ran = await next(e).finally(() => budgets.delete(e.tool_use_id)) // the spawn has run by now, or never will
    await logRow($, { ...row, override: v.override, verdict: v.exempt ? 'exempt' : 'allow', outcome: ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok' })
    return ran
  }).catch(($, e, next) => next(e)) // fail open: routing is cost and quality, not security

  // every new non-fork agent (subagent, teammate, workflow agent) is told its class, budget and the floors:
  // prompt.compose never shapes a subagent's system prompt, so its task prompt is the only place to say it
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.resume) return next(e)
    const p = await loadPolicy($)
    if (!e.workflow) {
      const b = takeBudget(e.tool_use_id)
      const header = agentHeader(p, { cls: b?.cls ?? classOf(e.description), model: e.model ?? b?.model, effort: b?.effort })
      return next({ ...e, prompt: `${header}\n\n${e.prompt}` })
    }
    const model = e.model ?? p.workflowModel
    // a run that keeps its script out of SDK events has a placeholder prompt; the engine ignores the rewrite there
    const header = agentHeader(p, { cls: classOf(e.description), model })
    const r = await next({ ...e, model, prompt: `${header}\n\n${e.prompt}` })
    const row = { ts: new Date().toISOString(), surface: 'workflow', runId: e.workflow.runId, agentIndex: e.workflow.agentIndex, label: e.description, model }
    if (r.deny !== undefined) await logRow($, { ...row, verdict: 'deny', reason: r.deny })
    else {
      await logRow($, { ...row, agentId: r.agentId, verdict: e.model ? 'allow' : 'filled' })
      if (r.agentId) awaitFirstStep(r.agentId)
    }
    return r
  }).catch(($, e, next) => next(e))

  // an agent's first request is the first place its real effort shows: a second row, keyed by agentId
  on('turn.step', async function* ($, e, next) {
    if (e.agentId && pending.delete(e.agentId)) await logRow($, { ts: new Date().toISOString(), surface: 'workflow', agentId: e.agentId, verdict: 'effort', effort: e.effort })
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes('Agent') && !e.tools.includes('Workflow')) return r
    return { ...r, sections: [...r.sections, { id: 'routing:policy', text: ruleText(await loadPolicy($)), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))
}
