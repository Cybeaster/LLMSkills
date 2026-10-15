import { OrchError } from './errors.js'
import type { Evidence } from './model.js'

export type Check = 'pass' | 'fail' | 'pending' | 'unknown'
export type Grade = 'proven' | 'claimed' | 'contradicted' | 'unverified'
export type ParsedEvidence = { kind: 'commit' | 'pr' | 'ci' | 'note'; ref: string } | { kind: 'cmd'; ref: string }

const KINDS = ['commit', 'pr', 'ci', 'cmd', 'note']
const USAGE = 'use commit:<sha> | pr:<number|url> | ci:<run-url> | cmd:<command> | note:<text>'

export function parseEvidence(s: string): ParsedEvidence {
  const i = s.indexOf(':')
  const kind = s.slice(0, i)
  const ref = s.slice(i + 1).trim()
  if (i < 1 || !KINDS.includes(kind) || !ref) throw new OrchError(`bad evidence "${s}": ${USAGE}`, 2)
  return { kind, ref } as ParsedEvidence
}

export function grade(ev: Evidence | undefined, check?: Check): Grade {
  if (!ev || ev.kind === 'note') return 'claimed'
  if (ev.kind === 'commit' || ev.kind === 'cmd') return 'proven'
  if (check === 'pass') return 'proven'
  if (check === 'fail') return 'contradicted'
  return 'unverified'
}

export function describe(ev: Evidence): string {
  switch (ev.kind) {
    case 'commit':
      return `commit ${ev.ref.slice(0, 7)}`
    case 'cmd':
      return `cmd ${ev.ref} (exit ${ev.exit})`
    case 'note':
      return `note: ${ev.ref}`
    default:
      return `${ev.kind} ${ev.ref}`
  }
}

export const checkKey = (ev: Evidence) => `${ev.kind}:${ev.ref}`
