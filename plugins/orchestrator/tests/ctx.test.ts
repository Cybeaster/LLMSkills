import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { realCtx } from '../src/ctx.js'

describe('realCtx homes', () => {
  it('defaults to ~/.claude', () => {
    const c = realCtx({})
    expect(c.claudeHome).toBe(join(homedir(), '.claude'))
    expect(c.orchHome).toBe(join(homedir(), '.claude', 'orchestrator'))
  })

  it('honours CLAUDE_CONFIG_DIR, and ORCH_CLAUDE_HOME over it', () => {
    expect(realCtx({ CLAUDE_CONFIG_DIR: '/cfg' })).toMatchObject({ claudeHome: '/cfg', orchHome: '/cfg/orchestrator' })
    expect(realCtx({ CLAUDE_CONFIG_DIR: '/cfg', ORCH_CLAUDE_HOME: '/mine' }).claudeHome).toBe('/mine')
  })

  it('treats an empty value as unset', () => {
    const c = realCtx({ ORCH_HOME: '', ORCH_CLAUDE_HOME: '', CLAUDE_CONFIG_DIR: '' })
    expect(c.claudeHome).toBe(join(homedir(), '.claude'))
    expect(c.orchHome).toBe(join(homedir(), '.claude', 'orchestrator'))
    expect(realCtx({ ORCH_HOME: '/pools' }).orchHome).toBe('/pools')
  })
})
