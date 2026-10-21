# routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `routing` plugin described in `DESIGN.md` (a model + effort policy for delegated work, enforced on `Agent` calls, logged for workflow agents, shown to Claude as a generated system-prompt section) and teach `orch spawn-child` to start children on the policy's spawn model and effort.

**Architecture:** A Claude Code hooks module (mod) at `plugins/routing/hooks/register.ts` wires four events (`tool.call` on `Agent`, `agent.spawn`, `turn.step`, `prompt.compose`) to pure functions in `hooks/policy.ts` (ladders, layered merge, floor check, rendered text) and `hooks/log.ts` (append-only JSONL through `$.fs`). The default table is `plugins/routing/policy.json`; user and project files layer over it. orch gets `--model`/`--effort` on `spawn-child` with defaults read from `~/.claude/routing/policy.json`.

**Tech Stack:** Claude Code hooks module API (CLI 2.1.306; types at the path the `plugin-authoring` skill prints, `claude-code` / `claude-code/testing`), `claude plugin validate` / `claude plugin test`; orch: TypeScript 5.9, vitest, esbuild.

**Repo and paths.** Everything is relative to `~/src/ClaudeSkills/.worktrees/routing` (branch `routing`, created from `main`). Never touch `~/src/ItAbyss`. Commit messages follow the repo's style (short sentence-case imperative) and end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012jFDQdFBiyEpNzLNAeyM7n
```

**Before Task 1:** load the `plugin-authoring` skill (it prints this build's types path, `$TYPES` below). Mod API facts this plan relies on, all checked in that file: `tool.call` hooks return `{ deny }` or `next(e)`; `agent.spawn` input has `model?`, `description`, `subagentType`, `fork`, `workflow?: { runId, agentIndex }`, `resume?`, and resolves `{ model, agentId }` or `{ deny }`; `turn.step` input has `model`, `effort?`, `agentId?`; `prompt.compose` resolves `{ sections: { id, text, scope }[] }` and its input has `tools`; `$.fs.read/write/exists`, `$.env.get(name)`, `$.plugin.root`. In tests, a call on `$` (`$.fs.read`, `$.env.get`) is answered by an `on('<noun>.<method>', …)` hook returning `{ value }`. **Step 0 of Task 4:** grep `$TYPES` for `'fs.read':`, `'fs.write':`, `'fs.exists':`, `'env.get':` and use the input field names it shows if they differ from `path` / `text` / `name`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `plugins/routing/.claude-plugin/plugin.json` | manifest |
| `plugins/routing/hooks/hooks.json` | `{ "modules": ["./register.ts"] }` |
| `plugins/routing/policy.json` | the default table, spawn floor, workflow default model |
| `plugins/routing/hooks/policy.ts` | pure: ladders, `rank`, `merge`, `check`, `ruleText`, `denyText` |
| `plugins/routing/hooks/log.ts` | pure-ish: `logPath`, `makeLogger` over an injected fs |
| `plugins/routing/hooks/register.ts` | event wiring, policy loading |
| `plugins/routing/hooks/policy.test.ts`, `log.test.ts`, `register.test.ts` | `claude plugin test` suites |
| `plugins/routing/README.md` | what it does, how to read the log, how to override |
| `.claude-plugin/marketplace.json`, `README.md` | list the plugin |
| `plugins/orchestrator/src/routing.ts` | `spawnDefaults(ctx)` |
| `plugins/orchestrator/src/spawn.ts`, `src/cli.ts` | `--model` / `--effort` |
| `plugins/orchestrator/tests/spawn.test.ts` | spawn flag + default tests |
| `~/.claude/skills/herdr-spawn-rc/SKILL.md` | point at the spawn default (user-level, not in the repo) |

---

### Task 1: Scaffold the plugin

**Files:**
- Create: `plugins/routing/.claude-plugin/plugin.json`, `plugins/routing/hooks/hooks.json`, `plugins/routing/policy.json`, `plugins/routing/hooks/register.ts`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Manifest, hooks file, policy**

`plugins/routing/.claude-plugin/plugin.json`:
```json
{
  "name": "routing",
  "version": "0.1.0",
  "description": "Picks the model and effort for delegated work by task class: holds Agent calls to the policy, logs workflow agents, and shows Claude the table.",
  "author": { "name": "Cybeaster", "email": "cybeastermail@gmail.com" }
}
```

`plugins/routing/hooks/hooks.json`:
```json
{ "modules": ["./register.ts"] }
```

`plugins/routing/policy.json`:
```json
{
  "classes": {
    "search": { "model": "haiku", "effort": "low", "what": "grep sweeps, finding files, reading logs" },
    "mechanical": { "model": "haiku", "effort": "medium", "what": "renames, applying a known fix, bulk reformatting" },
    "implement": { "model": "opus", "effort": "high", "what": "writing code from a clear plan or spec" },
    "content": { "model": "opus", "effort": "xhigh", "what": "course lessons, interview questions, RU/EN prose" },
    "review": { "model": "fable", "effort": "xhigh", "what": "code review, audits, adversarial verification of findings" },
    "design": { "model": "fable", "effort": "xhigh", "what": "specs, root-cause debugging, trade-offs" },
    "research": { "model": "opus", "effort": "high", "what": "web or docs research with synthesis" }
  },
  "spawn": { "model": "opus", "effort": "xhigh" },
  "workflowModel": "opus"
}
```

`plugins/routing/hooks/register.ts` (placeholder module so validate has something to read; Task 4 replaces it):
```ts
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

