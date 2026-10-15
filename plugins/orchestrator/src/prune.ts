import { existsSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './ctx.js'
import { DAY } from './overview.js'
import { readLiveSessions } from './sources/sessions.js'
import { listPools, poolPath } from './store.js'

const MAX_AGE_MS = 7 * DAY
const EVERY_MS = 60 * 60 * 1000

// Deletes the pool files of sessions that ended a week ago without ever planning anything. A pool with tasks,
// a live session, and anything that is named as a parent or listed as a child is kept. At most once an hour,
// tracked by the mtime of $ORCH_HOME/.pruned (set from ctx.now, so a test clock works). Returns the ids removed.
export function pruneEmptyPools(ctx: Ctx, keep: string): string[] {
  const marker = join(ctx.orchHome, '.pruned')
  const now = ctx.now()
  if (existsSync(marker) && now - statSync(marker).mtimeMs < EVERY_MS) return []
  writeFileSync(marker, '')
  utimesSync(marker, now / 1000, now / 1000)

  const pools = listPools(ctx.orchHome)
  const alive = new Set(readLiveSessions(ctx.claudeHome, ctx.isAlive).map(s => s.sessionId))
  const referenced = new Set<string>()
  for (const e of pools) {
    if (e.pool?.parent) referenced.add(e.pool.parent.sessionId)
    for (const t of e.pool?.tasks ?? []) for (const c of t.children ?? []) referenced.add(c)
  }
  const removed: string[] = []
  for (const { id, pool } of pools) {
    if (!pool || id === keep || alive.has(id) || referenced.has(id) || pool.parent || pool.tasks.length) continue
    if (now - Math.max(pool.updatedAt, pool.touchedAt ?? 0) < MAX_AGE_MS) continue
    try {
      unlinkSync(poolPath(ctx.orchHome, id))
      removed.push(id)
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed
}
