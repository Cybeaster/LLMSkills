import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { newPool } from '../src/model.js'
import { listPools, log, readPool, update, updateIfExists, writePool } from '../src/store.js'

const home = () => mkdtempSync(join(tmpdir(), 'orch-store-'))

// Each worker is its own process, so the lock is contended for real; in one process every update
// would run to completion without yielding and never meet a held lock.
const WORKER = `
const [bundle, home, tag] = process.argv.slice(2)
const { update } = await import(bundle)
for (let i = 0; i < 25; i++) {
  const id = tag + '-' + i
  await update(home, 's1', p => ({ ...p, tasks: [...p.tasks, { id, text: id, status: 'pending' }] }))
}
`

const runWorker = (args: string[]) =>
  new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => (stderr += d))
    child.on('error', reject)
    child.on('close', code => resolve({ code, stderr }))
  })

describe('store', () => {
  it('round-trips a pool and leaves no temp file', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    expect(readPool(h, 's1')).toMatchObject({ sessionId: 's1', cwd: '/r' })
    expect(readdirSync(h)).toEqual(['s1.json'])
  })

  it('returns undefined for a missing pool', () => {
    expect(readPool(home(), 'nope')).toBeUndefined()
  })

  it('lists pools and reports unreadable ones', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 's2.json'), '{broken')
    writeFileSync(join(h, 'orch.log'), 'x')
    const entries = listPools(h).sort((a, b) => a.id.localeCompare(b.id))
    expect(entries[0]).toMatchObject({ id: 's1', pool: { sessionId: 's1' } })
    expect(entries[1].id).toBe('s2')
    expect(entries[1].error).toMatch(/JSON/)
    expect(entries).toHaveLength(2)
  })

  it('serialises updates from many processes', async () => {
    const h = home()
    const dir = mkdtempSync(join(tmpdir(), 'orch-store-bundle-'))
    try {
      await build({
        entryPoints: [fileURLToPath(new URL('../src/store.ts', import.meta.url))],
        outfile: join(dir, 'store.mjs'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
      })
      const worker = join(dir, 'worker.mjs')
      writeFileSync(worker, WORKER)
      const bundle = pathToFileURL(join(dir, 'store.mjs')).href
      writePool(h, newPool('s1', '/r', 1))
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker([worker, bundle, h, `w${i}`])))
      expect(results.map(r => r.code), results.map(r => r.stderr).join('')).toEqual(Array(6).fill(0))
      expect(readPool(h, 's1')!.tasks).toHaveLength(150)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('breaks a stale lock', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    await update(h, 's1', () => newPool('s1', '/r', 1))
    expect(readPool(h, 's1')).toBeDefined()
    expect(existsSync(lock)).toBe(false)
  })

  it('updateIfExists skips a missing pool', async () => {
    const h = home()
    expect(await updateIfExists(h, 'nope', p => p)).toBeUndefined()
    expect(existsSync(join(h, 'nope.json'))).toBe(false)
  })

  it('appends to orch.log', () => {
    const h = home()
    log(h, 'hello')
    expect(readFileSync(join(h, 'orch.log'), 'utf8')).toMatch(/Z hello\n$/)
  })
})
