import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { oneLine } from './evidence.js'
import { linkSessions } from './link.js'
import { ok, type Out } from './out.js'
import { briefFile, workDir } from './paths.js'
import { EFFORTS, spawnDefaults } from './routing.js'
import { resolveSelf } from './self.js'
import { HerdrError } from './sources/herdr.js'
import { readPool } from './store.js'

export type SpawnOptions = { taskId: string; name: string; cwd: string; brief: string; prompt?: string; model?: string; effort?: string }

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Long enough for a slow start, short enough that a hung herdr does not hold the session for minutes.
export const SESSION_ID_WAIT_MS = 60_000
const POLL_MS = 500

export function agentName(base: string, taken: (string | undefined)[]): string {
  const b = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'child'
  let name = b
  for (let i = 2; taken.includes(name); i++) name = `${b}-${i}`
  return name
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function spawnChild(ctx: Ctx, o: SpawnOptions): Promise<Out> {
  const parentId = resolveSelf(ctx)
  const parent = readPool(ctx.orchHome, parentId)
  const task = parent?.tasks.find(t => t.id === o.taskId)
  if (!parent || !task) throw new OrchError(`no task ${o.taskId} in this pool: run orch plan first`)
  const cwd = workDir(ctx, o.cwd)
  const brief = briefFile(ctx, o.brief)
  const defaults = spawnDefaults(ctx)
  const model = o.model || defaults.model
  const effort = o.effort || defaults.effort
  if (!EFFORTS.includes(effort)) throw new OrchError(`--effort must be one of ${EFFORTS.join(', ')}`)
  const runAs = ['--model', model, '--effort', effort]

  const intro =
    `You are a child session of "${oneLine(parent.title) || parentId}", working on its task ${task.id}: "${oneLine(task.text)}". ` +
    `Read ${brief} first, then run \`orch plan\` for your part and tick each task with evidence.` +
    (o.prompt ? `\n\n${o.prompt}` : '')
  // what is printed for a person to paste, and what herdr gets as one prompt: never a control character or a newline
  const shown = oneLine(intro)

  if (ctx.env.HERDR_ENV !== '1' || !ctx.env.HERDR_WORKSPACE_ID) {
    const name = agentName(o.name, [])
    const cmd = `cd ${q(oneLine(cwd))} && ORCH_PARENT=${parentId} ORCH_PARENT_TASK=${task.id} ORCH_BRIEF=${q(oneLine(brief))} claude --remote-control=${q(name)} --model ${q(model)} --effort ${q(effort)} ${q(shown)}`
    return ok(`Not inside herdr. Start the child yourself:\n${cmd}\n`)
  }

  const name = agentName(o.name, (await ctx.herdr.list()).map(a => a.name))
  const { paneId } = await ctx.herdr.createTab({ workspace: ctx.env.HERDR_WORKSPACE_ID, cwd, label: name })
  const linkCmd = (who: string) => `orch link ${who} ${parentId} ${task.id} --brief ${q(oneLine(brief))}`
  const promptCmd = (target: string) => `herdr agent prompt ${target} ${q(shown)}`
  const noId = `If that says the session has no id yet, run orch status --all and link by its id.`
  try {
    await ctx.herdr.startClaude({ name, paneId, args: ['--remote-control', name, ...runAs] })
  } catch (e) {
    // Observed in the Task 0 spike: in a folder Claude has never opened, the new session stops at
    // "Do you trust this folder?" and herdr reports agent_not_ready.
    const trust = e instanceof HerdrError && e.herdrCode === 'agent_not_ready'
    throw new OrchError(
      `${name} did not become ready in ${paneId} (${why(e)}). ` +
        (trust ? `If that pane asks "Do you trust this folder?", ${cwd} has never been opened in Claude: answer it there. ` : '') +
        `Once it runs, link it: ${linkCmd(name)} ; then send its intro: ${promptCmd(paneId)} . ${noId}`,
    )
  }
  let childId: string | undefined
  const deadline = ctx.now() + SESSION_ID_WAIT_MS
  for (;;) {
    childId = await ctx.herdr.sessionIdOf(name)
    if (childId || ctx.now() >= deadline) break
    await ctx.sleep(POLL_MS)
  }
  if (!childId)
    throw new OrchError(
      `started ${name} in ${paneId} but herdr did not report its session id within ${SESSION_ID_WAIT_MS / 1000}s. ` +
        `Link it later: ${linkCmd(name)} ; then send its intro: ${promptCmd(name)} . ${noId}`,
    )
  // herdr cannot set the child's environment, so the parent writes the link before the intro goes out.
  try {
    await linkSessions(ctx, childId, parentId, task.id, { brief, byParent: true })
  } catch (e) {
    throw new OrchError(`${name} runs in ${paneId} (session ${childId}) but linking failed: ${why(e)}. Link it: ${linkCmd(q(childId))} ; then send its intro: ${promptCmd(name)}`)
  }
  try {
    await ctx.herdr.prompt(name, shown)
  } catch (e) {
    throw new OrchError(`${name} is linked under ${parentId} ${task.id}, but sending its intro failed (${why(e)}). Send it yourself: ${promptCmd(name)}`)
  }
  return ok(`${JSON.stringify({ sessionId: childId, agent: name, paneId })}\n`)
}
