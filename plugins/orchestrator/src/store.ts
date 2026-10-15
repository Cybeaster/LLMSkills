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
import type { Pool, Status, Task } from './model.js'

export type PoolEntry = { id: string; pool?: Pool; error?: string }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Every pool, lock and temp path is built here, so this is the one place that vets a session id.
export function poolPath(home: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new OrchError(`invalid session id "${id}"`)
  return join(home, `${id}.json`)
}

// orch itself only writes t1, t2 and so on; anything else was edited in by hand, and an id is printed as is.
const TASK_ID = /^[A-Za-z0-9_-]+$/

const STATUSES: readonly Status[] = ['pending', 'in_progress', 'done', 'blocked']

// One malformed task (null, no text, a numeric id) would otherwise throw deep inside the overview and
// take every view down, so a pool with such a task is an unreadable pool.
function isTask(v: unknown): v is Task {
  const t = v as Partial<Task> | null | undefined
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    TASK_ID.test(t.id) &&
    typeof t.text === 'string' &&
    STATUSES.includes(t.status as Status) &&
    (t.children === undefined || (Array.isArray(t.children) && t.children.every(c => typeof c === 'string')))
  )
}

function isPool(v: unknown): v is Pool {
  const p = v as Partial<Pool> | null | undefined
  return typeof p?.sessionId === 'string' && typeof p.cwd === 'string' && Array.isArray(p.tasks) && p.tasks.every(isTask)
}

// A pool file must hold the session its name says; a copy such as backup1.json would otherwise
// show up as a second session with the original's tasks and questions.
function parsePool(path: string, id: string, text: string): Pool {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    throw new OrchError(`pool file ${path} is not valid JSON (${(e as Error).message}); fix or delete it`)
  }
  if (!isPool(v)) throw new OrchError(`pool file ${path} is not a pool; fix or delete it`)
  if (v.sessionId !== id) throw new OrchError(`pool file ${path} holds session ${v.sessionId}; fix or delete it`)
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
  return parsePool(path, id, text)
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
  // Names that are not valid session ids are never written by orch; skip them like temp files and lock dirs.
  return names
    .filter(n => n.endsWith('.json') && ID_PATTERN.test(n.slice(0, -'.json'.length)))
    .map(n => {
      const id = n.slice(0, -'.json'.length)
      const path = join(home, n)
      try {
        return { id, pool: parsePool(path, id, readFileSync(path, 'utf8')) }
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

// waitMs: how long this caller waits for the lock; hooks pass a short one so they never stall a prompt.
async function withLock<T>(home: string, id: string, fn: () => T, waitMs = lockTiming.deadlineMs): Promise<T> {
  const lock = `${poolPath(home, id)}.lock`
  mkdirSync(home, { recursive: true })
  const deadline = Date.now() + waitMs
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
export function update(home: string, id: string, fn: (p: Pool | undefined) => Pool, waitMs?: number): Promise<Pool> {
  return withLock(home, id, () => writeUnder(home, id, fn(readPool(home, id))), waitMs)
}

export function updateIfExists(home: string, id: string, fn: (p: Pool) => Pool, waitMs?: number): Promise<Pool | undefined> {
  return withLock(
    home,
    id,
    () => {
      const cur = readPool(home, id)
      if (!cur) return undefined
      return writeUnder(home, id, fn(cur))
    },
    waitMs,
  )
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
