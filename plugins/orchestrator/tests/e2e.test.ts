import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { readPool } from '../src/store.js'
import { makeCtx } from './helpers.js'

// DESIGN section 11: parent plans, spawns a child, the child plans and finishes, the parent task rolls up.
describe('parent and child end to end', () => {
  it('shows the parent task complete once the child has ticked its own', async () => {
    const parent = makeCtx()
    Object.assign(parent.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    mkdirSync(parent.cwd, { recursive: true })
    writeFileSync(join(parent.cwd, 'brief.md'), '# brief\n')
    expect((await run(['plan', 'fan out'], parent)).code).toBe(0)

    const spawned = await run(['spawn-child', 't1', '--name', 'kid', '--cwd', '.', '--brief', 'brief.md'], parent)
    expect(spawned.code).toBe(0)
    const childId = JSON.parse(spawned.stdout).sessionId as string
    expect(readPool(parent.orchHome, childId)).toMatchObject({ parent: { sessionId: 's-self', taskId: 't1' }, brief: join(parent.cwd, 'brief.md') })

    const status = async () => JSON.parse((await run(['status', '--all', '--json'], parent)).stdout) as { sessionId: string; complete: boolean; done: number; total: number; children: { sessionId: string; complete: boolean }[] }[]
    expect((await status())[0]).toMatchObject({ sessionId: 's-self', complete: false, done: 0, total: 1 })

    const child = makeCtx({ orchHome: parent.orchHome, claudeHome: parent.claudeHome, cwd: parent.cwd, env: { CLAUDE_SESSION_ID: childId } })
    expect((await run(['plan', 'a'], child)).code).toBe(0)
    expect((await run(['task', 'done', 't1', '--evidence', 'note:x'], child)).code).toBe(0)

    const [top] = await status()
    expect(top).toMatchObject({ sessionId: 's-self', complete: true, done: 1, total: 1 })
    expect(top.children).toMatchObject([{ sessionId: childId, complete: true }])
  })
})
