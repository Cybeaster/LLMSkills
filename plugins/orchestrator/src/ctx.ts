import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { cliGh, type Gh } from './sources/gh.js'
import { cliHerdr, type Herdr } from './sources/herdr.js'
import { pidAlive } from './sources/sessions.js'

// signal: the command was killed by it (code is then 1). timedOut: orch killed it at CMD_TIMEOUT_MS.
export type ExecResult = { code: number; out: string; signal?: string; timedOut?: boolean }

// A cmd: proof should be a quick check, not a long suite. This cap stops one from hanging a session
// or leaving work running (Claude Code's Bash tool backgrounds a slow call rather than ending it).
export const CMD_TIMEOUT_MS = 110_000
const OUT_KEEP = 64 * 1024

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

// The command's group is detached from orch's, so these are forwarded to it. SIGKILL cannot be forwarded.
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

export type ExecOptions = { timeoutMs?: number; graceMs?: number; closeWaitMs?: number }

// Runs `bash -c` in its own process group, so a timeout or a signal to orch takes the whole tree down.
// Keeps the last 64 KB of stdout and stderr together. Resolves when the shell exits; a background child
// that still holds the pipes gets closeWaitMs to let go, then the group is killed.
export function execShell(command: string, cwd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const { timeoutMs = CMD_TIMEOUT_MS, graceMs = 2_000, closeWaitMs = 1_000 } = opts
  if (!existsSync(cwd)) return Promise.resolve({ code: 127, out: `directory ${cwd} does not exist` })
  return new Promise(resolve => {
    let out = ''
    let pid: number | undefined
    let timedOut = false
    let terminating = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, sig)
      } catch {
        // already gone
      }
    }
    // SIGTERM first; SIGKILL after the grace period, at once if asked again
    const terminate = () => {
      if (terminating) return killGroup('SIGKILL')
      terminating = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs)
    }
    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const settle = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      for (const sig of FORWARDED) process.off(sig, terminate)
      killGroup('SIGKILL')
      resolve({ ...r, out, ...(timedOut ? { timedOut } : {}) })
    }
    // listening before the shell exists, so a signal can never arrive while nobody would forward it
    for (const sig of FORWARDED) process.on(sig, terminate)

    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      out = String(e)
      return settle({ code: 127, out })
    }
    pid = child.pid
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const keep = (d: string) => (out = (out + d).slice(-OUT_KEEP))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => {
      out = String(e)
      settle({ code: 127, out })
    })
    let exited: ExecResult | undefined
    child.on('exit', (code, signal) => {
      // the shell finished in time: whatever still holds the pipes is bounded by closeWaitMs, not the deadline
      clearTimeout(deadline)
      exited = { code: code ?? 1, out, ...(signal ? { signal } : {}) }
      setTimeout(() => settle(exited!), closeWaitMs).unref()
    })
    // close comes after exit, once the pipes are drained
    child.on('close', () => exited && settle(exited))
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
    exec: (command, cwd) => execShell(command, cwd),
    herdr: cliHerdr(),
    gh: cliGh(),
  }
}
