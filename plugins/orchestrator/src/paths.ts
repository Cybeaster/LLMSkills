import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'

function kind(path: string): 'file' | 'dir' | 'other' | undefined {
  try {
    const s = statSync(path)
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'
  } catch {
    return undefined
  }
}

// An absolute path to an existing regular file, relative to the caller's cwd.
export function briefFile(ctx: Ctx, p: string): string {
  const abs = resolve(ctx.cwd, p)
  const k = kind(abs)
  if (!k) throw new OrchError(`brief not found: ${abs}: write the brief first`)
  if (k !== 'file') throw new OrchError(`brief is not a file: ${abs}`)
  return abs
}

export function workDir(ctx: Ctx, p: string): string {
  const abs = resolve(ctx.cwd, p)
  const k = kind(abs)
  if (!k) throw new OrchError(`cwd does not exist: ${abs}`)
  if (k !== 'dir') throw new OrchError(`cwd is not a directory: ${abs}`)
  return abs
}
