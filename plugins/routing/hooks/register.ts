import type { EngineInterface, Register } from 'claude-code'
import { check, denyText, merge, ruleText, type Layer, type Policy } from './policy.ts'
import { logPath, makeLogger } from './log.ts'

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
  return merge(base, user, await readJson<Layer>($, '.claude/routing.json'))
}

// One chain for every row: $.fs has no append, so two hooks must never read-modify-write the file at once.
let tail: Promise<void> = Promise.resolve()

function logRow($: EngineInterface, row: object): Promise<void> {
  const fs = {
    exists: (p: string) => $.fs.exists(p),
    read: (p: string) => $.fs.read(p),
    write: (p: string, t: string) => $.fs.write(p, t),
  }
  const path = async () => logPath((await $.env.get('HOME')) ?? '', new Date(), await $.session.id())
  tail = tail.then(() => makeLogger(fs, path)(row))
  return tail
}

export const register: Register = on => {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const p = await loadPolicy($)
    const v = check(p, e)
    const row = { ts: new Date().toISOString(), surface: 'agent', cls: v.cls, model: e.model, effort: e.effort, subagentType: e.subagent_type, label: e.description }
    if (!v.ok) {
      await logRow($, { ...row, verdict: 'deny', reason: v.reason })
      return { deny: denyText(p, v.reason) }
    }
    const ran = await next(e)
    await logRow($, { ...row, override: v.override, verdict: v.exempt ? 'exempt' : 'allow', outcome: ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok' })
    return ran
  }).catch(($, e, next) => next(e)) // fail open: routing is cost and quality, not security

  // a workflow agent's first request is the first place its real effort shows
  const pending = new Map<string, object>()

  on('agent.spawn', async ($, e, next) => {
    if (!e.workflow || e.resume) return next(e)
    const p = await loadPolicy($)
    const model = e.model ?? p.workflowModel
    const r = await next({ ...e, model })
    const row = { ts: new Date().toISOString(), surface: 'workflow', runId: e.workflow.runId, agentIndex: e.workflow.agentIndex, label: e.description, model, verdict: e.model ? 'allow' : 'filled' }
    if (r.deny !== undefined) await logRow($, { ...row, verdict: 'deny', reason: r.deny })
    else if (r.agentId) pending.set(r.agentId, row)
    else await logRow($, row) // a remote agent has no local loop, so no turn.step will name it
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const row = e.agentId ? pending.get(e.agentId) : undefined
    if (row && e.agentId) {
      pending.delete(e.agentId)
      await logRow($, { ...row, effort: e.effort })
    }
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
