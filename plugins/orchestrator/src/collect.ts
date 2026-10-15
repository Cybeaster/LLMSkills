import type { Ctx } from './ctx.js'
import { checkKey, type Check } from './evidence.js'
import { buildOverview, type Row } from './overview.js'
import { listPools } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

// Whose CI and PR evidence gh is asked about: nobody's (the default), every live session's pool,
// or exactly these sessions' pools. gh is slow, so a caller asks only for the pools it shows.
export type CollectOpts = { checks?: 'none' | 'live' | ReadonlySet<string> }

export async function collect(ctx: Ctx, opts: CollectOpts = {}): Promise<Row[]> {
  const which = opts.checks ?? 'none'
  const pools = listPools(ctx.orchHome)
  const live = readLiveSessions(ctx.claudeHome, ctx.isAlive)
  const liveIds = new Set(live.map(s => s.sessionId))
  const wanted = (id: string) => (which === 'none' ? false : which === 'live' ? liveIds.has(id) : which.has(id))
  const checks = new Map<string, Check>()
  // herdr and every check run at once; a herdr that is down only costs the herdr tag
  const [agents] = await Promise.all([
    (async () => ctx.herdr.list())().catch(() => null),
    ...pools
      .filter(e => wanted(e.id))
      .flatMap(e =>
        (e.pool?.tasks ?? [])
          .filter(t => t.status === 'done' && (t.evidence?.kind === 'ci' || t.evidence?.kind === 'pr'))
          .map(async t => checks.set(checkKey(t.evidence!, e.pool!.cwd ?? ''), await ctx.gh.check(t.evidence!, e.pool!.cwd))),
      ),
  ])
  return buildOverview({ pools, live, agents, checks, now: ctx.now() })
}
