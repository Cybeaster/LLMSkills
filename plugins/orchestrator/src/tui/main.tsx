import { render } from 'ink'
import { collect } from '../collect.js'
import type { Ctx } from '../ctx.js'
import { linkSessions } from '../link.js'
import type { Row } from '../overview.js'
import { App, type Actions } from './App.js'

export function tuiActions(ctx: Ctx): Actions {
  return {
    // stale: a slow gh must not hold up a refresh; its verdict shows on the next one
    load: () => collect(ctx, { checks: 'live', stale: true }),
    async focus(row: Row) {
      if (!row.paneId) return `not in herdr: ${row.cwd}${row.pid ? ` (pid ${row.pid})` : ''}`
      await ctx.herdr.focus(row.paneId)
      return `focused ${row.name}`
    },
    async link(child: Row, parent: Row, taskId: string) {
      await linkSessions(ctx, child.sessionId, parent.sessionId, taskId)
      return `${child.name} is now under ${parent.name} ${taskId}`
    },
  }
}

export async function startTui(ctx: Ctx): Promise<void> {
  // Ctrl-C is handled by the App (exit 130), not by Ink
  const app = render(<App actions={tuiActions(ctx)} onQuit={code => (process.exitCode = code)} />, { exitOnCtrlC: false })
  await app.waitUntilExit()
  // a slow gh or herdr call still in flight must not keep the process, or the quit, waiting
  process.exit(process.exitCode ?? 0)
}
