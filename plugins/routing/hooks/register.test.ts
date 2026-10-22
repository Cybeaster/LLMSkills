import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A relative key ('.claude/routing.json') stands for that file under whatever working directory the engine resolved.
const lookup = (files: Map<string, string>, path: string) =>
  files.get(path) ?? [...files].find(([k]) => !k.startsWith('/') && path.endsWith(`/${k}`))?.[1]

// Stands for the engine beneath the plugin: an in-memory disk, HOME, a session id, a project root when
// given, and an Agent tool that succeeds. `policy: null` makes the plugin's own policy.json unreadable.
// `hold` keeps the Agent tool running until it resolves, as a real call runs while its agent starts.
function engine(on: On, files: Map<string, string>, opts: { root?: string; policy?: string | null; hold?: (tool_use_id: string) => Promise<void> } = {}) {
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 's1' }))
  const { root } = opts
  if (root !== undefined) on('session.root', () => ({ value: root }))
  on('fs.exists', (_, e) => ({ value: lookup(files, e.path) !== undefined || e.path.endsWith('/policy.json') }))
  on('fs.read', (_, e) => {
    const hit = lookup(files, e.path)
    if (hit === undefined && opts.policy === null) throw new Error('EACCES')
    return { value: hit ?? opts.policy ?? POLICY }
  })
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('tool.call', async (_, e) => (await opts.hold?.(e.tool_use_id), { result: { agentId: 'a0' } }))
}

const SPAWN_BASE = { provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as const

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

test('the project file is read from the session root, not only the working directory', async ($, on) => {
  const files = new Map([['/proj/.claude/routing.json', JSON.stringify({ classes: { search: { model: 'opus' } } })]])
  engine(on, files, { root: '/proj' })
  const r = await $.tool.call({ tool: 'Agent', description: '[search] x', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toMatch(/needs model opus/)
})

test('an unreadable plugin policy fails open: the Agent call still runs, unlogged', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files, { policy: null })
  const r = await $.tool.call({ tool: 'Agent', description: 'no tag at all', prompt: 'p' })
  expect(r.deny).toBeUndefined()
  expect(r.isError).toBeFalsy()
  expect(rows(files)).toEqual([])
})

test('a fork runs untagged and is logged as exempt', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  const r = await $.tool.call({ tool: 'Agent', description: 'carry on', prompt: 'p', subagent_type: 'fork' })
  expect(r.deny).toBeUndefined()
  expect(rows(files)).toMatchObject([{ surface: 'agent', verdict: 'exempt', subagentType: 'fork', outcome: 'ok' }])
})

// Another plugin's programmatic call: the host refuses `Agent` from a plugin's $.tool.call but lets the
// `Task` alias through, which the { tool: 'Agent' } matcher admits, with next.origin naming that plugin.
const OTHER = {
  name: 'other',
  register(on: On) {
    on('command.run', async ($, e) => {
      const r = await $.tool.call({ tool: 'Task', description: 'no tag', prompt: 'p' } as never)
      return { text: r.deny ?? (r.isError ? 'error' : 'ran') }
    })
  },
}

test("another plugin's Agent call passes untagged, with no row", { plugins: [OTHER] }, async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  const r = await $.command.run({ name: 'go', args: '' } as never)
  expect(r).toMatchObject({ text: 'ran' })
  expect(rows(files)).toEqual([])
})

// Another plugin's programmatic spawn: its agent's prompt is that plugin's own, never prefixed.
const SPAWNER = {
  name: 'spawner',
  register(on: On) {
    on('command.run', async ($) => {
      await $.agent.spawn({ prompt: 'exact spec', description: 'x' } as never)
      return { text: 'spawned' }
    })
  },
}

test("another plugin's spawn keeps its prompt", { plugins: [SPAWNER] }, async ($, on) => {
  engine(on, new Map())
  let seen: string | undefined
  on('agent.spawn', (_, e) => ((seen = e.prompt), { model: 'haiku', agentId: 'a9' }))
  await $.command.run({ name: 'go', args: '' } as never)
  expect(seen).toBe('exact spec')
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

test('a workflow agent is logged at spawn, and its effort as a second row on its first step', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  let started: string | undefined
  on('agent.spawn', (_, e) => ((started = e.model), { model: e.model ?? 'inherit', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as const
  })
  await $.agent.spawn(SPAWN)
  expect(started).toBe('opus')
  expect(rows(files)).toMatchObject([{ surface: 'workflow', runId: 'wf_1', agentIndex: 1, verdict: 'filled', model: 'opus', agentId: 'a1' }])
  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1, agentId: 'a1' }))
  const [, second] = rows(files)
  expect(second).toEqual({ ts: expect.any(String), surface: 'workflow', agentId: 'a1', verdict: 'effort', effort: 'low' })
  // only the agent's first step is logged
  await drain($.turn.step({ turnId: 't', index: 1, model: 'claude-opus-5-5', effort: 'low', messageCount: 3, agentId: 'a1' }))
  expect(rows(files)).toHaveLength(2)
})

test('a remote workflow agent, which never steps, still has its spawn row', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: 'r1' }))
  await $.agent.spawn({ ...SPAWN, model: 'fable' })
  expect(rows(files)).toMatchObject([{ surface: 'workflow', verdict: 'allow', model: 'fable', agentId: 'r1' }])
  expect(rows(files)).toHaveLength(1)
})

