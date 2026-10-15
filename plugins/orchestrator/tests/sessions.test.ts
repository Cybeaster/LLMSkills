import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type LiveSession, pidAlive, readLiveSessions, sessionLink } from '../src/sources/sessions.js'

const claudeHome = fileURLToPath(new URL('./fixtures/claude', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A claude home whose sessions/ holds exactly these files.
function homeWith(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
  dirs.push(home)
  mkdirSync(join(home, 'sessions'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, 'sessions', name), body)
  return home
}

const alive = () => true

describe('readLiveSessions', () => {
  it('reads live sessions and skips dead pids, broken files, other names, spares and string pids', () => {
    const s = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.sessionId)).toEqual(['s-parent', 's-python', 's-wait'])
    expect(s[0]).toMatchObject({ name: 'beginner-courses', status: 'idle', bridgeSessionId: 'session_01Parent' })
    expect(s[0].waitingFor).toBeUndefined()
    expect(s[1].status).toBe('busy')
    // Claude Code writes "bridgeSessionId": null outside Remote Control
    expect(s[1].bridgeSessionId).toBeUndefined()
  })

  it('surfaces a session that waits on a dialog as idle with waitingFor', () => {
    const s = readLiveSessions(claudeHome, pid => pid !== 103).find(x => x.sessionId === 's-wait')
    expect(s).toMatchObject({ status: 'idle', waitingFor: 'dialog open' })
  })

  it('hands each record procStart to the liveness check', () => {
    const seen = new Map<number, string | undefined>()
    readLiveSessions(claudeHome, (pid, procStart) => {
      seen.set(pid, procStart)
      return true
    })
    expect(seen.get(101)).toBe('4242424')
    expect(seen.get(103)).toBeUndefined()
    // a string pid never reaches the liveness check
    expect(seen.has(108)).toBe(false)
  })

  it('returns nothing when the directory is missing', () => {
    expect(readLiveSessions('/nonexistent', () => true)).toEqual([])
  })

  it('maps every status except busy to idle', () => {
    const home = homeWith({
      '201.json': '{"pid":201,"sessionId":"s-none","cwd":"/tmp"}',
      '202.json': '{"pid":202,"sessionId":"s-shell","cwd":"/tmp","status":"shell"}',
      '203.json': '{"pid":203,"sessionId":"s-busy","cwd":"/tmp","status":"busy"}',
      '204.json': '{"pid":204,"sessionId":"s-bare-wait","cwd":"/tmp","status":"waiting"}',
    })
    const s = readLiveSessions(home, alive).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.status)).toEqual(['idle', 'idle', 'busy', 'idle'])
    expect(s.map(x => x.waitingFor)).toEqual([undefined, undefined, undefined, 'input'])
  })

  it('falls back to an empty cwd and no name when they are not strings', () => {
    const home = homeWith({
      '221.json': '{"pid":221,"sessionId":"s-bare","status":"idle"}',
      '222.json': '{"pid":222,"sessionId":"s-odd","cwd":7,"name":7,"status":"idle"}',
    })
    const s = readLiveSessions(home, alive)
    expect(s.map(x => x.cwd)).toEqual(['', ''])
    expect(s.map(x => x.name)).toEqual([undefined, undefined])
  })

  it('skips parked jobs and files that are not objects', () => {
    const home = homeWith({
      '211.json': '{"pid":211,"sessionId":"s-parked","cwd":"/tmp","status":"idle","parkedJobId":"job-1"}',
      '212.json': 'null',
      '213.json': '{"pid":213,"sessionId":"s-ok","cwd":"/tmp","status":"idle"}',
    })
    expect(readLiveSessions(home, alive).map(x => x.sessionId)).toEqual(['s-ok'])
  })

  it('builds the claude.ai link from bridgeSessionId', () => {
    const [p, py] = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(sessionLink(p)).toBe('https://claude.ai/code/session_01Parent')
    expect(sessionLink(py)).toBeUndefined()
  })
})

describe('sessionLink', () => {
  const live = (bridgeSessionId?: string): LiveSession => ({ pid: 1, sessionId: 's', cwd: '/', status: 'idle', bridgeSessionId })

  it('rewrites the cse_ prefix to session_', () => {
    expect(sessionLink(live('cse_X'))).toBe('https://claude.ai/code/session_X')
  })

  it('refuses ids that could carry escape codes or path tricks', () => {
    expect(sessionLink(live('bad\u001b[31m'))).toBeUndefined()
    expect(sessionLink(live('a/../b'))).toBeUndefined()
    expect(sessionLink(live(''))).toBeUndefined()
    expect(sessionLink(undefined)).toBeUndefined()
  })
})

describe('pidAlive', () => {
  const hasProc = (() => {
    try {
      readFileSync('/proc/self/stat', 'utf8')
      return true
    } catch {
      return false
    }
  })()

  it('sees its own process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('rejects pids that mean a group, init or nothing', () => {
    expect(pidAlive(1)).toBe(false)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(2 ** 22 + 1)).toBe(false)
  })

  it.skipIf(!hasProc)('compares the process start time to spot a recycled pid', () => {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    expect(pidAlive(process.pid, startTime)).toBe(true)
    expect(pidAlive(process.pid, '1')).toBe(false)
  })
})
