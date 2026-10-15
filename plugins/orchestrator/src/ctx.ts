import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cliGh, type Gh } from './sources/gh.js'
import { cliHerdr, type Herdr } from './sources/herdr.js'
import { pidAlive } from './sources/sessions.js'

export type ExecResult = { code: number; out: string }

// Every side effect a command needs. Tests pass a fake (tests/helpers.ts).
export type Ctx = {
  env: Record<string, string | undefined>
  claudeHome: string
  orchHome: string
  cwd: string
  pid: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  ppidOf: (pid: number) => number | undefined
  isAlive: (pid: number, procStart?: string) => boolean
  readStdin: () => Promise<string>
  exec: (command: string, cwd: string) => Promise<ExecResult>
  herdr: Herdr
  gh: Gh
}

export function ppidOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    return Number.isFinite(ppid) ? ppid : undefined
  } catch {
    return undefined
  }
}

export function execShell(command: string, cwd: string): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('error', e => resolve({ code: 127, out: String(e) }))
    child.on('close', code => resolve({ code: code ?? 1, out }))
  })
}

async function readStdin(): Promise<string> {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}

export function realCtx(): Ctx {
  const env = process.env
  const claudeHome = env.ORCH_CLAUDE_HOME ?? join(homedir(), '.claude')
  return {
    env,
    claudeHome,
    orchHome: env.ORCH_HOME ?? join(claudeHome, 'orchestrator'),
    cwd: process.cwd(),
    pid: process.pid,
    now: Date.now,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    ppidOf,
    isAlive: pidAlive,
    readStdin,
    exec: execShell,
    herdr: cliHerdr(),
    gh: cliGh(),
  }
}
