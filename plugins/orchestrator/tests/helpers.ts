import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '../src/ctx.js'
import type { Gh } from '../src/sources/gh.js'
import type { Herdr, HerdrAgent } from '../src/sources/herdr.js'

export type FakeHerdr = Herdr & { calls: string[][]; agents: HerdrAgent[] }

export function fakeHerdr(agents: HerdrAgent[] = []): FakeHerdr {
  const calls: string[][] = []
  const h: FakeHerdr = {
    calls,
    agents,
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
    async waitIdle(target) {
      calls.push(['waitIdle', target])
      return h.agents.find(a => a.paneId === target)?.status === 'blocked' ? 'blocked' : 'idle'
    },
    async prompt(target, text) {
      calls.push(['prompt', target, text])
    },
  }
  return h
}

export type TestCtx = Ctx & { stdin: string; herdr: FakeHerdr }

export function makeCtx(over: Partial<TestCtx> = {}): TestCtx {
  const root = mkdtempSync(join(tmpdir(), 'orch-'))
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
    exec: async cmd => (cmd.includes('fail') ? { code: 1, out: 'boom\n' } : { code: 0, out: 'ok\n' }),
    herdr: fakeHerdr(),
    gh: { check: async () => 'unknown' } satisfies Gh,
    ...over,
  }
  return ctx
}

export function writeSession(ctx: Ctx, o: { pid: number; sessionId: string; cwd?: string; name?: string; status?: string; waitingFor?: string; bridgeSessionId?: string }) {
  writeFileSync(join(ctx.claudeHome, 'sessions', `${o.pid}.json`), JSON.stringify({ cwd: ctx.cwd, status: 'idle', kind: 'interactive', ...o }))
}
