import { OrchError } from './errors.js'

export type Status = 'pending' | 'in_progress' | 'done' | 'blocked'

export type Evidence =
  | { kind: 'commit' | 'pr' | 'ci' | 'note'; ref: string }
  | { kind: 'cmd'; ref: string; exit: number }

export type Task = {
  id: string
  text: string
  status: Status
  blockedReason?: string
  evidence?: Evidence
  children?: string[]
  needsInput?: string
}

export type ParentLink = { sessionId: string; taskId: string }

export type Pool = {
  sessionId: string
  title: string
  cwd: string
  parent?: ParentLink
  brief?: string
  tasks: Task[]
  seq: number
  createdAt: number
  updatedAt: number
  touchedAt?: number
  turnStartedAt?: number
}

export function newPool(sessionId: string, cwd: string, now: number): Pool {
  return { sessionId, title: '', cwd, tasks: [], seq: 0, createdAt: now, updatedAt: now }
}

const clone = (p: Pool): Pool => structuredClone(p)

function find(p: Pool, id: string): Task {
  const t = p.tasks.find(t => t.id === id)
  if (!t) throw new OrchError(`no task ${id} in this pool (have: ${p.tasks.map(t => t.id).join(', ') || 'none'})`)
  return t
}

// A write by the session itself through the CLI: it keeps the pool current.
function own(p: Pool, now: number): Pool {
  p.updatedAt = now
  p.touchedAt = now
  return p
}

export function plan(pool: Pool, texts: string[], now: number): Pool {
  const p = clone(pool)
  const kept = p.tasks.filter(t => t.status !== 'pending' || t.children?.length || t.needsInput)
  p.tasks = [...kept, ...texts.map(text => ({ id: `t${++p.seq}`, text, status: 'pending' as const }))]
  return own(p, now)
}

export function addTask(pool: Pool, text: string, now: number): Pool {
  const p = clone(pool)
  p.tasks.push({ id: `t${++p.seq}`, text, status: 'pending' })
  return own(p, now)
}

export function setTitle(pool: Pool, title: string, now: number): Pool {
  const p = clone(pool)
  p.title = title
  return own(p, now)
}

export function startTask(pool: Pool, id: string, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'in_progress'
  delete t.blockedReason
  return own(p, now)
}

export function blockTask(pool: Pool, id: string, reason: string, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'blocked'
  t.blockedReason = reason
  return own(p, now)
}

export function doneTask(pool: Pool, id: string, evidence: Evidence | undefined, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'done'
  delete t.blockedReason
  if (evidence) t.evidence = evidence
  else delete t.evidence
  return own(p, now)
}

export function askTask(pool: Pool, id: string, question: string, now: number): Pool {
  const p = clone(pool)
  find(p, id).needsInput = question
  return own(p, now)
}

// Not an own write: the person answered, the session did not touch its pool.
export function clearQuestions(pool: Pool, now: number, taskId?: string): Pool | undefined {
  if (!pool.tasks.some(t => t.needsInput && (!taskId || t.id === taskId))) return undefined
  const p = clone(pool)
  for (const t of p.tasks) if (!taskId || t.id === taskId) delete t.needsInput
  p.updatedAt = now
  return p
}

export function setParent(pool: Pool, parent: ParentLink, brief: string | undefined, now: number): Pool {
  const p = clone(pool)
  p.parent = parent
  if (brief) p.brief = brief
  p.updatedAt = now
  return p
}

export function linkChild(pool: Pool, taskId: string, childId: string, now: number): Pool {
  const p = clone(pool)
  const t = find(p, taskId)
  t.children = [...new Set([...(t.children ?? []), childId])]
  if (t.status === 'pending') t.status = 'in_progress'
  p.updatedAt = now
  return p
}

export function unlinkChild(pool: Pool, taskId: string, childId: string, now: number): Pool {
  const p = clone(pool)
  const t = p.tasks.find(t => t.id === taskId)
  if (t?.children) {
    t.children = t.children.filter(c => c !== childId)
    if (!t.children.length) delete t.children
  }
  p.updatedAt = now
  return p
}
