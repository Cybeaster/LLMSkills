import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { linkChild, newPool, setParent, unlinkChild } from './model.js'
import { readPool, update, updateIfExists } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

export type LinkOptions = {
  brief?: string
  byParent?: boolean // the parent session itself is linking (spawn-child, its own orch link): an own write
}

export async function linkSessions(ctx: Ctx, childId: string, parentId: string, taskId: string, opts: LinkOptions = {}): Promise<void> {
  if (childId === parentId) throw new OrchError('a session cannot be its own parent')
  // walking up from the new parent must not reach the child, or the two would form a cycle;
  // an unreadable ancestor ends the walk instead of failing the link
  const parentOf = (id: string) => {
    try {
      return readPool(ctx.orchHome, id)?.parent?.sessionId
    } catch {
      return undefined
    }
  }
  for (let id = parentOf(parentId), n = 0; id && n < 64; id = parentOf(id), n++)
    if (id === childId) throw new OrchError('that parent sits below this session; linking it would make a cycle')
  if (!readPool(ctx.orchHome, parentId)?.tasks.some(t => t.id === taskId)) throw new OrchError(`the parent has no task ${taskId}`)
  const now = ctx.now()
  const previous = readPool(ctx.orchHome, childId)?.parent
  const cwd = readLiveSessions(ctx.claudeHome, ctx.isAlive).find(s => s.sessionId === childId)?.cwd ?? ''
  await update(ctx.orchHome, childId, p => setParent(p ?? newPool(childId, cwd, now), { sessionId: parentId, taskId }, opts.brief, now))
  if (previous && (previous.sessionId !== parentId || previous.taskId !== taskId))
    await updateIfExists(ctx.orchHome, previous.sessionId, p => unlinkChild(p, previous.taskId, childId, now))
  await updateIfExists(ctx.orchHome, parentId, p => linkChild(p, taskId, childId, now, opts.byParent))
}
