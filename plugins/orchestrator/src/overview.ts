import { checkKey, describeEvidence, grade, oneLine, type Check } from './evidence.js'
import type { Status, Task } from './model.js'
import type { PoolEntry } from './store.js'
import type { HerdrAgent } from './sources/herdr.js'
import { clip } from './width.js'
import { sessionLink, type LiveSession } from './sources/sessions.js'

export const DAY = 24 * 60 * 60 * 1000

// Evidence text is clipped (by display width) to keep a pool row on one line; the live verdict is appended
// after clipping so it always shows. A question or a blocked reason is never clipped: /orch needs the whole of it.

export type Mark = '✓' | '~' | '✗' | '?' | '◐' | '·' | '!' | '⚑'
export type TaskView = { id: string; text: string; status: Status; mark: Mark; detail: string }

export type Row = {
  sessionId: string
  name: string
  title: string
  cwd: string
  state: 'busy' | 'idle' | 'waiting' | 'ended'
  waitingFor?: string
  tag: 'herdr' | 'external' | '—'
  paneId?: string
  link?: string
  pid?: number
  hasPool: boolean
  unreadable?: string
  orphan: boolean
  done: number
  total: number
  complete: boolean
  touchedAt: number
  flags: number
  tasks: TaskView[]
  children: Row[]
}

export type OverviewInput = {
  pools: PoolEntry[]
  live: LiveSession[]
  agents: HerdrAgent[] | null // null: herdr is not running
  checks: Map<string, Check>
  now: number
}

function viewTask(t: Task, cwd: string, checks: Map<string, Check>, childDone: (id: string) => boolean): TaskView {
  const kids = t.children ?? []
  const kidsDone = kids.filter(childDone).length
  let status: Status = t.status
  if (kids.length) status = kidsDone === kids.length ? 'done' : t.status === 'done' ? 'in_progress' : t.status

  let mark: Mark
  let detail = kids.length ? `${kids.length} children: ${kidsDone} ✓ ${kids.length - kidsDone} running` : ''
  if (t.needsInput) {
    mark = '⚑'
    detail = `"${oneLine(t.needsInput)}"`
  } else if (status === 'done' && kids.length && !t.evidence) {
    mark = '✓'
  } else if (status === 'done') {
    const g = grade(t.evidence, t.evidence ? checks.get(checkKey(t.evidence, cwd)) : undefined)
    mark = g === 'proven' ? '✓' : g === 'claimed' ? '~' : g === 'contradicted' ? '✗' : '?'
    detail = t.evidence ? clip(describeEvidence(t.evidence), 40) : 'claimed, no evidence'
    if (g === 'contradicted') detail += ' ✗ failing (live)'
    if (g === 'unverified') detail += ' (unverified)'
  } else if (status === 'in_progress') {
    mark = '◐'
  } else if (status === 'blocked') {
    mark = '!'
    detail = oneLine(t.blockedReason) || 'blocked'
  } else {
    mark = '·'
  }
  return { id: t.id, text: oneLine(t.text), status, mark, detail }
}

const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, undefined, { numeric: true })
const byPriority = (a: Row, b: Row) =>
  b.flags - a.flags || Number(a.state === 'ended') - Number(b.state === 'ended') || byName(a, b)

