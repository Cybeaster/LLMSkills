import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { readLiveSessions } from './sources/sessions.js'

// CLAUDE_SESSION_ID comes from the SessionStart hook (CLAUDE_ENV_FILE). Without it, walk up the
// process tree until a pid is one of the registered Claude processes.
export function resolveSelf(ctx: Ctx): string {
  if (ctx.env.CLAUDE_SESSION_ID) return ctx.env.CLAUDE_SESSION_ID
  const byPid = new Map(readLiveSessions(ctx.claudeHome, ctx.isAlive).map(s => [s.pid, s.sessionId]))
  let pid: number | undefined = ctx.pid
  for (let i = 0; i < 32 && pid && pid > 1; i++) {
    const id = byPid.get(pid)
    if (id) return id
    pid = ctx.ppidOf(pid)
  }
  throw new OrchError('cannot tell which session this is: run orch from inside a Claude Code session')
}

export function trySelf(ctx: Ctx): string | undefined {
  try {
    return resolveSelf(ctx)
  } catch {
    return undefined
  }
}
