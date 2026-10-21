import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './ctx.js'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK = { model: 'opus', effort: 'xhigh' }

// The routing plugin's user policy, when there is one; orch needs only its spawn floor.
export function spawnDefaults(ctx: Ctx): { model: string; effort: string } {
  try {
    const spawn = JSON.parse(readFileSync(join(ctx.claudeHome, 'routing', 'policy.json'), 'utf8')).spawn ?? {}
    return { model: spawn.model || FALLBACK.model, effort: spawn.effort || FALLBACK.effort }
  } catch {
    return FALLBACK
  }
}
