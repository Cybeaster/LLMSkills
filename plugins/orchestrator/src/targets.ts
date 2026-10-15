import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { flatten } from './format.js'
import type { Row } from './overview.js'
import { readPool } from './store.js'

export class NoMatch extends OrchError {}

const live = (r: Row) => r.state !== 'ended'

// Several matches are narrowed to the live ones before they count as ambiguous.
const narrow = (rows: Row[]): Row[] => {
  const l = rows.filter(live)
  return rows.length > 1 && l.length ? l : rows
}

export function resolveTarget(rows: Row[], query: string): Row {
  const all = flatten(rows).map(l => l.row)
  const exact = narrow(all.filter(r => r.sessionId === query || r.name === query))
  const matches = exact.length ? exact : narrow(all.filter(r => (query.length >= 6 && r.sessionId.startsWith(query)) || r.title === query))
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new NoMatch(`no session matches "${query}"`)
  throw new OrchError(`"${query}" matches several sessions: ${matches.map(r => `${r.name} (${r.sessionId.slice(0, 8)})`).join(', ')}`)
}

export type Resolved = { sessionId: string; name: string }

// resolveTarget, plus: a session id that has a pool on disk but no overview row, and (child only)
// a herdr agent by name, whose session id herdr may or may not report yet.
export async function resolveSession(ctx: Ctx, rows: Row[], query: string, opts: { herdr?: boolean } = {}): Promise<Resolved> {
  try {
    const r = resolveTarget(rows, query)
    return { sessionId: r.sessionId, name: r.name }
  } catch (e) {
    if (!(e instanceof NoMatch)) throw e
    let pool
    try {
      pool = readPool(ctx.orchHome, query)
    } catch {
      // not a usable id or an unreadable pool: not a match
    }
    if (pool) return { sessionId: query, name: pool.title || query }
    if (opts.herdr) {
      const agent = await ctx.herdr.list().then(
        l => l.find(a => a.name === query),
        () => undefined,
      )
      if (agent?.sessionId) return { sessionId: agent.sessionId, name: query }
      if (agent) throw new OrchError(`that session has no id yet; run orch status --all and link by its id`)
    }
    throw e
  }
}
