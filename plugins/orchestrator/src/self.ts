import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { readLiveSessions } from './sources/sessions.js'

// Which session is calling, from the most to the least direct source:
//   CLAUDE_CODE_SESSION_ID  set by Claude Code in every Bash and hook subprocess, and kept current across /clear;
//   CLAUDE_SESSION_ID       our SessionStart hook's export (CLAUDE_ENV_FILE), for a Claude Code that sets no CLAUDE_CODE_ one;
//   CLAUDE_PID              the Claude process's pid, looked up in ~/.claude/sessions;
//   the process tree        walked up from orch until a pid is one of the registered Claude processes.
export function resolveSelf(ctx: Ctx): string {
  const fromEnv = ctx.env.CLAUDE_CODE_SESSION_ID || ctx.env.CLAUDE_SESSION_ID
  if (fromEnv) return fromEnv
  const live = readLiveSessions(ctx.claudeHome, ctx.isAlive)
  const claudePid = Number(ctx.env.CLAUDE_PID)
  if (ctx.env.CLAUDE_PID && Number.isInteger(claudePid)) {
    const s = live.find(x => x.pid === claudePid)
    if (s) return s.sessionId
  }
  const byPid = new Map(live.map(s => [s.pid, s.sessionId]))
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