- [ ] **Step 2: List it in the marketplace**

Add to the `plugins` array of `.claude-plugin/marketplace.json`, after `orchestrator`:
```json
    {
      "name": "routing",
      "source": "./plugins/routing",
      "description": "Picks the model and effort for delegated work by task class, enforces it on Agent calls, and logs every choice."
    }
```

- [ ] **Step 3: Validate**

Run: `claude plugin validate plugins/routing`
Expected: no errors; it reports the module and no hooks.

- [ ] **Step 4: Commit**

```bash
git add plugins/routing .claude-plugin/marketplace.json
git commit -m "Scaffold the routing plugin"
```

---

### Task 2: Ladders, merge and the floor check

**Files:**
- Create: `plugins/routing/hooks/policy.ts`
- Test: `plugins/routing/hooks/policy.test.ts`

- [ ] **Step 1: Write the failing tests**

`plugins/routing/hooks/policy.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { check, merge, rank, MODELS, EFFORTS, type Policy } from './policy.ts'

const P: Policy = {
  classes: {
    search: { model: 'haiku', effort: 'low' },
    content: { model: 'opus', effort: 'xhigh' },
    review: { model: 'fable', effort: 'xhigh' },
  },
  spawn: { model: 'opus', effort: 'xhigh' },
  workflowModel: 'opus',
}

test('rank reads aliases, ids and context suffixes', async () => {
  expect(rank(MODELS, 'haiku')).toBe(0)
  expect(rank(MODELS, 'claude-opus-5-5')).toBe(2)
  expect(rank(MODELS, 'fable[1m]')).toBe(3)
  expect(rank(MODELS, undefined)).toBe(-1)
  expect(rank(EFFORTS, 'xhigh')).toBe(3)
})

test('a call without a tag is denied', async () => {
  const v = check(P, { description: 'find callers', model: 'haiku', effort: 'low' })
  expect(v.ok).toBe(false)
  expect(!v.ok && v.reason).toMatch(/no \[class\] tag/)
})

test('an unknown tag is denied', async () => {
  expect(check(P, { description: '[misc] x', model: 'opus', effort: 'high' }).ok).toBe(false)
})

test('missing model or effort is denied', async () => {
  expect(check(P, { description: '[search] x', effort: 'low' }).ok).toBe(false)
  expect(check(P, { description: '[search] x', model: 'haiku' }).ok).toBe(false)
})

test('below the floor is denied, at or above passes', async () => {
  expect(check(P, { description: '[review] diff', model: 'opus', effort: 'xhigh' }).ok).toBe(false)
  expect(check(P, { description: '[review] diff', model: 'fable', effort: 'high' }).ok).toBe(false)
  expect(check(P, { description: '[review] diff', model: 'fable', effort: 'xhigh' })).toEqual({ ok: true, cls: 'review', override: false })
  expect(check(P, { description: '[search] x', model: 'opus', effort: 'high' }).ok).toBe(true)
})

test('content on sonnet is denied', async () => {
  const v = check(P, { description: '[content] lesson 3', model: 'sonnet', effort: 'xhigh' })
  expect(!v.ok && v.reason).toMatch(/needs model opus/)
})

test('max needs [override]', async () => {
  expect(check(P, { description: '[review] x', model: 'fable', effort: 'max' }).ok).toBe(false)
  expect(check(P, { description: '[review] [override] x', model: 'fable', effort: 'max' }).ok).toBe(true)
})

test('[override] lets a call go below its floor', async () => {
  expect(check(P, { description: '[content] [override] x', model: 'sonnet', effort: 'low' })).toEqual({ ok: true, cls: 'content', override: true })
})

test('fork is exempt', async () => {
  expect(check(P, { description: 'anything', subagent_type: 'fork' })).toEqual({ ok: true, override: false, exempt: true })
})

test('layers override per field', async () => {
  const m = merge(P, { classes: { search: { model: 'opus' } } }, undefined, { spawn: { effort: 'high' } })
  expect(m.classes.search).toEqual({ model: 'opus', effort: 'low' })
  expect(m.classes.review).toEqual(P.classes.review)
  expect(m.spawn).toEqual({ model: 'opus', effort: 'high' })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugins/routing`
