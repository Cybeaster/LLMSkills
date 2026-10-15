import { OrchError } from './errors.js'
import { flatten } from './format.js'
import type { Row } from './overview.js'

export function resolveTarget(rows: Row[], query: string): Row {
  const all = flatten(rows).map(l => l.row)
  const exact = all.filter(r => r.sessionId === query || r.name === query)
  const matches = exact.length ? exact : all.filter(r => (query.length >= 6 && r.sessionId.startsWith(query)) || r.title === query)
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new OrchError(`no session matches "${query}"`)
  throw new OrchError(`"${query}" matches several sessions: ${matches.map(r => `${r.name} (${r.sessionId.slice(0, 8)})`).join(', ')}`)
}
