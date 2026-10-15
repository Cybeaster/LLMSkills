import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { checkKey, type Check } from '../evidence.js'
import type { Evidence } from '../model.js'

export type CheckOpts = {
  // Answer from the last known verdict at once ('unknown' for a key never asked) and refresh in the background.
  // For a display that polls. A verdict someone acts on (orch task done --evidence ci:…) leaves this off and waits.
  stale?: boolean
}

export interface Gh {
  check(ev: Evidence, cwd: string, opts?: CheckOpts): Promise<Check>
}

export type GhRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>

const runGh: GhRun = (args, cwd) =>
  new Promise(resolve => {
    execFile('gh', args, { cwd, timeout: 20_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout) }))
  })

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

// final: the state cannot change any more (a passed run, a merged or closed PR), so it is never asked again
type Answer = { value: Check; final: boolean }
const MAX_GH = 4
const ANSWER_TTL_MS = 60_000
const UNKNOWN_TTL_MS = 15_000

async function ciCheck(run: GhRun, ref: string, cwd: string): Promise<Answer> {
  const m = ref.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/)
  const args = m ? ['run', 'view', m[2], '-R', m[1], '--json', 'status,conclusion'] : ['run', 'view', ref, '--json', 'status,conclusion']
  const r = await run(args, cwd)
  if (r.code !== 0) return { value: 'unknown', final: false }
  const o = JSON.parse(r.stdout)
  if (o.status !== 'completed') return { value: 'pending', final: false }
  const c = String(o.conclusion ?? '').toUpperCase()
  // only a pass is final: a failed run can be re-run under the same id
  return PASSED.includes(c) ? { value: 'pass', final: true } : FAILED.includes(c) ? { value: 'fail', final: false } : { value: 'unknown', final: false }
}

async function prCheck(run: GhRun, ref: string, cwd: string): Promise<Answer> {
  const r = await run(['pr', 'view', ref, '--json', 'state,statusCheckRollup'], cwd)
  if (r.code !== 0) return { value: 'unknown', final: false }
  const o = JSON.parse(r.stdout)
  if (o.state === 'MERGED') return { value: 'pass', final: true }
  if (o.state === 'CLOSED') return { value: 'fail', final: true }
  const states: string[] = (o.statusCheckRollup ?? []).map((c: { conclusion?: string; state?: string }) => c.conclusion || c.state || '')
  if (states.some(s => FAILED.includes(s))) return { value: 'fail', final: false }
  if (states.length && states.every(s => PASSED.includes(s))) return { value: 'pass', final: false }
  return { value: 'pending', final: false }
}

// A finished child's worktree is deleted, and gh must never fall back to orch's own cwd:
// a URL names its repo, so it runs from the temp dir; a bare number means nothing without its repo.
function runDir(ref: string, cwd: string): string | undefined {
  if (cwd && existsSync(cwd)) return cwd
  return /^https?:\/\//i.test(ref) ? tmpdir() : undefined
}

async function ask(run: GhRun, ev: Evidence, cwd: string): Promise<Answer> {
  const dir = runDir(ev.ref, cwd)
  if (dir === undefined) return { value: 'unknown', final: false }
  return ev.kind === 'ci' ? ciCheck(run, ev.ref, dir) : prCheck(run, ev.ref, dir)
}

type Entry = { value?: Check; arrivedAt?: number; final?: boolean; inflight?: Promise<void> }

export function cliGh(run: GhRun = runGh, now: () => number = Date.now): Gh {
  // at most MAX_GH gh processes at once; the rest wait their turn
  let active = 0
  const waiting: (() => void)[] = []
  const limited: GhRun = async (args, cwd) => {
    if (active >= MAX_GH) await new Promise<void>(go => waiting.push(go))
    active++
    try {
      return await run(args, cwd)
    } finally {
      active--
      waiting.shift()?.()
    }
  }
  // the in-flight refresh is cached, so two checks of one key while gh runs spawn it once
  const cache = new Map<string, Entry>()
  const refresh = (e: Entry, ev: Evidence, cwd: string) =>
    (e.inflight ??= ask(limited, ev, cwd)
      .catch((): Answer => ({ value: 'unknown', final: false }))
      .then(a => {
        e.value = a.value
        e.final = a.final
        e.arrivedAt = now()
        e.inflight = undefined
      }))
  return {
    async check(ev, cwd, opts = {}) {
      if (ev.kind !== 'ci' && ev.kind !== 'pr') return 'unknown'
      const key = checkKey(ev, cwd)
      let e = cache.get(key)
      if (!e) cache.set(key, (e = {}))
      const fresh = e.value !== undefined && (e.final || now() - e.arrivedAt! < (e.value === 'unknown' ? UNKNOWN_TTL_MS : ANSWER_TTL_MS))
      if (fresh) return e.value!
      const refreshing = refresh(e, ev, cwd)
      if (opts.stale) return e.value ?? 'unknown'
      await refreshing
      return e.value!
    },
  }
}
