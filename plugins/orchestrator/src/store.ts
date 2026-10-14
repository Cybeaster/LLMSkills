import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchError } from './errors.js'
import type { Pool } from './model.js'

export type PoolEntry = { id: string; pool?: Pool; error?: string }

export const poolPath = (home: string, id: string) => join(home, `${id}.json`)

export function readPool(home: string, id: string): Pool | undefined {
  try {
    return JSON.parse(readFileSync(poolPath(home, id), 'utf8')) as Pool
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

export function writePool(home: string, pool: Pool): void {
  mkdirSync(home, { recursive: true })
  const path = poolPath(home, pool.sessionId)
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, JSON.stringify(pool, null, 2))
  renameSync(tmp, path)
}

export function listPools(home: string): PoolEntry[] {
  let names: string[]
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => {
      const id = n.slice(0, -'.json'.length)
      try {
        return { id, pool: JSON.parse(readFileSync(join(home, n), 'utf8')) as Pool }
      } catch (e) {
        return { id, error: e instanceof Error ? e.message : String(e) }
      }
    })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const STALE_LOCK_MS = 10_000

async function withLock<T>(home: string, id: string, fn: () => T): Promise<T> {
  mkdirSync(home, { recursive: true })
  const lock = `${poolPath(home, id)}.lock`
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Known race: two processes that both judge the same crashed holder's lock stale can, inside a
      // microseconds-wide window, both proceed (one removes the other's fresh lock). That needs a
      // crash first, costs at most one lost update, and the pool file stays valid JSON because
      // writePool renames atomically.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new OrchError(`pool ${id} is locked by another orch process`)
      await sleep(10 + Math.random() * 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// Read, change and write one pool under its lock. Never hold two locks at once.
export function update(home: string, id: string, fn: (p: Pool | undefined) => Pool): Promise<Pool> {
  return withLock(home, id, () => {
    const next = fn(readPool(home, id))
    writePool(home, next)
    return next
  })
}

export function updateIfExists(home: string, id: string, fn: (p: Pool) => Pool): Promise<Pool | undefined> {
  return withLock(home, id, () => {
    const cur = readPool(home, id)
    if (!cur) return undefined
    const next = fn(cur)
    writePool(home, next)
    return next
  })
}

export function log(home: string, message: string): void {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'orch.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never fail a hook
  }
}
