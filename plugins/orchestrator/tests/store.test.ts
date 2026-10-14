import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addTask, newPool } from '../src/model.js'
import { listPools, log, readPool, update, updateIfExists, writePool } from '../src/store.js'

const home = () => mkdtempSync(join(tmpdir(), 'orch-store-'))

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

  it('serialises concurrent updates', async () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    await Promise.all(Array.from({ length: 20 }, (_, i) => update(h, 's1', p => addTask(p!, `t${i}`, i))))
    expect(readPool(h, 's1')!.tasks).toHaveLength(20)
  })

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
