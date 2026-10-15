import { collect } from './collect.js'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { clearQuestions } from './model.js'
import { ok, type Out } from './out.js'
import { HerdrError } from './sources/herdr.js'
import { readPool, updateIfExists } from './store.js'
import { resolveTarget } from './targets.js'

export const EXIT_SENDMESSAGE = 3

export async function reply(ctx: Ctx, query: string, text: string | undefined, markOnly: boolean): Promise<Out> {
  const row = resolveTarget(await collect(ctx), query)
  const task = readPool(ctx.orchHome, row.sessionId)?.tasks.find(t => t.needsInput)
  if (!task) throw new OrchError(`${row.name} has no open question`)

  if (!markOnly) {
    if (!text) throw new OrchError('missing reply text', 2)
    if (row.state === 'ended') throw new OrchError(`${row.name} has ended; its question stays open`)
    if (row.state === 'waiting') throw new OrchError(`${row.name} is waiting on a dialog (${row.waitingFor}); answer that in the session first`)
    const message = `[orch reply to: "${task.needsInput}"] ${text}`
    if (!row.paneId) {
      // Not in herdr: /orch delivers it with SendMessage, then runs orch reply --mark-only.
      return { code: EXIT_SENDMESSAGE, stdout: `${JSON.stringify({ route: 'sendmessage', to: row.name, text: message })}\n`, stderr: '' }
    }
    const blocked = new OrchError(`${row.name} is waiting on a permission prompt; answer that in its pane first`)
    // a reply from the phone should answer within one Bash call, so wait at most 90 s for the session to rest
    let state: string
    try {
      state = await ctx.herdr.waitIdle(row.paneId, 90_000)
    } catch (e) {
      // only a timeout means busy; a closed pane or a bad reply keeps herdr's own reason
      const timedOut = e instanceof HerdrError && (e.herdrCode === 'timeout' || /timed out/.test(e.message))
      if (!timedOut) throw e
      throw new OrchError(`${row.name} is still busy after 90 s; its question stays open, try again later`)
    }
    if (state === 'blocked') throw blocked
    try {
      await ctx.herdr.prompt(row.paneId, message)
    } catch (e) {
      // the agent can block between the wait and the prompt; herdr then refuses with agent_blocked
      if (e instanceof HerdrError && e.herdrCode === 'agent_blocked') throw blocked
      // herdr says a failed or timed-out prompt may still have arrived: never invite a blind resend
      throw new OrchError(
        `${row.name} may not have got the reply (${e instanceof Error ? e.message : String(e)}); ` +
          `check its pane, then run orch reply ${row.name} --mark-only if it arrived`,
      )
    }
  }
  await updateIfExists(ctx.orchHome, row.sessionId, p => clearQuestions(p, ctx.now(), task.id) ?? p)
  return ok(`answered ${row.name} ${task.id}\n`)
}
