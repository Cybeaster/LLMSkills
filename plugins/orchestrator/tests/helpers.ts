import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { Ctx, ExecResult } from '../src/ctx.js'
import type { Check } from '../src/evidence.js'
import type { Evidence } from '../src/model.js'
import type { Gh } from '../src/sources/gh.js'
import type { Herdr, HerdrAgent } from '../src/sources/herdr.js'

export type FakeHerdr = Herdr & { calls: string[][]; agents: HerdrAgent[]; waitTimeouts: number[] }

export function fakeHerdr(agents: HerdrAgent[] = []): FakeHerdr {
  const calls: string[][] = []
  const h: FakeHerdr = {
    calls,
    agents,
    waitTimeouts: [],
    async list() {
      return h.agents
    },
    async focus(target) {
      calls.push(['focus', target])
    },
    async createTab(o) {
      calls.push(['createTab', o.workspace, o.cwd, o.label])
      return { paneId: 'w9:p1' }
    },
    async startClaude(o) {
      calls.push(['startClaude', o.name, o.paneId, ...o.args])
      h.agents.push({ name: o.name, paneId: o.paneId, status: 'idle', sessionId: 's-child' })
    },
    async sessionIdOf(name) {
      return h.agents.find(a => a.name === name)?.sessionId
    },
    async waitIdle(target, timeoutMs) {
      calls.push(['waitIdle', target])
      h.waitTimeouts.push(timeoutMs)
      return h.agents.find(a => a.paneId === target)?.status === 'blocked' ? 'blocked' : 'idle'
    },
    async prompt(target, text) {
      calls.push(['prompt', target, text])
    },
  }
  return h
}

export type FakeExec = Ctx['exec'] & { calls: [command: string, cwd: string][] }

// Records [command, cwd] for every run; the reply decides what the command "printed".
export function fakeExec(
  reply: (command: string) => ExecResult = command => (command.includes('fail') ? { code: 1, out: 'boom\n' } : { code: 0, out: 'ok\n' }),
): FakeExec {
  const calls: FakeExec['calls'] = []
  const exec = (async (command: string, cwd: string) => {
    calls.push([command, cwd])
    return reply(command)
  }) as FakeExec
  exec.calls = calls
  return exec
}

export type FakeGh = Gh & { calls: [ev: Evidence, cwd: string][] }

export function fakeGh(answer: Check = 'unknown'): FakeGh {
  const calls: FakeGh['calls'] = []
  return {
    calls,
    async check(ev, cwd) {
      calls.push([ev, cwd])
      return answer
    },
  }
}

export type TestCtx = Ctx & { stdin: string; herdr: FakeHerdr; exec: FakeExec }

// Every makeCtx home is removed after the test that made it.
const roots: string[] = []
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

export function makeCtx(over: Partial<TestCtx> = {}): TestCtx {
  const root = mkdtempSync(join(tmpdir(), 'orch-'))
  roots.push(root)
  const claudeHome = join(root, 'claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  let t = 1_000_000
  const ctx: TestCtx = {
    env: { CLAUDE_SESSION_ID: 's-self' },
    claudeHome,
    orchHome: join(root, 'orch'),
    cwd: root,
    pid: 4242,
    now: () => (t += 1000),
    sleep: async () => {},
    ppidOf: () => undefined,
    isAlive: () => true,
    stdin: '',
    readStdin: async () => ctx.stdin,
    exec: fakeExec(),
    herdr: fakeHerdr(),
    gh: { check: async () => 'unknown' } satisfies Gh,
    ...over,
  }
  return ctx
}

export function writeSession(ctx: Ctx, o: { pid: number; sessionId: string; cwd?: string; name?: string; status?: string; waitingFor?: string; bridgeSessionId?: string }) {
  writeFileSync(join(ctx.claudeHome, 'sessions', `${o.pid}.json`), JSON.stringify({ cwd: ctx.cwd, status: 'idle', kind: 'interactive', ...o }))
}

// A zombie still answers kill(pid, 0); only a process that is neither running nor waiting to be reaped is gone.
export function pidGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z'
  } catch {
    return true
  }
}

export async function waitFor<T>(probe: () => T | undefined | false, what: string, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}
