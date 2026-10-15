import { existsSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './ctx.js'
import { DAY } from './overview.js'
import type { Pool } from './model.js'
import { readLiveSessions } from './sources/sessions.js'
import { listPools, poolPath, readPool, withLock } from './store.js'

const MAX_AGE_MS = 7 * DAY
const EVERY_MS = 60 * 60 * 1000
const LOCK_WAIT_MS = 200

const referencedIds = (ctx: Ctx): Set<string> => {
  const ids = new Set<string>()
  for (const e of listPools(ctx.orchHome)) {
    if (e.pool?.parent) ids.add(e.pool.parent.sessionId)
    for (const t of e.pool?.tasks ?? []) for (const c of t.children ?? []) ids.add(c)
  }
  return ids
}

// Not worth keeping: no tasks, no links, untouched for a week. Used for the scan and again under the lock.
const stale = (pool: Pool | undefined, now: number): pool is Pool =>
  !!pool && !pool.tasks.length && !pool.parent && now - Math.max(pool.updatedAt, pool.touchedAt ?? 0) >= MAX_AGE_MS

const alive = (ctx: Ctx, id: string) => readLiveSessions(ctx.claudeHome, ctx.isAlive).some(s => s.sessionId === id)

// Deletes the pool files of sessions that ended a week ago without ever planning anything. A pool with tasks,
// a live session, and anything that is named as a parent or listed as a child is kept. At most once an hour,
// tracked by the mtime of $ORCH_HOME/.pruned (set from ctx.now, so a test clock works). Returns the ids removed.
// The scan is only a shortlist: each candidate is locked, read again and judged again before it is unlinked,
// so a session that wrote a task meanwhile keeps its pool. A held lock means the pool is in use: skipped.
export async function pruneEmptyPools(ctx: Ctx, keep: string): Promise<string[]> {
  const marker = join(ctx.orchHome, '.pruned')
  const now = ctx.now()
  if (existsSync(marker) && now - statSync(marker).mtimeMs < EVERY_MS) return []
  writeFileSync(marker, '')
  utimesSync(marker, now / 1000, now / 1000)

  const pools = listPools(ctx.orchHome)
  const live = new Set(readLiveSessions(ctx.claudeHome, ctx.isAlive).map(s => s.sessionId))
  const referenced = referencedIds(ctx)
  const removed: string[] = []
  for (const { id, pool } of pools) {
    if (id === keep || live.has(id) || referenced.has(id) || !stale(pool, now)) continue
    try {
      await withLock(
        ctx.orchHome,
        id,
        () => {
          if (!stale(readPool(ctx.orchHome, id), now) || alive(ctx, id) || referencedIds(ctx).has(id)) return
          unlinkSync(poolPath(ctx.orchHome, id))
          removed.push(id)
        },
        LOCK_WAIT_MS,
      )
    } catch {
      // locked, gone already or unreadable: leave it
    }
  }
  return removed
}