Expected: FAIL, `./policy.ts` cannot be resolved.

- [ ] **Step 3: Implement**

`plugins/routing/hooks/policy.ts`:
```ts
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Floor = { model: string; effort: string; what?: string }
export type Policy = { classes: Record<string, Floor>; spawn: Floor; workflowModel: string }
export type Layer = { classes?: Record<string, Partial<Floor>>; spawn?: Partial<Floor>; workflowModel?: string }
export type Call = { description?: string; model?: string; effort?: string; subagent_type?: string }
export type Verdict =
  | { ok: true; cls?: string; override: boolean; exempt?: true }
  | { ok: false; cls?: string; reason: string }

const TAG = /^\s*\[([a-z]+)\]/
const OVERRIDE = /\[override\]/

// 'claude-opus-5-5' and 'fable[1m]' rank as 'opus' and 'fable'; -1 is missing or unknown
export function rank(ladder: readonly string[], v: string | undefined): number {
  if (!v) return -1
  return ladder.indexOf(v.toLowerCase().replace(/^claude-/, '').split(/[-[]/)[0])
}

export function merge(base: Policy, ...layers: (Layer | undefined)[]): Policy {
  let p = base
  for (const l of layers) {
    if (!l) continue
    const classes = { ...p.classes }
    for (const [k, v] of Object.entries(l.classes ?? {})) classes[k] = { ...classes[k], ...v } as Floor
    p = { classes, spawn: { ...p.spawn, ...l.spawn }, workflowModel: l.workflowModel ?? p.workflowModel }
  }
  return p
}

export function check(p: Policy, c: Call): Verdict {
  if (c.subagent_type === 'fork') return { ok: true, override: false, exempt: true }
  const desc = c.description ?? ''
  const cls = TAG.exec(desc)?.[1]
  if (!cls) return { ok: false, reason: 'description has no [class] tag' }
  const f = p.classes[cls]
  if (!f) return { ok: false, cls, reason: `[${cls}] is not a class` }
  const m = rank(MODELS, c.model)
  const e = rank(EFFORTS, c.effort)
  if (m < 0) return { ok: false, cls, reason: `model is ${c.model ? `unknown (${c.model})` : 'missing'}` }
  if (e < 0) return { ok: false, cls, reason: `effort is ${c.effort ? `unknown (${c.effort})` : 'missing'}` }
  if (OVERRIDE.test(desc)) return { ok: true, cls, override: true }
  if (m < rank(MODELS, f.model)) return { ok: false, cls, reason: `[${cls}] needs model ${f.model} or stronger, got ${c.model}` }
  if (e < rank(EFFORTS, f.effort)) return { ok: false, cls, reason: `[${cls}] needs effort ${f.effort} or higher, got ${c.effort}` }
  if (c.effort === 'max') return { ok: false, cls, reason: 'effort max needs [override]: use it only when the user asked for max' }
  return { ok: true, cls, override: false }
}
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test plugins/routing`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/routing/hooks/policy.ts plugins/routing/hooks/policy.test.ts
git commit -m "Check Agent calls against the class floors"
```

---

### Task 3: The rendered text and the log

**Files:**
- Modify: `plugins/routing/hooks/policy.ts`
- Create: `plugins/routing/hooks/log.ts`
- Test: `plugins/routing/hooks/policy.test.ts`, `plugins/routing/hooks/log.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/routing/hooks/policy.test.ts` (and add `ruleText, denyText` to its import):
```ts
test('the rule text carries every class, the spawn floor and the workflow rule', async () => {
  const t = ruleText(P)
  expect(t).toMatch(/\| `\[search\]` \| haiku \| low \|/)
  expect(t).toMatch(/\| `\[review\]` \| fable \| xhigh \|/)
  expect(t).toMatch(/opus \/ xhigh/)
  expect(t).toMatch(/opts\.model.*opts\.effort/)
  expect(t).toMatch(/\[override\]/)
})

