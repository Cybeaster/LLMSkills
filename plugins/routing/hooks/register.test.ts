import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A relative key ('.claude/routing.json') stands for that file under whatever working directory the engine resolved.
const lookup = (files: Map<string, string>, path: string) =>
  files.get(path) ?? [...files].find(([k]) => !k.startsWith('/') && path.endsWith(`/${k}`))?.[1]

// Stands for the engine beneath the plugin: an in-memory disk, HOME, a session id, and an Agent tool that succeeds.
function engine(on: On, files: Map<string, string>) {
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', (_, e) => ({ value: lookup(files, e.path) !== undefined || e.path.endsWith('/policy.json') }))
  on('fs.read', (_, e) => ({ value: lookup(files, e.path) ?? POLICY }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('tool.call', () => ({ result: { agentId: 'a0' } }))
}

const POLICY = JSON.stringify({
  classes: { search: { model: 'haiku', effort: 'low' }, content: { model: 'opus', effort: 'xhigh' } },
  spawn: { model: 'opus', effort: 'xhigh' },
  workflowModel: 'opus',
})

const rows = (files: Map<string, string>) =>
  [...files].filter(([p]) => p.includes('/.claude/state/routing/')).flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))

test('an untagged Agent call is denied and logged', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  const r = await $.tool.call({ tool: 'Agent', description: 'find callers', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toMatch(/^routing: description has no \[class\] tag/)
  expect(rows(files)).toMatchObject([{ surface: 'agent', verdict: 'deny', model: 'haiku' }])
  expect([...files.keys()].filter(p => p.includes('/state/'))).toEqual([expect.stringMatching(/^\/home\/t\/\.claude\/state\/routing\/\d{4}-\d\d-\d\d-s1\.jsonl$/)])
})

test('a tagged call at the floor runs and is logged', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  const r = await $.tool.call({ tool: 'Agent', description: '[search] find callers', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toBeUndefined()
  expect(rows(files)).toMatchObject([{ surface: 'agent', cls: 'search', verdict: 'allow', outcome: 'ok' }])
})

test('[content] on sonnet is denied', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  const r = await $.tool.call({ tool: 'Agent', description: '[content] lesson', prompt: 'p', model: 'sonnet', effort: 'xhigh' })
  expect(r.deny).toMatch(/needs model opus/)
})

test('a project file raises a floor', async ($, on) => {
  const files = new Map([['.claude/routing.json', JSON.stringify({ classes: { search: { model: 'opus' } } })]])
  engine(on, files)
  const r = await $.tool.call({ tool: 'Agent', description: '[search] x', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toMatch(/needs model opus/)
})
