import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { linkChild, newPool, setParent, unlinkChild } from './model.js'
import { log, readPool, update, updateIfExists } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

export type LinkOptions = {
  brief?: string
  byParent?: boolean // the parent session itself is linking (spawn-child, its own orch link): an own write
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
  let previous
  try {
    previous = readPool(ctx.orchHome, childId)?.parent
  } catch {
    // an unreadable child pool fails the write below, with the message to rerun
  }
  const cwd = readLiveSessions(ctx.claudeHome, ctx.isAlive).find(s => s.sessionId === childId)?.cwd ?? ''

  // Order matters for a crash or a failure half way: the new parent lists the child first (that also
  // re-checks the task under the lock), then the child points at it, and only then is the old parent let go.
  // A failure before the last step leaves a state that rerunning the same link repairs.
  try {
    const linked = await updateIfExists(ctx.orchHome, parentId, p => linkChild(p, taskId, childId, now, opts.byParent))
    if (!linked) throw new OrchError(`the parent has no pool`)
    await update(ctx.orchHome, childId, p => setParent(p ?? newPool(childId, cwd, now), { sessionId: parentId, taskId }, opts.brief, now))
  } catch (e) {
    throw new OrchError(`${why(e)}; rerun orch link`)
  }
  if (previous && (previous.sessionId !== parentId || previous.taskId !== taskId)) {
    try {
      await updateIfExists(ctx.orchHome, previous.sessionId, p => unlinkChild(p, previous.taskId, childId, now))
    } catch (e) {
      log(ctx.orchHome, `link: could not unlink ${childId} from ${previous.sessionId} ${previous.taskId}: ${why(e)}`)
    }
  }
}
