import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { oneLine } from '../evidence.js'

export type LiveSession = {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status: 'busy' | 'idle'
  // set while a permission prompt or dialog blocks the session (Claude writes status "waiting")
  waitingFor?: string
  bridgeSessionId?: string
}

// Field 22 of /proc/<pid>/stat; Claude Code stores it as procStart to spot a recycled pid.
function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

export function pidAlive(pid: number, procStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false // ESRCH: gone; EPERM: another user's process, so the pid was reused
  }
  if (procStart === undefined) return true
  const now = startTimeOf(pid)
  return now === undefined || now === procStart
}

// One file per running Claude process: ~/.claude/sessions/<pid>.json. A file can outlive its process.
export function readLiveSessions(
  claudeHome: string,
  isAlive: (pid: number, procStart?: string) => boolean = pidAlive,
): LiveSession[] {
  const dir = join(claudeHome, 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue
    try {
      const o = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>
      // spare and parked processes are pre-started and not sessions yet
      if (o.spare === true || typeof o.parkedJobId === 'string') continue
      if (typeof o.sessionId !== 'string' || typeof o.pid !== 'number') continue
      if (!isAlive(o.pid, typeof o.procStart === 'string' ? o.procStart : undefined)) continue
      out.push({
        pid: o.pid,
        sessionId: o.sessionId,
        cwd: typeof o.cwd === 'string' ? o.cwd : '',
        name: typeof o.name === 'string' ? o.name : undefined,
        status: o.status === 'busy' ? 'busy' : 'idle',
        // a blank or unprintable reason still means the session is waiting, so it falls back to 'input'
        waitingFor: o.status === 'waiting' ? oneLine(typeof o.waitingFor === 'string' ? o.waitingFor : '') || 'input' : undefined,
        bridgeSessionId: typeof o.bridgeSessionId === 'string' ? o.bridgeSessionId : undefined,
      })
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return out
}

export function sessionLink(s: LiveSession | undefined): string | undefined {
  const id = s?.bridgeSessionId?.replace(/^cse_/, 'session_')
  // the id goes into a terminal link, so anything but plain id characters is refused
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? `https://claude.ai/code/${id}` : undefined
}
