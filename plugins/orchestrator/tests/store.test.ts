import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { newPool } from '../src/model.js'
import { listPools, lockTiming, log, poolPath, readPool, update, updateIfExists, writePool } from '../src/store.js'

const dirs: string[] = []
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const home = () => tmp('orch-store-')
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Each worker is its own process, so the lock is contended for real; in one process every update
// would run to completion without yielding and never meet a held lock. Workers announce
// themselves, then wait for a start signal so that all of them hit the lock at the same moment.
const WORKER = `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [bundle, home, tag, dir] = process.argv.slice(2)
const { update } = await import(bundle)
writeFileSync(join(dir, 'ready-' + tag), '')
const until = Date.now() + 10000
while (!existsSync(join(dir, 'go'))) {
  if (Date.now() > until) throw new Error('no start signal')
  await new Promise(r => setTimeout(r, 2))
}
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

  it('listPools ignores leftover temp files and lock directories', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 's1.json.123.abc.tmp'), '{"half":')
    mkdirSync(join(h, 's1.json.lock'))
    expect(listPools(h).map(e => e.id)).toEqual(['s1'])
  })

  it('listPools skips misnamed files and flags a file holding another session', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    const text = readFileSync(join(h, 's1.json'), 'utf8')
    for (const name of ['.hidden.json', 's1 copy.json', 'backup1.json']) writeFileSync(join(h, name), text)
    const entries = listPools(h).sort((a, b) => a.id.localeCompare(b.id))
    expect(entries.map(e => e.id)).toEqual(['backup1', 's1'])
    expect(entries[0].pool).toBeUndefined()
    expect(entries[0].error).toMatch(/holds session s1/)
    expect(entries[1]).toMatchObject({ id: 's1', pool: { sessionId: 's1' } })
  })

  it('readPool refuses a file that holds another session', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 'backup1.json'), readFileSync(join(h, 's1.json'), 'utf8'))
    expect(() => readPool(h, 'backup1')).toThrow(OrchError)
    expect(() => readPool(h, 'backup1')).toThrow(/holds session s1/)
    expect(readPool(h, 's1')).toMatchObject({ sessionId: 's1' })
  })

  it('serialises updates from many processes', async () => {
    const h = home()
    const dir = tmp('orch-store-bundle-')
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

    const tags = Array.from({ length: 6 }, (_, i) => `w${i}`)
    const state = { early: undefined as string | undefined }
    const runs = tags.map(tag =>
      runWorker([worker, bundle, h, tag, dir]).then(r => {
        if (!existsSync(join(dir, 'go'))) state.early = `worker ${tag} exited (${r.code}) before the start signal: ${r.stderr}`
        return r
      }),
    )
    const until = Date.now() + 10_000
    while (!tags.every(t => existsSync(join(dir, `ready-${t}`)))) {
      if (state.early) throw new Error(state.early)
      if (Date.now() > until) throw new Error('workers did not become ready')
      await sleep(2)
    }
    if (state.early) throw new Error(state.early)
    writeFileSync(join(dir, 'go'), '')

    const results = await Promise.all(runs)
    expect(results.map(r => r.code), results.map(r => r.stderr).join('')).toEqual(Array(6).fill(0))
    expect(readPool(h, 's1')!.tasks).toHaveLength(150)
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

  // A stale lock that cannot be removed used to spin the event loop forever; it must fail instead.
  it.skipIf(process.getuid?.() === 0)('fails instead of spinning on a stale lock it cannot remove', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(join(lock, 'sub'), { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    chmodSync(lock, 0o555)
    try {
      const err = await update(h, 's1', () => newPool('s1', '/r', 1)).catch(e => e)
      expect(err).toBeInstanceOf(OrchError)
      expect(err.message).toContain('cannot break stale lock')
      expect(err.message).toContain(lock)
    } finally {
      chmodSync(lock, 0o755)
    }
  })

  it('times out on a live lock and names it', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(lock)
    const saved = { ...lockTiming }
    Object.assign(lockTiming, { staleMs: 60_000, deadlineMs: 100 })
    try {
      const t0 = Date.now()
      const err = await update(h, 's1', () => newPool('s1', '/r', 1)).catch(e => e)
      expect(err).toBeInstanceOf(OrchError)
      expect(err.message).toContain(lock)
      expect(err.message).toMatch(/held \d+ ms/)
      expect(Date.now() - t0).toBeLessThan(1_000)
    } finally {
      Object.assign(lockTiming, saved)
    }
  })

  it('releases the lock when the update function throws', async () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    await expect(
      update(h, 's1', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
    await update(h, 's1', p => ({ ...p!, title: 'again' }))
    expect(readPool(h, 's1')!.title).toBe('again')
  })

  it('updateIfExists skips a missing pool', async () => {
    const h = home()
    expect(await updateIfExists(h, 'nope', p => p)).toBeUndefined()
    expect(existsSync(join(h, 'nope.json'))).toBe(false)
  })

  it('refuses to write a pool under a different session id', async () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    const before = readFileSync(join(h, 's1.json'), 'utf8')
    await expect(update(h, 's1', () => newPool('other', '/r', 2))).rejects.toBeInstanceOf(OrchError)
    await expect(updateIfExists(h, 's1', () => newPool('other', '/r', 2))).rejects.toBeInstanceOf(OrchError)
    expect(readFileSync(join(h, 's1.json'), 'utf8')).toBe(before)
    expect(existsSync(join(h, 'other.json'))).toBe(false)
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
  })

  it('rejects session ids that are not plain names', async () => {
    const h = home()
    for (const bad of ['../x', 'a/b', '', '.hidden', '-flag', 'a b']) {
      expect(() => poolPath(h, bad), bad).toThrow(OrchError)
      expect(() => readPool(h, bad), bad).toThrow(OrchError)
      await expect(update(h, bad, () => newPool(bad, '/r', 1)), bad).rejects.toBeInstanceOf(OrchError)
    }
    expect(() => writePool(h, newPool('../evil', '/r', 1))).toThrow(/invalid session id/)
    expect(readdirSync(h)).toEqual([])
    expect(readdirSync(join(h, '..')).includes('evil.json')).toBe(false)
  })

  it.each([
    ['{broken', /not valid JSON/],
    ['null', /not a pool/],
    ['{}', /not a pool/],
  ])('reports a corrupt pool file (%s) instead of trusting it', async (text, message) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), text)
    expect(() => readPool(h, 's1')).toThrow(OrchError)
    expect(() => readPool(h, 's1')).toThrow(message)
    const [entry] = listPools(h)
    expect(entry.id).toBe('s1')
    expect(entry.pool).toBeUndefined()
    expect(entry.error).toMatch(message)
    await expect(update(h, 's1', p => p!)).rejects.toBeInstanceOf(OrchError)
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
  })

  it.each([
    ['a null task', [null]],
    ['a task that is a string', ['t1']],
    ['a task with no text', [{ id: 't1', status: 'pending' }]],
    ['a numeric text', [{ id: 't1', text: 3, status: 'pending' }]],
    ['a numeric id', [{ id: 1, text: 'x', status: 'pending' }]],
    ['a task with no id', [{ text: 'x', status: 'pending' }]],
    ['an unknown status', [{ id: 't1', text: 'x', status: 'weird' }]],
    ['no status', [{ id: 't1', text: 'x' }]],
    ['children that is a string', [{ id: 't1', text: 'x', status: 'pending', children: 'C1' }]],
    ['children holding a number', [{ id: 't1', text: 'x', status: 'pending', children: ['C1', 2] }]],
    ['a good task followed by a bad one', [{ id: 't1', text: 'x', status: 'done' }, null]],
  ])('flags a pool with %s as unreadable instead of trusting it', (_name, tasks) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
    expect(() => readPool(h, 's1')).toThrow(/is not a pool; fix or delete it/)
  })

  it.each([
    ['a numeric cwd', { cwd: 5 }],
    ['a null cwd', { cwd: null }],
    ['no cwd', { cwd: undefined }],
  ])('flags a pool with %s as unreadable', (_name, over) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), ...over }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
    expect(() => readPool(h, 's1')).toThrow(/is not a pool; fix or delete it/)
  })

  it.each([
    ['an escape code', 't\u001b[31m1'],
    ['a newline', 't1\n'],
    ['a space', 't 1'],
    ['an empty string', ''],
    ['a slash', 't/1'],
    ['a non-ASCII letter', 'tä'],
  ])('flags a pool whose task id holds %s as unreadable', (_name, id) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks: [{ id, text: 'x', status: 'pending' }] }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
  })

  it.each(['t1', 't12', 'T-3', 'task_4', '7'])('accepts the task id %s', id => {
    const h = home()
    const tasks = [{ id, text: 'x', status: 'pending' }]
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', pool: expect.objectContaining({ tasks }) }])
  })

  it('accepts every task shape the CLI writes', () => {
    const h = home()
    const tasks = [
      { id: 't1', text: 'a', status: 'pending' },
      { id: 't2', text: 'b', status: 'in_progress', children: ['C1', 'C2'], needsInput: 'q?' },
      { id: 't3', text: 'c', status: 'done', evidence: { kind: 'commit', ref: 'abc1234' } },
      { id: 't4', text: 'd', status: 'blocked', blockedReason: 'key' },
    ]
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', pool: expect.objectContaining({ tasks }) }])
  })

  it('writePool cleans up its temp file when the write fails', () => {
    const h = home()
    mkdirSync(poolPath(h, 's1'))
    expect(() => writePool(h, newPool('s1', '/r', 1))).toThrow()
    expect(readdirSync(h).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('appends to orch.log', () => {
    const h = home()
    log(h, 'hello')
    expect(readFileSync(join(h, 'orch.log'), 'utf8')).toMatch(/Z hello\n$/)
  })

  it('rotates orch.log once it passes 1 MB', () => {
    const h = home()
    const big = 'x'.repeat(1024 * 1024 + 10)
    writeFileSync(join(h, 'orch.log'), big)
    log(h, 'after')
    expect(statSync(join(h, 'orch.log.1')).size).toBe(big.length)
    expect(readFileSync(join(h, 'orch.log'), 'utf8')).toMatch(/Z after\n$/)
    expect(statSync(join(h, 'orch.log')).size).toBeLessThan(200)
    // a second rotation replaces the old backup
    writeFileSync(join(h, 'orch.log'), big + big)
    log(h, 'again')
    expect(statSync(join(h, 'orch.log.1')).size).toBe(2 * big.length)
  })

  it('log never throws', () => {
    const h = home()
    mkdirSync(join(h, 'orch.log'))
    expect(() => log(h, 'into a directory')).not.toThrow()
  })
})
