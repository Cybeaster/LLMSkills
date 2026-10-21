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

// An agent.spawn as the engine raises it for a workflow script's agent() call with no opts.model.
const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'p',
  description: 'verify:x',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  workflow: { runId: 'wf_1', agentIndex: 1 },
} as const

// turn.step streams: a hook is an async generator, and a caller reads the stream to its end.
async function drain<C, R>(s: AsyncGenerator<C, R>): Promise<R> {
  for (;;) {
    const n = await s.next()
    if (n.done) return n.value
  }
}

test('a workflow agent with no model gets the workflow model and is logged with its effort', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  let started: string | undefined
  on('agent.spawn', (_, e) => ((started = e.model), { model: e.model ?? 'inherit', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as const
  })
  await $.agent.spawn(SPAWN)
  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1, agentId: 'a1' }))
  expect(started).toBe('opus')
  expect(rows(files)).toMatchObject([{ surface: 'workflow', runId: 'wf_1', agentIndex: 1, verdict: 'filled', model: 'opus', effort: 'low' }])
  // only the agent's first step is logged
  await drain($.turn.step({ turnId: 't', index: 1, model: 'claude-opus-5-5', effort: 'low', messageCount: 3, agentId: 'a1' }))
  expect(rows(files)).toHaveLength(1)
})

test('the policy section is added when Agent is offered', async ($, on) => {
  engine(on, new Map())
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'base', scope: 'shared' }] }))
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] })
  expect(r.sections.map(s => s.id)).toEqual(['engine', 'routing:policy'])
  expect(r.sections[1]).toMatchObject({ scope: 'session', text: expect.stringMatching(/# Delegation routing/) })
  const none = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] })
  expect(none.sections).toHaveLength(1)
})
