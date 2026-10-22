export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Floor = { model: string; effort: string; what?: string }
export type Policy = { classes: Record<string, Floor>; spawn: Floor; workflowModel: string }
export type Layer = { classes?: Record<string, Partial<Floor>>; spawn?: Partial<Floor>; workflowModel?: string }
export type Call = { description?: string; model?: string; effort?: string; subagent_type?: string }
export type Verdict =
  | { ok: true; cls?: string; override: boolean; exempt?: true }
  | { ok: false; cls?: string; reason: string }

// the first [word] that opens the description; only one [override] may precede it
const TAG = /^\s*(?:\[override\]\s*)?\[(?!override\])([a-z]+)\]/i
const OVERRIDE = /\[override\]/i

// 'claude-opus-5-5' and 'fable[1m]' rank as 'opus' and 'fable'; -1 is missing or unknown
export function rank(ladder: readonly string[], v: string | undefined): number {
  if (!v) return -1
  return ladder.indexOf(v.toLowerCase().replace(/^claude-/, '').split(/[-[]/)[0] ?? '')
}

const valid = (ladder: readonly string[], v: unknown): v is string => typeof v === 'string' && rank(ladder, v) >= 0

// a layer field with an unknown model or effort keeps the value below it; a new class with one is dropped
export function merge(base: Policy, ...layers: (Layer | undefined)[]): Policy {
  let p = base
  for (const l of layers) {
    if (!l) continue
    const classes = { ...p.classes }
    for (const [k, v] of Object.entries(l.classes ?? {})) {
      const prev = Object.hasOwn(p.classes, k) ? p.classes[k] : undefined
      const next = { ...prev, ...v }
      if (!valid(MODELS, next.model)) next.model = prev?.model
      if (!valid(EFFORTS, next.effort)) next.effort = prev?.effort
      if (valid(MODELS, next.model) && valid(EFFORTS, next.effort)) classes[k] = next as Floor
      else delete classes[k]
    }
    const spawn = { ...p.spawn, ...l.spawn }
    if (!valid(MODELS, spawn.model)) spawn.model = p.spawn.model
    if (!valid(EFFORTS, spawn.effort)) spawn.effort = p.spawn.effort
    p = { classes, spawn, workflowModel: valid(MODELS, l.workflowModel) ? l.workflowModel : p.workflowModel }
  }
  return p
}

// the class a description is tagged with, lower-cased; undefined when no tag opens it
export function classOf(description: string | undefined): string | undefined {
  return TAG.exec(description ?? '')?.[1]?.toLowerCase()
}

export function check(p: Policy, c: Call): Verdict {
  if (c.subagent_type === 'fork') return { ok: true, override: false, exempt: true }
  const desc = c.description ?? ''
  const cls = classOf(desc)
  if (!cls) return { ok: false, reason: 'description has no [class] tag' }
  const f = Object.hasOwn(p.classes, cls) ? p.classes[cls] : undefined
  if (!f) return { ok: false, cls, reason: `[${cls}] is not a class` }
  const m = rank(MODELS, c.model)
  const e = rank(EFFORTS, c.effort)
  if (m < 0) return { ok: false, cls, reason: `model is ${c.model ? `unknown (${c.model})` : 'missing'}` }
  if (e < 0) return { ok: false, cls, reason: `effort is ${c.effort ? `unknown (${c.effort})` : 'missing'}` }
  if (OVERRIDE.test(desc)) return { ok: true, cls, override: true }
  if (m < rank(MODELS, f.model)) return { ok: false, cls, reason: `[${cls}] needs model ${f.model} or stronger, got ${c.model}` }
  if (e < rank(EFFORTS, f.effort)) return { ok: false, cls, reason: `[${cls}] needs effort ${f.effort} or higher, got ${c.effort}` }
  if (e === EFFORTS.indexOf('max')) return { ok: false, cls, reason: 'effort max needs [override]: use it only when the user asked for max' }
  return { ok: true, cls, override: false }
}

export function table(p: Policy): string {
  const rows = Object.entries(p.classes).map(([k, f]) => `| \`[${k}]\` | ${f.model} | ${f.effort} | ${f.what ?? ''} |`)
  return ['| Tag | Model (min) | Effort (min) | For |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

export function ruleText(p: Policy): string {
  return [
    '# Delegation routing',
    'This is the explicit instruction the Agent tool\'s `effort` parameter asks for: every delegation names its model and effort from this table.',
    '- **Agent tool:** start `description` with one class tag, then pass `model` and `effort` at or above that class\'s minimum. Stronger is always allowed; weaker is denied. `subagent_type: "fork"` is exempt.',
    table(p),
    `- **Workflow scripts:** every \`agent()\` call passes \`opts.model\` and \`opts.effort\` from the same table (a missing model becomes ${p.workflowModel}).`,
    `- **Spawned sessions** (\`orch spawn-child\`, herdr): ${p.spawn.model} / ${p.spawn.effort} unless the user names a model. orch applies it; for a bare herdr start pass \`-- --model ${p.spawn.model} --effort ${p.spawn.effort}\`.`,
    '- **[override]** just before or after the tag lets a call go below its minimum or use `max`. Add it only when the user explicitly asked for that model or effort; it is logged.',
    '- **Escalation:** when a delegated result fails verification (tests red, reviewer rejects), retry once one step up in model or effort, never past fable / xhigh unless the user asks.',
  ].join('\n')
}

export function denyText(p: Policy, reason: string): string {
  return `routing: ${reason}. Retry with a class tag at the start of \`description\` and \`model\` + \`effort\` at or above its minimum:\n${table(p)}`
}

// what a subagent is told about itself; `cls` counts only when the policy has it
export type Budget = { cls?: string; model?: string; effort?: string }

// the floors on one line: `search haiku/low · mechanical haiku/medium · ...`
export function floors(p: Policy): string {
  return Object.entries(p.classes).map(([k, f]) => `${k} ${f.model}/${f.effort}`).join(' · ')
}

// the header put before a subagent's task prompt: its own class and budget, then the delegation floors
export function agentHeader(p: Policy, b: Budget): string {
  const cls = b.cls && Object.hasOwn(p.classes, b.cls) ? `[${b.cls}]` : 'unclassified'
  const effort = b.effort ? ` at effort ${b.effort}` : ''
  return [
    `[routing] Requested as ${cls} on ${b.model ?? 'inherited'}${effort}. Size the work to that budget.`,
    'If you delegate (Agent tool / workflow agent()), follow these floors — tag the description with one class and pass model + effort at or above it:',
    floors(p),
  ].join('\n')
}
