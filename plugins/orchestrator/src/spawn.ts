import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { linkSessions } from './link.js'
import { ok, type Out } from './out.js'
import { resolveSelf } from './self.js'
import { HerdrError } from './sources/herdr.js'
import { readPool } from './store.js'

export type SpawnOptions = { taskId: string; name: string; cwd: string; brief: string; prompt?: string }

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function agentName(base: string, taken: (string | undefined)[]): string {
  const b = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'child'
  let name = b
  for (let i = 2; taken.includes(name); i++) name = `${b}-${i}`
  return name
}

export async function spawnChild(ctx: Ctx, o: SpawnOptions): Promise<Out> {
  const parentId = resolveSelf(ctx)
  const parent = readPool(ctx.orchHome, parentId)
  const task = parent?.tasks.find(t => t.id === o.taskId)
  if (!parent || !task) throw new OrchError(`no task ${o.taskId} in this pool: run orch plan first`)
  const cwd = resolve(ctx.cwd, o.cwd)
  const brief = resolve(ctx.cwd, o.brief)
  if (!existsSync(cwd)) throw new OrchError(`cwd does not exist: ${cwd}`)
  if (!existsSync(brief)) throw new OrchError(`brief not found: ${brief}: write the brief first`)

  const intro =
    `You are a child session of "${parent.title || parentId}", working on its task ${task.id}: "${task.text}". ` +
    `Read ${brief} first, then run \`orch plan\` for your part and tick each task with evidence.` +
    (o.prompt ? `\n\n${o.prompt}` : '')

  if (ctx.env.HERDR_ENV !== '1' || !ctx.env.HERDR_WORKSPACE_ID) {
    const cmd = `cd ${q(cwd)} && ORCH_PARENT=${parentId} ORCH_PARENT_TASK=${task.id} ORCH_BRIEF=${q(brief)} claude --remote-control ${q(o.name)} ${q(intro)}`
    return ok(`Not inside herdr. Start the child yourself:\n${cmd}\n`)
  }

  const name = agentName(o.name, (await ctx.herdr.list()).map(a => a.name))
  const { paneId } = await ctx.herdr.createTab({ workspace: ctx.env.HERDR_WORKSPACE_ID, cwd, label: name })
  try {
    await ctx.herdr.startClaude({ name, paneId, args: ['--remote-control', name] })
  } catch (e) {
    // Observed in the Task 0 spike: in a folder Claude has never opened, the new session stops at
    // "Do you trust this folder?" and herdr reports agent_not_ready.
    const trust = e instanceof HerdrError && e.herdrCode === 'agent_not_ready'
    throw new OrchError(
      `${name} did not become ready in ${paneId} (${e instanceof Error ? e.message : String(e)}). ` +
        (trust ? `If that pane asks "Do you trust this folder?", ${cwd} has never been opened in Claude: answer it there, then run: ` : 'Once it runs, link it: ') +
        `orch link ${name} ${parentId} ${task.id}`,
    )
  }
  let childId: string | undefined
  for (let i = 0; i < 60 && !childId; i++) {
    childId = await ctx.herdr.sessionIdOf(name)
    if (!childId) await ctx.sleep(500)
  }
  if (!childId) throw new OrchError(`started ${name} in ${paneId} but could not read its session id; link it later: orch link ${name} ${parentId} ${task.id}`)
  // herdr cannot set the child's environment, so the parent writes the link before the intro goes out.
  await linkSessions(ctx, childId, parentId, task.id, { brief, byParent: true })
  await ctx.herdr.prompt(name, intro)
  return ok(`${JSON.stringify({ sessionId: childId, agent: name, paneId })}\n`)
}