test('the deny text says why and shows the table', async () => {
  const t = denyText(P, 'description has no [class] tag')
  expect(t).toMatch(/^routing: description has no \[class\] tag/)
  expect(t).toMatch(/\| `\[content\]` \| opus \| xhigh \|/)
})
```

`plugins/routing/hooks/log.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { logPath, makeLogger } from './log.ts'

test('one file per session per day', async () => {
  expect(logPath('/h', new Date('2026-10-22T10:00:00Z'), 'ab12')).toBe('/h/.claude/state/routing/2026-10-22-ab12.jsonl')
})

test('rows append in order, one JSON line each', async () => {
  const files = new Map<string, string>()
  const fs = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p) ?? '',
    write: async (p: string, t: string) => void files.set(p, t),
  }
  const log = makeLogger(fs, async () => '/x.jsonl')
  await Promise.all([log({ n: 1 }), log({ n: 2 })])
  await log({ n: 3 })
  expect(files.get('/x.jsonl')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
})

test('a failing write never throws to the caller', async () => {
  const fs = { exists: async () => false, read: async () => '', write: async () => { throw new Error('EACCES') } }
  await makeLogger(fs, async () => '/x')({ n: 1 })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugins/routing`
Expected: FAIL, `ruleText` / `./log.ts` missing.

- [ ] **Step 3: Implement**

Append to `plugins/routing/hooks/policy.ts`:
```ts
export function table(p: Policy): string {
  const rows = Object.entries(p.classes).map(([k, f]) => `| \`[${k}]\` | ${f.model} | ${f.effort} | ${f.what ?? ''} |`)
  return ['| Tag | Model (min) | Effort (min) | For |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

export function ruleText(p: Policy): string {
  return [
    '# Delegation routing',
    'This is the explicit instruction the Agent tool\'s `effort` parameter asks for: every delegation names its model and effort from this table.',
    '- **Agent tool:** start `description` with one class tag, then pass `model` and `effort` at or above that class\'s minimum. Stronger is always allowed; weaker is denied. `subagent_type: "fork"` is exempt.',
    table(p),
    `- **Workflow scripts:** every \`agent()\` call passes \`opts.model\` and \`opts.effort\` from the same table (a missing model becomes ${p.workflowModel}).`,
    `- **Spawned sessions** (\`orch spawn-child\`, herdr): ${p.spawn.model} / ${p.spawn.effort} unless the user names a model. orch applies it; for a bare herdr start pass \`-- --model ${p.spawn.model} --effort ${p.spawn.effort}\`.`,
    '- **[override]** after the tag lets a call go below its minimum or use `max`. Add it only when the user explicitly asked for that model or effort; it is logged.',
    '- **Escalation:** when a delegated result fails verification (tests red, reviewer rejects), retry once one step up in model or effort, never past fable / xhigh unless the user asks.',
  ].join('\n')
}

export function denyText(p: Policy, reason: string): string {
  return `routing: ${reason}. Retry with a class tag at the start of \`description\` and \`model\` + \`effort\` at or above its minimum:\n${table(p)}`
}
```

`plugins/routing/hooks/log.ts`:
```ts
export type Fs = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

export const logPath = (home: string, now: Date, sid: string) =>
  `${home}/.claude/state/routing/${now.toISOString().slice(0, 10)}-${sid}.jsonl`

// $.fs has no append: rows go through one queue so two hooks never read-modify-write the file at once
export function makeLogger(fs: Fs, path: () => Promise<string>) {
  let queue = Promise.resolve()
  return (row: object): Promise<void> => {
    queue = queue
      .then(async () => {
        const p = await path()
        const prev = (await fs.exists(p)) ? await fs.read(p) : ''
        await fs.write(p, prev + JSON.stringify(row) + '\n')
      })
      .catch(() => {})
    return queue
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `claude plugin test plugins/routing`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/routing/hooks
git commit -m "Render the policy and log each decision"
```

---

### Task 4: Hold Agent calls to the policy

**Files:**
- Modify: `plugins/routing/hooks/register.ts`
- Test: `plugins/routing/hooks/register.test.ts`

- [ ] **Step 0: Confirm the call shapes** (see the header): `grep -n "'fs.read':\|'fs.write':\|'fs.exists':\|'env.get':" $TYPES`, then read each input type. Use those field names in the test hooks below where they differ.

- [ ] **Step 1: Write the failing tests**

`plugins/routing/hooks/register.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'

// Stands for the engine beneath the plugin: an in-memory disk, HOME, and an Agent tool that succeeds.
function engine(on: any, files: Map<string, string>) {
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(e.path) || e.path.endsWith('/policy.json') }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (files.has(e.path)) return { value: files.get(e.path) }
    if (e.path.endsWith('/policy.json')) return { value: POLICY }
    throw new Error('ENOENT')
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(e.path, e.text), { value: undefined }))
  on('tool.call', () => ({ result: { status: 'completed' } }))
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
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Agent', description: 'find callers', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toMatch(/^routing: description has no \[class\] tag/)
  expect(rows(files)).toMatchObject([{ surface: 'agent', verdict: 'deny', model: 'haiku' }])
})

test('a tagged call at the floor runs and is logged', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Agent', description: '[search] find callers', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toBeUndefined()
  expect(rows(files)).toMatchObject([{ surface: 'agent', cls: 'search', verdict: 'allow', outcome: 'ok' }])
})

test('[content] on sonnet is denied', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Agent', description: '[content] lesson', prompt: 'p', model: 'sonnet', effort: 'xhigh' })
  expect(r.deny).toMatch(/needs model opus/)
})

