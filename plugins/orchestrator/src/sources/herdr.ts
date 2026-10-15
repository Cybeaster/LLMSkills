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

export type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const runHerdr: Run = args =>
  new Promise(resolve => {
    execFile('herdr', args, { timeout: 15 * 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

type RawAgent = {
  agent: string
  name?: string
  pane_id: string
  agent_status: string
  agent_session?: { value?: string }
  terminal_title_stripped?: string
}

export function cliHerdr(run: Run = runHerdr): Herdr {
  const ok = async (args: string[]) => {
    const r = await run(args)
    if (r.code !== 0) throw new OrchError(`herdr ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
    return r.stdout
  }
  const json = async (args: string[]) => JSON.parse(await ok(args))

  return {
    async list() {
      const o = await json(['agent', 'list'])
      return (o.result.agents as RawAgent[])
        .filter(a => a.agent === 'claude')
        .map(a => ({ name: a.name, paneId: a.pane_id, status: a.agent_status, sessionId: a.agent_session?.value, title: a.terminal_title_stripped }))
    },
    async focus(target) {
      await ok(['agent', 'focus', target])
    },
    async createTab({ workspace, cwd, label }) {
      const o = await json(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'])
      const paneId = o.result?.root_pane?.pane_id
      if (!paneId) throw new OrchError(`unexpected herdr tab create reply: ${JSON.stringify(o)}`)
      return { paneId }
    },
    async startClaude({ name, paneId, args }) {
      await ok(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '60000', '--', ...args])
    },
    async sessionIdOf(name) {
      try {
        const o = await json(['agent', 'get', name])
        return o.result?.agent?.agent_session?.value || undefined
      } catch {
        return undefined
      }
    },
    async waitIdle(target, timeoutMs) {
      await ok(['agent', 'wait', target, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', String(timeoutMs)])
      const o = await json(['agent', 'get', target])
      return o.result.agent.agent_status
    },
    async prompt(target, text) {
      await ok(['agent', 'prompt', target, text])
    },
  }
}
