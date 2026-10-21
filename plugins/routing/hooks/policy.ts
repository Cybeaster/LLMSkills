export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Floor = { model: string; effort: string; what?: string }
export type Policy = { classes: Record<string, Floor>; spawn: Floor; workflowModel: string }
export type Layer = { classes?: Record<string, Partial<Floor>>; spawn?: Partial<Floor>; workflowModel?: string }
export type Call = { description?: string; model?: string; effort?: string; subagent_type?: string }
export type Verdict =
  | { ok: true; cls?: string; override: boolean; exempt?: true }
  | { ok: false; cls?: string; reason: string }

const TAG = /^\s*\[([a-z]+)\]/
const OVERRIDE = /\[override\]/

// 'claude-opus-5-5' and 'fable[1m]' rank as 'opus' and 'fable'; -1 is missing or unknown
export function rank(ladder: readonly string[], v: string | undefined): number {
  if (!v) return -1
  return ladder.indexOf(v.toLowerCase().replace(/^claude-/, '').split(/[-[]/)[0])
}

export function merge(base: Policy, ...layers: (Layer | undefined)[]): Policy {
  let p = base
  for (const l of layers) {
    if (!l) continue
    const classes = { ...p.classes }
    for (const [k, v] of Object.entries(l.classes ?? {})) classes[k] = { ...classes[k], ...v } as Floor
    p = { classes, spawn: { ...p.spawn, ...l.spawn }, workflowModel: l.workflowModel ?? p.workflowModel }
  }
  return p
}

export function check(p: Policy, c: Call): Verdict {
  if (c.subagent_type === 'fork') return { ok: true, override: false, exempt: true }
  const desc = c.description ?? ''
  const cls = TAG.exec(desc)?.[1]
  if (!cls) return { ok: false, reason: 'description has no [class] tag' }
  const f = p.classes[cls]
  if (!f) return { ok: false, cls, reason: `[${cls}] is not a class` }
  const m = rank(MODELS, c.model)
  const e = rank(EFFORTS, c.effort)
  if (m < 0) return { ok: false, cls, reason: `model is ${c.model ? `unknown (${c.model})` : 'missing'}` }
  if (e < 0) return { ok: false, cls, reason: `effort is ${c.effort ? `unknown (${c.effort})` : 'missing'}` }
  if (OVERRIDE.test(desc)) return { ok: true, cls, override: true }
  if (m < rank(MODELS, f.model)) return { ok: false, cls, reason: `[${cls}] needs model ${f.model} or stronger, got ${c.model}` }
  if (e < rank(EFFORTS, f.effort)) return { ok: false, cls, reason: `[${cls}] needs effort ${f.effort} or higher, got ${c.effort}` }
  if (c.effort === 'max') return { ok: false, cls, reason: 'effort max needs [override]: use it only when the user asked for max' }
  return { ok: true, cls, override: false }
}