test('a project file raises a floor', async ($, on) => {
  const files = new Map([['.claude/routing.json', JSON.stringify({ classes: { search: { model: 'opus' } } })]])
  engine(on, files)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Agent', description: '[search] x', prompt: 'p', model: 'haiku', effort: 'low' })
  expect(r.deny).toMatch(/needs model opus/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugins/routing`
Expected: the 4 new tests FAIL (nothing is denied, nothing logged).

- [ ] **Step 3: Implement**

`plugins/routing/hooks/register.ts`:
```ts
import type { Register } from 'claude-code'
import { check, denyText, merge, type Layer, type Policy } from './policy.ts'
import { logPath, makeLogger } from './log.ts'

async function readJson<T>($: any, path: string): Promise<T | undefined> {
  try {
    return (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as T) : undefined
  } catch {
    return undefined
  }
}

// read on every call, so an edited policy applies at once
async function loadPolicy($: any): Promise<Policy> {
  const home = await $.env.get('HOME')
  const base = (await readJson<Policy>($, `${$.plugin.root}/policy.json`))!
  return merge(base, await readJson<Layer>($, `${home}/.claude/routing/policy.json`), await readJson<Layer>($, '.claude/routing.json'))
}

export const register: Register = on => {
  const sid = Math.random().toString(36).slice(2, 8)
  let log: ((row: object) => Promise<void>) | undefined
  const logger = ($: any) =>
    (log ??= makeLogger($.fs, async () => logPath(await $.env.get('HOME'), new Date(), sid)))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const p = await loadPolicy($)
    const v = check(p, e)
    const row = { ts: new Date().toISOString(), surface: 'agent', cls: v.cls, model: e.model, effort: e.effort, subagentType: e.subagent_type, label: e.description }
    if (!v.ok) {
      await logger($)({ ...row, verdict: 'deny', reason: v.reason })
      return { deny: denyText(p, v.reason) }
    }
    const ran = await next(e)
    await logger($)({ ...row, override: v.override, verdict: v.exempt ? 'exempt' : 'allow', outcome: ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok' })
    return ran
  }).catch(($, e, next) => next(e)) // fail open: routing is cost and quality, not security
}
```

- [ ] **Step 4: Run the tests and type-check**

Run: `claude plugin test plugins/routing && claude plugin validate plugins/routing`
Expected: PASS, 19 tests; validate lists the `tool.call` hook as a gating hook with `.catch`.

- [ ] **Step 5: Commit**

```bash
git add plugins/routing/hooks
git commit -m "Deny Agent calls below their class floor"
```

---

### Task 5: Workflow agents and the system-prompt section

**Files:**
- Modify: `plugins/routing/hooks/register.ts`
- Test: `plugins/routing/hooks/register.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/routing/hooks/register.test.ts`:
```ts
test('a workflow agent with no model gets the workflow model and is logged with its effort', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  let started: string | undefined
  on('agent.spawn', (_: unknown, e: { model?: string }) => ((started = e.model), { model: e.model, agentId: 'a1' }))
  on('turn.step', () => ({}))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'p', description: 'verify:x', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
  await $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1, agentId: 'a1' } as any)
  expect(started).toBe('opus')
  expect(rows(files)).toMatchObject([{ surface: 'workflow', runId: 'wf_1', agentIndex: 1, verdict: 'filled', model: 'opus', effort: 'low' }])
})

