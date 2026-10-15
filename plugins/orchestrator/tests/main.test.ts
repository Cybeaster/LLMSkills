import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { describeFailure } from '../src/cli.js'
import { readPool } from '../src/store.js'
import { pidGone, waitFor } from './helpers.js'

// These run the built bin/orch, so `npm run build` has to come first (check:bundle keeps it current).
const BIN = fileURLToPath(new URL('../bin/orch', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Inside Claude Code these are set to the real session, which would win over the test's own id.
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-main-')))
  dirs.push(dir)
  const env: NodeJS.ProcessEnv = { ...process.env, ORCH_HOME: join(dir, 'orch'), ORCH_CLAUDE_HOME: join(dir, 'claude'), CLAUDE_SESSION_ID: 's-main' }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_PID
  return { dir, env }
}

describe('bin/orch', () => {
  it('prints help and exits 0', () => {
    const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: sandbox().env })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/orch plan/)
  })

  it('reports a failure that is not ours as one line, without a stack trace', () => {
    const { dir, env } = sandbox()
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'not a directory')
    const r = spawnSync(process.execPath, [BIN, 'plan', 'a'], { encoding: 'utf8', env: { ...env, ORCH_HOME: join(blocker, 'pools') } })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/^orch: .*(ENOTDIR|EEXIST)/)
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(r.stderr).not.toMatch(/\n\s+at |Node\.js v|node:internal/)
  })

  // The command's group is detached from orch's, so a signal to orch alone would leave it running.
  // Whatever orch is sent, the command is stopped with SIGTERM and the tick is refused.
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const)('kills the command and its group when orch gets %s mid-command', async signal => {
    const { dir, env } = sandbox()
    expect(spawnSync(process.execPath, [BIN, 'plan', 'a'], { env }).status).toBe(0)
    expect(readPool(env.ORCH_HOME!, 's-main')).toBeDefined()
    const pidFile = join(dir, 'pid')
    const child = spawn(process.execPath, [BIN, 'task', 'done', 't1', '--evidence', `cmd:echo $$ > ${pidFile}; exec sleep 30`], { env, cwd: dir })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => (stderr += d))
    const closed = new Promise<number | null>(resolve => child.on('close', resolve))
    let pid = 0
    try {
      pid = await waitFor(() => Number((() => { try { return readFileSync(pidFile, 'utf8') } catch { return '' } })().trim()) || undefined, 'the command to start')
      child.kill(signal)
      expect(await closed).toBe(1)
      expect(stderr).toMatch(/killed by SIGTERM/)
      await waitFor(() => pidGone(pid), 'the command to die')
    } finally {
      if (pid && !pidGone(pid)) process.kill(pid, 'SIGKILL')
      child.kill('SIGKILL')
    }
  })
})

describe('describeFailure', () => {
  it('is the message alone for an ordinary error', () => {
    expect(describeFailure(new Error('boom'))).toBe('orch: boom\n')
    expect(describeFailure('plain')).toBe('orch: plain\n')
  })

  it('points at the sandbox when a write is denied', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      const text = describeFailure(Object.assign(new Error(`${code}: denied, mkdir '/home/u/.claude/orchestrator'`), { code }))
      expect(text).toContain(`orch: ${code}: denied`)
      expect(text).toContain('if Claude Code\'s Bash sandbox is on, add "orch *" to sandbox.excludedCommands in ~/.claude/settings.json')
    }
    expect(describeFailure(Object.assign(new Error('missing'), { code: 'ENOENT' }))).not.toMatch(/sandbox/)
  })
})