test('a denied workflow spawn is logged as deny', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  on('agent.spawn', () => ({ deny: 'no room' }))
  const r = await $.agent.spawn(SPAWN)
  expect(r.deny).toBe('no room')
  expect(rows(files)).toMatchObject([{ surface: 'workflow', runId: 'wf_1', verdict: 'deny', reason: 'no room' }])
  expect(rows(files)).toHaveLength(1)
})

test('a spawn outside a workflow passes through with no row', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  let started: string | undefined
  on('agent.spawn', (_, e) => ((started = e.model), { model: e.model ?? 'inherit', agentId: 'a2' }))
  const { workflow: _, ...plain } = SPAWN
  await $.agent.spawn(plain)
  expect(started).toBeUndefined()
  expect(rows(files)).toEqual([])
})

test('agents awaiting their first step are capped, the oldest dropped', { timeoutMs: 30000 }, async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  let n = 0
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: `w${n++}` }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as const
  })
  for (let i = 0; i <= 500; i++) await $.agent.spawn(SPAWN)
  const step = (agentId: string) => drain($.turn.step({ turnId: 't', index: 0, model: 'm', effort: 'high', messageCount: 1, agentId }))
  await step('w0')
  await step('w500')
  expect(rows(files).filter(r => r.verdict === 'effort').map(r => r.agentId)).toEqual(['w500'])
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

// An Agent call whose tool starts its agent mid-call, as the real one does, under the call's tool_use_id.
// A hook beneath the plugin may not call $.agent.spawn itself, so the tool holds while the test raises it.
function agentCalls(on: On) {
  const waiting: { id: string; go: () => void }[] = []
  let seen: () => void = () => {}
  engine(on, new Map(), { hold: id => new Promise<void>(go => (waiting.push({ id, go }), seen())) })
  return async ($: { tool: { call: (i: never) => Promise<{ deny?: string }> }; agent: { spawn: (i: never) => Promise<unknown> } }, call: { description: string; prompt: string; model?: string; effort?: string; subagent_type?: string }) => {
    const arrived = new Promise<void>(r => (seen = r))
    const ran = $.tool.call({ tool: 'Agent', ...call } as never)
    await arrived
    const w = waiting.shift()!
    const fork = call.subagent_type === 'fork'
    await $.agent.spawn({ ...SPAWN_BASE, tool_use_id: w.id, prompt: call.prompt, description: call.description, model: call.model, subagentType: call.subagent_type ?? 'general-purpose', fork } as never)
    w.go()
    return ran
  }
}

// what the agent beneath the plugin was started with
function spawned(on: On) {
  const got: { prompt?: string; model?: string }[] = []
  on('agent.spawn', (_, e) => (got.push({ prompt: e.prompt, model: e.model }), { model: e.model ?? 'inherit', agentId: `g${got.length}` }))
  return got
}

test('a tagged Agent spawn is told its class, model, effort and the floors', async ($, on) => {
  const agentCall = agentCalls(on)
  const got = spawned(on)
  const r = await agentCall($, { description: '[search] find callers', prompt: 'TASK', model: 'haiku', effort: 'low' })
  expect(r.deny).toBeUndefined()
  expect(got).toHaveLength(1)
  const lines = (got[0]?.prompt ?? '').split('\n')
  expect(lines[0]).toBe("[routing] Requested as [search] on haiku at effort low. Size the work to that budget.")
  expect(lines[1]).toMatch(/follow these floors/)
  expect(lines[2]).toBe('search haiku/low · content opus/xhigh')
  expect(lines.slice(3)).toEqual(['', 'TASK'])
})

test('a workflow agent gets the header with its filled model and no effort', async ($, on) => {
  engine(on, new Map())
  const got = spawned(on)
  await $.agent.spawn(SPAWN)
  expect(got[0]?.model).toBe('opus')
  expect(got[0]?.prompt).toMatch(/^\[routing\] Requested as unclassified on opus\. Size the work/)
  expect(got[0]?.prompt).toMatch(/\nsearch haiku\/low · content opus\/xhigh\n\np$/)
  await $.agent.spawn({ ...SPAWN, description: '[content] lesson 3', model: 'fable' })
  expect(got[1]?.prompt).toMatch(/^\[routing\] Requested as \[content\] on fable\. Size/)
})

test('a fork and a resume start with their prompt untouched', async ($, on) => {
  const agentCall = agentCalls(on)
  const got = spawned(on)
  await agentCall($, { description: 'carry on', prompt: 'FORK', subagent_type: 'fork' })
  await $.agent.spawn({ ...SPAWN_BASE, tool_use_id: 'tu9', prompt: 'RESUME', description: '[search] x', subagentType: 'Explore', resume: { agentId: 'old' } } as never)
  expect(got.map(g => g.prompt)).toEqual(['FORK', 'RESUME'])
})

test('a spawn with no Agent call behind it is unclassified on an inherited model', async ($, on) => {
  engine(on, new Map())
  const got = spawned(on)
  await $.agent.spawn({ ...SPAWN_BASE, tool_use_id: 'tu7', prompt: 'X', description: 'plain', subagentType: 'general-purpose' } as never)
  expect(got[0]?.prompt).toMatch(/^\[routing\] Requested as unclassified on inherited\. Size/)
})