test('the policy section is added when Agent is offered', async ($, on) => {
  engine(on, new Map())
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'base', scope: 'shared' }] }))
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] } as any)
  expect(r.sections.map((s: { id: string }) => s.id)).toEqual(['engine', 'routing:policy'])
  expect(r.sections[1].text).toMatch(/# Delegation routing/)
  const none = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] } as any)
  expect(none.sections).toHaveLength(1)
})
```

> If `$.agent.spawn` / `$.turn.step` / `$.prompt.compose` are not callable from a test `$` in this build, drive the same events with `$.events.raise` as `$TYPES` names it (grep `claude-code/testing` for how the pane example raises `tool.call`) — the assertions stay the same.

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test plugins/routing`
Expected: the 2 new tests FAIL.

- [ ] **Step 3: Implement**

Add `ruleText` to the `./policy.ts` import in `register.ts`, then add inside `register`, after the `tool.call` hook:
```ts
  // a workflow agent's first request is the first place its real effort shows
  const pending = new Map<string, object>()

  on('agent.spawn', async ($, e, next) => {
    if (!e.workflow || e.resume) return next(e)
    const p = await loadPolicy($)
    const model = e.model ?? p.workflowModel
    const r = await next({ ...e, model })
    const row = { ts: new Date().toISOString(), surface: 'workflow', runId: e.workflow.runId, agentIndex: e.workflow.agentIndex, label: e.description, model, verdict: e.model ? 'allow' : 'filled' }
    if ('deny' in r && r.deny !== undefined) await logger($)({ ...row, verdict: 'deny', reason: r.deny })
    else pending.set(r.agentId, row)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async ($, e, next) => {
    const row = e.agentId && pending.get(e.agentId)
    if (row) {
      pending.delete(e.agentId!)
      await logger($)({ ...row, effort: e.effort })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes('Agent') && !e.tools.includes('Workflow')) return r
    return { ...r, sections: [...r.sections, { id: 'routing:policy', text: ruleText(await loadPolicy($)), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))
```

- [ ] **Step 4: Run tests, validate, type-check**

Run: `claude plugin test plugins/routing && claude plugin validate plugins/routing`
Expected: PASS, 21 tests; validate lists `tool.call`, `agent.spawn`, `turn.step`, `prompt.compose`.

- [ ] **Step 5: Commit**

```bash
git add plugins/routing/hooks
git commit -m "Log workflow agents and show Claude the policy"
```

---

### Task 6: Live check in a real session (Done 2 and 3)

**Files:** none (verification only)

- [ ] **Step 1: Untagged call denied, tagged retry passes**

Run:
```bash
rm -f ~/.claude/state/routing/$(date -u +%F)-*.jsonl
claude -p --plugin-dir plugins/routing --model haiku \
  'Call the Agent tool exactly once with description "find readme", subagent_type "Explore", model "haiku", effort "low", prompt "List README files in this repo". If it is denied, follow the denial and retry once. Then say DONE.'
cat ~/.claude/state/routing/$(date -u +%F)-*.jsonl
```
Expected: two rows: `verdict: "deny"` with `reason: "description has no [class] tag"`, then `cls: "search"`, `verdict: "allow"`, `outcome: "ok"`.

- [ ] **Step 2: A workflow run logs its agents**

Run:
```bash
claude -p --plugin-dir plugins/routing --model haiku \
  'Use a workflow: run the Workflow tool with a script whose meta is {name:"rt-check",description:"routing check"} and which calls agent("Say hi", {label:"hi", model:"haiku", effort:"low"}) and agent("Say bye", {label:"bye"}) in parallel and returns both. Then say DONE.'
cat ~/.claude/state/routing/$(date -u +%F)-*.jsonl | grep '"workflow"'
```
Expected: two `surface: "workflow"` rows with the same `runId`: `hi` with `model: "haiku"`, `verdict: "allow"`, `effort: "low"`; `bye` with `model: "opus"`, `verdict: "filled"`.

- [ ] **Step 3: Record evidence**

