import { collect } from './collect.js'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { oneLine } from './evidence.js'
import { flatten } from './format.js'
import { clearQuestions } from './model.js'
import { ok, type Out } from './out.js'
import { HerdrError } from './sources/herdr.js'
import { readPool, updateIfExists } from './store.js'
import { resolveSession } from './targets.js'

export const EXIT_SENDMESSAGE = 3
export const MAX_REPLY = 4000

// everything but newline and tab: a reply is typed into a pane, so an escape sequence must not get through
const cleanText = (s: string) => s.replace(/(?![\n\t])\p{Cc}/gu, '')

export async function reply(ctx: Ctx, query: string, text: string | undefined, markOnly: boolean, taskId?: string): Promise<Out> {
  const rows = await collect(ctx)
  const { sessionId, name } = await resolveSession(ctx, rows, query)
  const pool = readPool(ctx.orchHome, sessionId)
  const open = (pool?.tasks ?? []).filter(t => t.needsInput)
  let task
  if (taskId) {
    task = open.find(t => t.id === taskId)
    if (!task) throw new OrchError(`${name} ${taskId} has no open question`)
  } else {
    if (!open.length) throw new OrchError(`${name} has no open question`)
    if (open.length > 1) throw new OrchError(`${name} has ${open.length} open questions (${open.map(t => t.id).join(', ')}); pass --task <id>`)
    task = open[0]
  }
  const asked = task.needsInput

  if (markOnly && text) throw new OrchError('--mark-only takes no reply text', 2)
  if (!markOnly) {
    const body = cleanText(text ?? '').trim()
    if (!body) throw new OrchError('missing reply text', 2)
    if (body.length > MAX_REPLY) throw new OrchError(`the reply is ${body.length} characters; the limit is ${MAX_REPLY}, shorten it`, 2)
    const row = flatten(rows).map(l => l.row).find(r => r.sessionId === sessionId)
    if (!row || row.state === 'ended') throw new OrchError(`${name} has ended; its question stays open`)
    if (row.state === 'waiting') throw new OrchError(`${name} is waiting on a dialog (${row.waitingFor}); answer that in the session first`)
    const message = `[orch reply to: ${JSON.stringify(oneLine(asked).slice(0, 200))}] ${body}`
    if (!row.paneId) {
      // Not in herdr: /orch delivers it with SendMessage, then runs orch reply --mark-only --task.
      const payload = { route: 'sendmessage', sessionId, name, cwd: pool?.cwd ?? row.cwd, taskId: task.id, text: message }
      return { code: EXIT_SENDMESSAGE, stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    const blocked = new OrchError(`${name} is waiting on a permission prompt; answer that in its pane first`)
    // a reply from the phone should answer within one Bash call, so wait at most 90 s for the session to rest
    let state: string
    try {
      state = await ctx.herdr.waitIdle(row.paneId, 90_000)
    } catch (e) {
      // only a timeout means busy; a closed pane or a bad reply keeps herdr's own reason.
      // A timeout of the agent get that follows a successful wait lands here too, which is fine.
      if (!(e instanceof HerdrError && e.herdrCode === 'timeout')) throw e
      throw new OrchError(`${name} is still busy after 90 s; its question stays open, try again later`)
    }
    if (state === 'blocked') throw blocked
    if (state !== 'idle' && state !== 'done') throw new OrchError(`${name} is ${state}; its question stays open, try again later`)
    // the person may have answered in the session while we waited
    if (readPool(ctx.orchHome, sessionId)?.tasks.find(t => t.id === task.id)?.needsInput !== asked) {
      throw new OrchError(`${name} already answered that question in the session; nothing sent`)
    }
    try {
      await ctx.herdr.prompt(row.paneId, message)
    } catch (e) {
      // the agent can block between the wait and the prompt; herdr then refuses with agent_blocked
      if (e instanceof HerdrError && e.herdrCode === 'agent_blocked') throw blocked
      // herdr says a failed or timed-out prompt may still have arrived: never invite a blind resend
      throw new OrchError(
        `${name} may not have got the reply (${e instanceof Error ? e.message : String(e)}); ` +
          `check its pane, then run orch reply ${name} --task ${task.id} --mark-only if it arrived`,
      )
    }
  }
  await updateIfExists(ctx.orchHome, sessionId, p => clearQuestions(p, ctx.now(), task.id) ?? p)
  return ok(`answered ${name} ${task.id}\n`)
}
