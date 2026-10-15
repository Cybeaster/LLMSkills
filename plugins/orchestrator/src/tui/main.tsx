import { render } from 'ink'
import { collect } from '../collect.js'
import type { Ctx } from '../ctx.js'
import { linkSessions } from '../link.js'
import type { Row } from '../overview.js'
import { App, type Actions } from './App.js'

export async function startTui(ctx: Ctx): Promise<void> {
  const actions: Actions = {
    load: () => collect(ctx, { checks: 'live' }),
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
  const app = render(<App initial={await collect(ctx, { checks: 'live' })} actions={actions} />)
  await app.waitUntilExit()
}