`orch task done <id> --evidence cmd:"claude -p --plugin-dir plugins/routing …"` with the two log excerpts in the commit or the pool note. If either check fails, stop and debug with `claude --debug` (the hook's skipped/refused line names the cause) before Task 7.

---

### Task 7: orch spawns on the policy (Done 4)

**Files:**
- Create: `plugins/orchestrator/src/routing.ts`
- Modify: `plugins/orchestrator/src/spawn.ts`, `plugins/orchestrator/src/cli.ts:32` and `:208-221`, `plugins/orchestrator/.claude-plugin/plugin.json`
- Test: `plugins/orchestrator/tests/spawn.test.ts`

- [ ] **Step 1: Write the failing tests**

In `plugins/orchestrator/tests/spawn.test.ts`, change the first test's `startClaude` expectation to:
```ts
    expect(ctx.herdr.calls[1]).toEqual(['startClaude', 'course-go-2', 'w9:p1', '--remote-control', 'course-go-2', '--model', 'opus', '--effort', 'xhigh'])
```
and add inside `describe('orch spawn-child', …)`:
```ts
  it('starts the child on the policy spawn default, flags first', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    parent(ctx)
    mkdirSync(join(ctx.claudeHome, 'routing'), { recursive: true })
    writeFileSync(join(ctx.claudeHome, 'routing', 'policy.json'), JSON.stringify({ spawn: { model: 'fable' } }))
    await run(['spawn-child', 't2', '--name', 'a', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(ctx.herdr.calls[1].slice(-4)).toEqual(['--model', 'fable', '--effort', 'xhigh'])
    await run(['spawn-child', 't2', '--name', 'b', '--cwd', '.', '--brief', 'brief.md', '--model', 'haiku', '--effort', 'low'], ctx)
    expect(ctx.herdr.calls.find(c => c[0] === 'startClaude' && c[1] === 'b')!.slice(-4)).toEqual(['--model', 'haiku', '--effort', 'low'])
  })

  it('puts the model and effort in the command printed outside herdr', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).toMatch(/claude --remote-control='go' --model 'opus' --effort 'xhigh' '/)
  })

  it('refuses an effort that is not a level', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md', '--effort', 'huge'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/--effort must be one of low, medium, high, xhigh, max/)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd plugins/orchestrator && npx vitest run tests/spawn.test.ts`
Expected: FAIL on the four changed/new expectations.

- [ ] **Step 3: Implement**

`plugins/orchestrator/src/routing.ts`:
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './ctx.js'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK = { model: 'opus', effort: 'xhigh' }

// The routing plugin's user policy, when there is one; orch needs only its spawn floor.
export function spawnDefaults(ctx: Ctx): { model: string; effort: string } {
  try {
    const spawn = JSON.parse(readFileSync(join(ctx.claudeHome, 'routing', 'policy.json'), 'utf8')).spawn ?? {}
    return { model: spawn.model || FALLBACK.model, effort: spawn.effort || FALLBACK.effort }
  } catch {
    return FALLBACK
  }
}
```

In `plugins/orchestrator/src/spawn.ts`:
- add `import { EFFORTS, spawnDefaults } from './routing.js'`;
- change `SpawnOptions` to `{ taskId: string; name: string; cwd: string; brief: string; prompt?: string; model?: string; effort?: string }`;
- at the top of `spawnChild`, after `const brief = …`:
```ts
  const defaults = spawnDefaults(ctx)
  const model = o.model || defaults.model
  const effort = o.effort || defaults.effort
  if (!EFFORTS.includes(effort)) throw new OrchError(`--effort must be one of ${EFFORTS.join(', ')}`)
  const runAs = ['--model', model, '--effort', effort]
```
- in the not-in-herdr branch, change the command's tail to `claude --remote-control=${q(name)} --model ${q(model)} --effort ${q(effort)} ${q(shown)}`;
- change the `startClaude` call to `args: ['--remote-control', name, ...runAs]`.

In `plugins/orchestrator/src/cli.ts`:
- line 32 help: `orch spawn-child <taskId> --name <n> --cwd <dir> --brief <file> [--prompt <text>] [--model <m>] [--effort <level>]`;
- in `cmdSpawn`, add `model: { type: 'string' }, effort: { type: 'string' }` to `options` and `model: values.model, effort: values.effort` to the `spawnChild` argument.

Bump `plugins/orchestrator/.claude-plugin/plugin.json` `version` to `0.1.1` so installed copies refresh.

- [ ] **Step 4: Tests, types, bundle**

Run: `cd plugins/orchestrator && npm test && npm run typecheck && npm run build`
Expected: all suites PASS, no type errors, `bin/orch` rebuilt.

- [ ] **Step 5: Done 4 check**

Run: `cd plugins/orchestrator && ORCH_HOME=$(mktemp -d) ./bin/orch help | grep -- '--effort'`
Expected: the new help line. (The full spawn path is covered by the tests above; a real herdr spawn is Task 9.)

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator
git commit -m "Start orch children on the routing spawn model and effort"
```

---

### Task 8: Docs and the user-level skill

**Files:**
- Create: `plugins/routing/README.md`
- Modify: `README.md` (repo), `plugins/orchestrator/README.md` (spawn-child line), `~/.claude/skills/herdr-spawn-rc/SKILL.md` (outside the repo)

- [ ] **Step 1: `plugins/routing/README.md`**

```markdown
# routing

Picks the model and effort for work Claude delegates, by task class.

- **Agent calls** must start `description` with a class tag (`[search]`, `[mechanical]`, `[implement]`,
  `[content]`, `[review]`, `[design]`, `[research]`) and pass `model` + `effort` at or above that class's
  minimum. Anything else is denied with the table, and Claude retries.
- **Workflow agents** without a model get `workflowModel`; every one is logged with the effort it ran at.
- **Claude sees the table** as a system-prompt section generated from the policy, so it never drifts.
- **orch** children start on the `spawn` model and effort.

## Change the table

Layer a partial file over the defaults in `policy.json`:

- `~/.claude/routing/policy.json`: yours, every project
- `<repo>/.claude/routing.json`: one project

    { "classes": { "search": { "model": "opus" } }, "spawn": { "effort": "high" } }

## Read the log

    cat ~/.claude/state/routing/*.jsonl | jq -s 'group_by(.cls) | map({cls: .[0].cls, n: length, denied: map(select(.verdict == "deny")) | length})'

## Install

    /plugin install routing@claude-skills
```

- [ ] **Step 2: Repo README and orch README**

Add `routing/` to the `plugins/` tree in `README.md` with the comment `# model + effort policy for delegated work`. In `plugins/orchestrator/README.md`, extend the `spawn-child` usage with `[--model <m>] [--effort <level>]` and one sentence: "Without them the child starts on the `spawn` entry of `~/.claude/routing/policy.json`, else opus / xhigh."

- [ ] **Step 3: herdr-spawn-rc**

In `~/.claude/skills/herdr-spawn-rc/SKILL.md`, replace the hard-coded `-- --model opus` convention with: "Pass `-- --model <m> --effort <e>` from the routing policy's spawn default (`jq -r '.spawn | \"\(.model) \(.effort)\"' ~/.claude/routing/policy.json`, else `opus xhigh`), unless the user names a model." Read the file first; change only that convention.

- [ ] **Step 4: Commit (repo files only)**

```bash
git add README.md plugins/routing/README.md plugins/orchestrator/README.md
git commit -m "Document the routing plugin and the new spawn flags"
```

---

### Task 9: Ship (ask the user first)

**Files:** none

- [ ] **Step 1: Ask** before anything leaves the machine: merge `routing` into `main` and push to `origin` (`Cybeaster/ClaudeSkills`)? Pushing publishes it.
- [ ] **Step 2: On yes:** `git -C ~/src/ClaudeSkills merge --ff-only routing && git -C ~/src/ClaudeSkills push origin main`.
- [ ] **Step 3: Install:** `claude plugin marketplace update claude-skills`, then `/plugin install routing@claude-skills` and `/plugin update orchestrator@claude-skills` (the user runs the slash commands, or `claude plugin install …` from the shell).
- [ ] **Step 4: Real herdr spawn (Done 4, live):** inside herdr, `orch spawn-child <task> --name rt-check --cwd ~/src/ClaudeSkills --brief <brief>`; in the child, the status line shows Opus and effort xhigh. Close the tab after.
- [ ] **Step 5: Memory:** update `feedback_subagent_models.md` and `user_herdr_terminal_spawn_rc_skill.md` in the ItAbyss memory dir to point at the routing policy as the place those rules now live (`~/.claude/routing/policy.json` / the plugin's `policy.json`).

---

## Self-review

- Spec coverage: surfaces (Tasks 4, 5, 7), table + floors + `[override]` + `max` + fork (Task 2), escalation and workflow rule in the prompt section (Task 3), single source (Tasks 3, 5, 7), log (Tasks 3–5), Done 1 (Tasks 2, 4), Done 2–3 (Task 6), Done 4 (Tasks 7, 9). Main session untouched: no hook rewrites main's model or effort (`turn.step` only reads, and only for workflow agents).
- Names used across tasks: `check`, `merge`, `rank`, `ruleText`, `denyText`, `table`, `logPath`, `makeLogger`, `loadPolicy`, `spawnDefaults`, `EFFORTS`: each defined once.
