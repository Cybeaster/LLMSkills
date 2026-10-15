import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LiveSession = {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status: 'busy' | 'idle'
  bridgeSessionId?: string
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// One file per running Claude process: ~/.claude/sessions/<pid>.json. A file can outlive its process.
export function readLiveSessions(claudeHome: string, isAlive: (pid: number) => boolean = pidAlive): LiveSession[] {
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
      const o = JSON.parse(readFileSync(join(dir, n), 'utf8'))
      if (typeof o.sessionId !== 'string' || typeof o.pid !== 'number' || !isAlive(o.pid)) continue
      out.push({
        pid: o.pid,
        sessionId: o.sessionId,
        cwd: o.cwd ?? '',
        name: typeof o.name === 'string' ? o.name : undefined,
        status: o.status === 'busy' ? 'busy' : 'idle',
        bridgeSessionId: typeof o.bridgeSessionId === 'string' ? o.bridgeSessionId : undefined,
      })
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return out
}

export function sessionLink(s: LiveSession | undefined): string | undefined {
  return s?.bridgeSessionId ? `https://claude.ai/code/${s.bridgeSessionId}` : undefined
}
