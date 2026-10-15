import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { OrchError } from './errors.js'
import type { Pool } from './model.js'

export type PoolEntry = { id: string; pool?: Pool; error?: string }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Every pool, lock and temp path is built here, so this is the one place that vets a session id.
export function poolPath(home: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new OrchError(`invalid session id "${id}"`)
  return join(home, `${id}.json`)
}

function isPool(v: unknown): v is Pool {
  const p = v as Partial<Pool> | null | undefined
  return typeof p?.sessionId === 'string' && Array.isArray(p.tasks)
}

function parsePool(path: string, text: string): Pool {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    throw new OrchError(`pool file ${path} is not valid JSON (${(e as Error).message}); fix or delete it`)
  }
  if (!isPool(v)) throw new OrchError(`pool file ${path} is not a pool; fix or delete it`)
  return v
}

export function readPool(home: string, id: string): Pool | undefined {
  const path = poolPath(home, id)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return parsePool(path, text)
}

export function writePool(home: string, pool: Pool): void {
  const path = poolPath(home, pool.sessionId)
  mkdirSync(home, { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(pool, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the original failure is the one worth reporting
    }
    throw e
  }
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
      const path = join(home, n)
      try {
        return { id, pool: parsePool(path, readFileSync(path, 'utf8')) }
      } catch (e) {
        return { id, error: e instanceof Error ? e.message : String(e) }
      }
    })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A holder only keeps the lock for one synchronous read-modify-write, so a lock older than staleMs
// belongs to a crashed process. A caller gives up after deadlineMs, which is longer than staleMs so
// that it outlasts a crashed holder instead of failing while the lock is still being broken.
// Exported so tests can shrink the times.
export const lockTiming = { staleMs: 5_000, deadlineMs: 7_000 }

async function withLock<T>(home: string, id: string, fn: () => T): Promise<T> {
  const lock = `${poolPath(home, id)}.lock`
  mkdirSync(home, { recursive: true })
  const deadline = Date.now() + lockTiming.deadlineMs
  for (;;) {
    let held = 0
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
        held = Date.now() - statSync(lock).mtimeMs
        if (held > lockTiming.staleMs) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // released meanwhile: retry now
        throw new OrchError(`cannot break stale lock ${lock}: ${(err as Error).message}`)
      }
      if (Date.now() > deadline) {
        throw new OrchError(
          `pool ${id} is locked (${lock}, held ${Math.round(held)} ms); if no orch is running, delete that directory`,
        )
      }
      await sleep(10 + Math.random() * 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// writePool names the file after pool.sessionId while the lock guards `id`; they must agree.
function writeUnder(home: string, id: string, next: Pool): Pool {
  if (next.sessionId !== id) {
    throw new OrchError(`refusing to write pool ${next.sessionId} under session ${id}`)
  }
  writePool(home, next)
  return next
}

// Read, change and write one pool under its lock. Never hold two locks at once.
export function update(home: string, id: string, fn: (p: Pool | undefined) => Pool): Promise<Pool> {
  return withLock(home, id, () => writeUnder(home, id, fn(readPool(home, id))))
}

export function updateIfExists(home: string, id: string, fn: (p: Pool) => Pool): Promise<Pool | undefined> {
  return withLock(home, id, () => {
    const cur = readPool(home, id)
    if (!cur) return undefined
    return writeUnder(home, id, fn(cur))
  })
}

const LOG_MAX_BYTES = 1024 * 1024

export function log(home: string, message: string): void {
  try {
    mkdirSync(home, { recursive: true })
    const file = join(home, 'orch.log')
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // no log yet, or another process rotated it first
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never fail a hook
  }
}
