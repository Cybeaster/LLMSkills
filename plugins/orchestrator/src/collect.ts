import type { Ctx } from './ctx.js'
import { checkKey, type Check } from './evidence.js'
import { buildOverview, type Row } from './overview.js'
import { listPools } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

export async function collect(ctx: Ctx): Promise<Row[]> {
  const pools = listPools(ctx.orchHome)
  const live = readLiveSessions(ctx.claudeHome, ctx.isAlive)
  const agents = await ctx.herdr.list().catch(() => null)
  const checks = new Map<string, Check>()
  await Promise.all(
    pools.flatMap(e =>
      (e.pool?.tasks ?? [])
        .filter(t => t.status === 'done' && (t.evidence?.kind === 'ci' || t.evidence?.kind === 'pr'))
        .map(async t => checks.set(checkKey(t.evidence!, e.pool!.cwd ?? ''), await ctx.gh.check(t.evidence!, e.pool!.cwd))),
    ),
  )
  return buildOverview({ pools, live, agents, checks, now: ctx.now() })
}
