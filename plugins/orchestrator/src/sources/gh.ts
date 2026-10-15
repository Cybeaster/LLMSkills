import { execFile } from 'node:child_process'
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

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

async function ciCheck(run: GhRun, ref: string, cwd: string): Promise<Check> {
  const m = ref.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/)
  const args = m ? ['run', 'view', m[2], '-R', m[1], '--json', 'status,conclusion'] : ['run', 'view', ref, '--json', 'status,conclusion']
  const r = await run(args, cwd)
  if (r.code !== 0) return 'unknown'
  const o = JSON.parse(r.stdout)
  if (o.status !== 'completed') return 'pending'
  return o.conclusion === 'success' ? 'pass' : 'fail'
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

export function cliGh(run: GhRun = runGh, now: () => number = Date.now): Gh {
  const cache = new Map<string, { at: number; value: Check }>()
  return {
    async check(ev, cwd) {
      if (ev.kind !== 'ci' && ev.kind !== 'pr') return 'unknown'
      const key = checkKey(ev, cwd)
      const hit = cache.get(key)
      if (hit && now() - hit.at < 60_000) return hit.value
      let value: Check
      try {
        value = ev.kind === 'ci' ? await ciCheck(run, ev.ref, cwd) : await prCheck(run, ev.ref, cwd)
      } catch {
        value = 'unknown'
      }
      cache.set(key, { at: now(), value })
      return value
    },
  }
}
