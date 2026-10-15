import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { checkKey, type Check } from '../evidence.js'
import type { Evidence } from '../model.js'

export interface Gh {
  check(ev: Evidence, cwd: string): Promise<Check>
}

export type GhRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>

const runGh: GhRun = (args, cwd) =>
  new Promise(resolve => {
    execFile('gh', args, { cwd, timeout: 20_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout) }))
  })

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

const ANSWER_TTL_MS = 60_000
const UNKNOWN_TTL_MS = 15_000

async function ciCheck(run: GhRun, ref: string, cwd: string): Promise<Check> {
  const m = ref.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/)
  const args = m ? ['run', 'view', m[2], '-R', m[1], '--json', 'status,conclusion'] : ['run', 'view', ref, '--json', 'status,conclusion']
  const r = await run(args, cwd)
  if (r.code !== 0) return 'unknown'
  const o = JSON.parse(r.stdout)
  if (o.status !== 'completed') return 'pending'
  const c = String(o.conclusion ?? '').toUpperCase()
  return PASSED.includes(c) ? 'pass' : FAILED.includes(c) ? 'fail' : 'unknown'
}

async function prCheck(run: GhRun, ref: string, cwd: string): Promise<Check> {
  const r = await run(['pr', 'view', ref, '--json', 'state,statusCheckRollup'], cwd)
  if (r.code !== 0) return 'unknown'
  const o = JSON.parse(r.stdout)
  if (o.state === 'MERGED') return 'pass'
  if (o.state === 'CLOSED') return 'fail'
  const states: string[] = (o.statusCheckRollup ?? []).map((c: { conclusion?: string; state?: string }) => c.conclusion || c.state || '')
  if (states.some(s => FAILED.includes(s))) return 'fail'
  if (states.length && states.every(s => PASSED.includes(s))) return 'pass'
  return 'pending'
}

// A finished child's worktree is deleted, and gh must never fall back to orch's own cwd:
// a URL names its repo, so it runs from the temp dir; a bare number means nothing without its repo.
function runDir(ref: string, cwd: string): string | undefined {
  if (cwd && existsSync(cwd)) return cwd
  return /^https?:\/\//i.test(ref) ? tmpdir() : undefined
}

async function ask(run: GhRun, ev: Evidence, cwd: string): Promise<Check> {
  const dir = runDir(ev.ref, cwd)
  if (dir === undefined) return 'unknown'
  return ev.kind === 'ci' ? ciCheck(run, ev.ref, dir) : prCheck(run, ev.ref, dir)
}

type Entry = { promise: Promise<Check>; value?: Check; arrivedAt?: number }

export function cliGh(run: GhRun = runGh, now: () => number = Date.now): Gh {
  // the promise is cached, not the answer, so two checks of one key while gh runs spawn it once
  const cache = new Map<string, Entry>()
  return {
    async check(ev, cwd) {
      if (ev.kind !== 'ci' && ev.kind !== 'pr') return 'unknown'
      const key = checkKey(ev, cwd)
      const hit = cache.get(key)
      if (hit && (hit.arrivedAt === undefined || now() - hit.arrivedAt < (hit.value === 'unknown' ? UNKNOWN_TTL_MS : ANSWER_TTL_MS))) {
        return hit.promise
      }
      const entry: Entry = {
        promise: ask(run, ev, cwd)
          .catch((): Check => 'unknown')
          .then(value => {
            entry.value = value
            entry.arrivedAt = now()
            return value
          }),
      }
      cache.set(key, entry)
      return entry.promise
    },
  }
}
