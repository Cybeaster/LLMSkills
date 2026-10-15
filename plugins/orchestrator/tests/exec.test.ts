import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CMD_TIMEOUT_MS, execShell, ppidOf } from '../src/ctx.js'
import { pidGone, waitFor } from './helpers.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orch-exec-')))
  dirs.push(d)
  return d
}

describe('execShell', () => {
  it('runs bash in the cwd and returns the exit code with stdout and stderr together', async () => {
    const dir = tempDir()
    const r = await execShell('pwd; echo e >&2; exit 3', dir)
    expect(r.code).toBe(3)
    expect(r.out).toContain(dir)
    expect(r.out).toContain('e\n')
    expect(r.signal).toBeUndefined()
    expect(r.timedOut).toBeUndefined()
  })

  it('reports exit 0 for a command that works', async () => {
    expect(await execShell('echo hi', tempDir())).toEqual({ code: 0, out: 'hi\n' })
  })

  it('keeps only the last 64 KB of the output', async () => {
    const r = await execShell("head -c 40000 /dev/zero | tr '\\0' A; head -c 30000 /dev/zero | tr '\\0' B", tempDir())
    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(64 * 1024)
    expect(r.out.endsWith('B'.repeat(30_000))).toBe(true)
    expect(r.out.startsWith('A'.repeat(64 * 1024 - 30_000))).toBe(true)
  })

  it('decodes multi-byte characters that arrive in pieces', async () => {
    const r = await execShell("printf '\\xe2\\x9c'; sleep 0.1; printf '\\x93 done'", tempDir())
    expect(r.out).toBe('✓ done')
  })

  it('refuses a missing directory at once with code 127', async () => {
    const dir = join(tempDir(), 'gone')
    expect(await execShell('echo never', dir)).toEqual({ code: 127, out: `directory ${dir} does not exist` })
  })

  it('times out after 110 s by default', () => {
    expect(CMD_TIMEOUT_MS).toBe(110_000)
  })

  it('kills a command and its child group on timeout', async () => {
    const started = Date.now()
    const r = await execShell('sleep 30 & echo $!; wait', tempDir(), { timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGTERM')
    expect(r.code).not.toBe(0)
    const child = Number(r.out.trim().split('\n')[0])
    expect(child).toBeGreaterThan(1)
    await waitFor(() => pidGone(child), 'the background sleep to die')
  })

  it('escalates to SIGKILL when the command ignores SIGTERM', async () => {
    const r = await execShell("trap '' TERM; echo ready; sleep 30", tempDir(), { timeoutMs: 400, graceMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGKILL')
    expect(r.out).toContain('ready')
  })

  it('does not hang on a background child that keeps the pipe open, and kills it', async () => {
    const started = Date.now()
    const r = await execShell('sleep 30 & echo $!', tempDir(), { closeWaitMs: 100 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.code).toBe(0)
    expect(r.timedOut).toBeUndefined()
    const child = Number(r.out.trim())
    expect(child).toBeGreaterThan(1)
    await waitFor(() => pidGone(child), 'the background sleep to die')
  })

  it('leaves no signal listeners behind', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
    await execShell('true', tempDir())
    await execShell('sleep 30', tempDir(), { timeoutMs: 100 })
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before)
  })
})

describe('ppidOf', () => {
  it.skipIf(!existsSync('/proc/self/stat'))('reads the parent of this very process from /proc', () => {
    expect(ppidOf(process.pid)).toBe(process.ppid)
  })

  it('is undefined for a pid that does not exist', () => {
    expect(ppidOf(2 ** 22 + 12345)).toBeUndefined()
  })
})
