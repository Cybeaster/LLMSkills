import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pidAlive, readLiveSessions, sessionLink } from '../src/sources/sessions.js'

const claudeHome = fileURLToPath(new URL('./fixtures/claude', import.meta.url))

describe('readLiveSessions', () => {
  it('reads live sessions and skips dead pids, broken files and other names', () => {
    const s = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.sessionId)).toEqual(['s-parent', 's-python'])
    expect(s[0]).toMatchObject({ name: 'beginner-courses', status: 'idle', bridgeSessionId: 'session_01Parent' })
    expect(s[1].status).toBe('busy')
    // Claude Code writes "bridgeSessionId": null outside Remote Control
    expect(s[1].bridgeSessionId).toBeUndefined()
  })

  it('returns nothing when the directory is missing', () => {
    expect(readLiveSessions('/nonexistent', () => true)).toEqual([])
  })

  it('builds the claude.ai link from bridgeSessionId', () => {
    const [p, py] = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(sessionLink(p)).toBe('https://claude.ai/code/session_01Parent')
    expect(sessionLink(py)).toBeUndefined()
  })

  it('sees its own process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })
})
