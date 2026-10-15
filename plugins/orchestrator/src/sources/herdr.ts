import { execFile } from 'node:child_process'
import { OrchError } from '../errors.js'

export type HerdrAgent = { name?: string; paneId: string; status: string; sessionId?: string; title?: string }

export interface Herdr {
  list(): Promise<HerdrAgent[]>
  focus(target: string): Promise<void>
  createTab(o: { workspace: string; cwd: string; label: string }): Promise<{ paneId: string }>
  startClaude(o: { name: string; paneId: string; args: string[] }): Promise<void>
  sessionIdOf(name: string): Promise<string | undefined>
  waitIdle(target: string, timeoutMs: number): Promise<string>
  prompt(target: string, text: string): Promise<void>
}

export type Run = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>

// herdr failed. herdrCode is the code from its {error:{code,message}} reply (agent_not_ready, agent_blocked, ...), when it sent one
export class HerdrError extends OrchError {
  override name = 'HerdrError'

  constructor(message: string, readonly herdrCode?: string) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 75_000 // herdr's own --timeout 60000 plus slack
const WAIT_SLACK_MS = 10_000

export const runHerdr: Run = (args, timeoutMs) => {
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise(resolve => {
    execFile('herdr', args, { timeout: limit, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      // a kill by the timeout has no exit code and killed set; a maxBuffer kill has a string code
      const timedOut = err?.killed === true && typeof err.code !== 'string'
      const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0
      const error = err ? (timedOut ? `timed out after ${limit}ms` : err.message) : undefined
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error })
    })
  })
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const agentIn = (reply: unknown) => (isObj(reply) && isObj(reply.result) && isObj(reply.result.agent) ? reply.result.agent : undefined)
const snippet = (v: unknown) => JSON.stringify(v).slice(0, 200)
// only a session of kind id is a Claude sessionId; a path kind points at a transcript file instead
const sessionIdIn = (s: unknown) => (isObj(s) && s.kind === 'id' && typeof s.value === 'string' && s.value ? s.value : undefined)

function herdrErrorIn(text: string): { code?: string; message?: string } | undefined {
  try {
    const e: unknown = JSON.parse(text)?.error
    if (isObj(e) && (typeof e.code === 'string' || typeof e.message === 'string')) return { code: str(e.code), message: str(e.message) }
  } catch {
    // not JSON, so it is plain text
  }
  return undefined
}

function failure(args: string[], r: { stdout: string; stderr: string; error?: string }): HerdrError {
  const what = `herdr ${args.slice(0, 2).join(' ')} failed`
  const e = herdrErrorIn(r.stderr) ?? herdrErrorIn(r.stdout)
  if (e) return new HerdrError(`${what}: ${e.message ?? e.code}${e.message && e.code ? ` (${e.code})` : ''}`, e.code)
  return new HerdrError(`${what}: ${r.stderr.trim() || r.stdout.trim() || (r.error ?? '').trim()}`)
}

export function cliHerdr(run: Run = runHerdr): Herdr {
  const ok = async (args: string[], timeoutMs?: number) => {
    const r = await run(args, timeoutMs)
    if (r.code !== 0) throw failure(args, r)
    return r.stdout
  }
  const json = async (args: string[], timeoutMs?: number): Promise<unknown> => {
    const out = await ok(args, timeoutMs)
    try {
      return JSON.parse(out)
    } catch {
      throw new HerdrError(`herdr ${args.slice(0, 2).join(' ')} did not answer with JSON: ${out.trim().slice(0, 200)}`)
    }
  }

  return {
    async list() {
      const o = await json(['agent', 'list'])
      const agents = isObj(o) && isObj(o.result) ? o.result.agents : undefined
      if (!Array.isArray(agents)) throw new HerdrError(`unexpected herdr agent list reply: ${snippet(o)}`)
      return agents
        .filter((a): a is Record<string, unknown> & { pane_id: string } => isObj(a) && a.agent === 'claude' && typeof a.pane_id === 'string')
        .map(a => ({
          name: str(a.name),
          paneId: a.pane_id,
          status: str(a.agent_status) ?? 'unknown',
          sessionId: sessionIdIn(a.agent_session),
          title: str(a.terminal_title_stripped),
        }))
    },
    async focus(target) {
      await ok(['agent', 'focus', target])
    },
    async createTab({ workspace, cwd, label }) {
      const o = await json(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'])
      const root = isObj(o) && isObj(o.result) ? o.result.root_pane : undefined
      const paneId = isObj(root) ? str(root.pane_id) : undefined
      if (!paneId) throw new HerdrError(`unexpected herdr tab create reply: ${snippet(o)}`)
      return { paneId }
    },
    async startClaude({ name, paneId, args }) {
      await ok(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '60000', '--', ...args], START_TIMEOUT_MS)
    },
    async sessionIdOf(name) {
      try {
        return sessionIdIn(agentIn(await json(['agent', 'get', name]))?.agent_session)
      } catch {
        return undefined
      }
    },
    async waitIdle(target, timeoutMs) {
      await ok(['agent', 'wait', target, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', String(timeoutMs)], timeoutMs + WAIT_SLACK_MS)
      const o = await json(['agent', 'get', target])
      const status = str(agentIn(o)?.agent_status)
      if (!status) throw new HerdrError(`unexpected herdr agent get reply: ${snippet(o)}`)
      return status
    },
    async prompt(target, text) {
      // no --wait; don't retry a failure, herdr says a timeout does not prove the prompt was not delivered
      await ok(['agent', 'prompt', target, text])
    },
  }
}