export function buildOverview(input: OverviewInput): Row[] {
  const pools = new Map(input.pools.map(e => [e.id, e]))
  const live = new Map(input.live.map(s => [s.sessionId, s]))
  const agents = new Map((input.agents ?? []).filter(a => a.sessionId).map(a => [a.sessionId!, a]))
  const parentOf = (id: string) => pools.get(id)?.pool?.parent?.sessionId

  // Who is shown: every live session, pools written in the last day, ended children of live
  // parents, and the parent of anything shown.
  const ids = new Set(live.keys())
  // an ended session that never planned, titled, briefed or parented anything, and has no parent, is not worth a row
  const parents = new Set(input.pools.map(e => e.pool?.parent?.sessionId))
  const blank = (id: string) => {
    const p = pools.get(id)?.pool
    return !live.has(id) && !!p && !p.tasks.length && !p.title && !p.parent && !p.brief && !parents.has(id)
  }
  for (const [id, e] of pools) if (e.error || (e.pool && input.now - e.pool.updatedAt < DAY && !blank(id))) ids.add(id)
  for (let grew = true; grew; ) {
    grew = false
    for (const id of pools.keys()) {
      const parent = parentOf(id)
      if (!parent) continue
      if (!ids.has(id) && live.has(parent)) { ids.add(id); grew = true }
      if (ids.has(id) && pools.has(parent) && !ids.has(parent)) { ids.add(parent); grew = true }
    }
  }

  const built = new Map<string, Row>()

  // A session is complete when its pool has tasks and every one is done. A task with children is done
  // exactly when every child session is complete (viewTask applies the same rule), so this never
  // depends on which rows happen to be built first. A session met again while it is being worked out
  // sits on a cycle, which can never finish, and counts as not complete.
  const memo = new Map<string, boolean>()
  const completeWalk = (id: string, visiting: Set<string>): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const tasks = pools.get(id)?.pool?.tasks
    if (!tasks?.length || visiting.has(id)) return false
    visiting.add(id)
    const ok = tasks.every(t => (t.children?.length ? t.children.every(c => completeWalk(c, visiting)) : t.status === 'done'))
    visiting.delete(id)
    memo.set(id, ok)
    return ok
  }
  const isComplete = (id: string) => completeWalk(id, new Set())

  const build = (id: string, path: Set<string>): Row => {
    const inner = new Set(path).add(id)
    const children = [...ids].filter(c => parentOf(c) === id && !inner.has(c)).map(c => build(c, inner)).sort(byName)
    const e = pools.get(id)
    const pool = e?.pool
    const s = live.get(id)
    const a = agents.get(id)
    const tasks = (pool?.tasks ?? []).map(t => viewTask(t, pool?.cwd ?? '', input.checks, isComplete))
    const done = tasks.filter(t => t.status === 'done').length
    const parent = pool?.parent?.sessionId
    const row: Row = {
      sessionId: id,
      name: oneLine(a?.name) || oneLine(s?.name) || oneLine(pool?.title) || oneLine(id.slice(0, 8)),
      title: oneLine(pool?.title) || oneLine(a?.title),
      // a path may hold spaces, so control characters are replaced rather than folded away by oneLine
      cwd: (pool?.cwd || s?.cwd || '').replace(/[\p{Cc}\p{Cf}]/gu, '?'),
      state: s ? (s.waitingFor ? 'waiting' : s.status) : 'ended',
      waitingFor: s?.waitingFor ? oneLine(s.waitingFor) : undefined,
      tag: s ? (a ? 'herdr' : 'external') : '—',
      paneId: a?.paneId,
      link: sessionLink(s),
      pid: s?.pid,
      hasPool: tasks.length > 0,
      unreadable: e?.error === undefined ? undefined : oneLine(e.error),
      orphan: !!parent && !pools.has(parent) && !live.has(parent),
      done,
      total: tasks.length,
      complete: isComplete(id),
      touchedAt: pool?.touchedAt ?? pool?.updatedAt ?? 0,
      flags: (pool?.tasks.filter(t => t.needsInput).length ?? 0) + children.reduce((n, c) => n + c.flags, 0),
      tasks,
      children,
    }
    built.set(id, row)
    return row
  }

  const top = [...ids].filter(id => {
    const p = parentOf(id)
    return !p || !ids.has(p)
  })
  const rows = top.map(id => build(id, new Set()))
  // Whatever is still unbuilt hangs off a parent cycle, which has no top. Walk up from it to a member of
  // the cycle and build from there, so each session shows once, under the cycle, rather than twice.
  for (const id of ids) {
    if (built.has(id)) continue
    let root = id
    for (const seen = new Set<string>(); !seen.has(root); root = parentOf(root) ?? root) seen.add(root)
    rows.push(build(root, new Set()))
  }
  return rows.sort(byPriority)
}
