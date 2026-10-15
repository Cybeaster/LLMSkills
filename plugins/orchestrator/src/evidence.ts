import { OrchError } from './errors.js'
import type { Evidence } from './model.js'

type Kind = Evidence['kind']

export type Check = 'pass' | 'fail' | 'pending' | 'unknown'
export type Grade = 'proven' | 'claimed' | 'contradicted' | 'unverified'
// cmd evidence gets its exit code from orch running the command, so the parsed form has none
export type ParsedEvidence = Exclude<Evidence, { kind: 'cmd' }> | { kind: 'cmd'; ref: string }

const KINDS: readonly Kind[] = ['commit', 'pr', 'ci', 'cmd', 'note']
const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k)
const USAGE = 'use commit:<sha> | pr:<number|url> | ci:<run-url> | cmd:<command> | note:<text>'
const SHA = /^[0-9a-f]{4,64}$/i

export function parseEvidence(s: string): ParsedEvidence {
  const i = s.indexOf(':')
  const kind = s.slice(0, i)
  const ref = s.slice(i + 1).trim()
  if (i < 1 || !isKind(kind) || !ref) throw new OrchError(`bad evidence "${s}": ${USAGE}`, 2)
  if (kind === 'commit' && !SHA.test(ref)) {
    throw new OrchError(`bad evidence "${s}": commit needs a sha, e.g. commit:$(git rev-parse --short HEAD)`, 2)
  }
  return { kind, ref }
}

export function grade(ev: Evidence | undefined, check?: Check): Grade {
  if (!ev || ev.kind === 'note') return 'claimed'
  if (ev.kind === 'commit') return 'proven'
  if (ev.kind === 'cmd') return ev.exit === 0 ? 'proven' : 'contradicted'
  if (check === 'pass') return 'proven'
  if (check === 'fail') return 'contradicted'
  return 'unverified'
}

// Text a session wrote, folded onto one line with control characters (ESC, BEL, newlines) gone, so it
// cannot move the cursor or retitle the terminal when it is printed.
export const oneLine = (s: unknown): string => String(s ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim()

export function describeEvidence(ev: Evidence): string {
  const ref = oneLine(ev.ref)
  switch (ev.kind) {
    case 'commit':
      return `commit ${ref.slice(0, 7)}`
    case 'cmd':
      return `cmd ${ref} (exit ${String(ev.exit)})`
    case 'note':
      return `note: ${ref}`
    default:
      return `${ev.kind} ${ref}`
  }
}

// gh resolves a bare PR or run number against the repo in cwd, so the same ref in two repos is two checks
export const checkKey = (ev: Evidence, cwd: string) => `${cwd}\0${ev.kind}:${ev.ref}`
