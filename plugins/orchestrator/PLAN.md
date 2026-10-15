# orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `orchestrator` plugin described in `DESIGN.md`: an `orch` CLI through which every Claude Code session keeps its task pool with evidence, hooks that register sessions and keep pools current, parent/child sessions with a shared brief, a TUI over all sessions, and a `/orch` command that does the same from a phone over Remote Control.

**Architecture:** One TypeScript code base bundled by esbuild into two committed files: `bin/orch` (the CLI and the hooks; Claude Code puts a plugin's `bin/` on the Bash tool's PATH) and `lib/orch-tui.mjs` (Ink TUI, loaded only by `orch tui` so hooks start fast). Pure rules live in `model.ts`, `evidence.ts`, `overview.ts`, `format.ts`; I/O lives in `store.ts` and `sources/*`; every side effect reaches the commands through one injected `Ctx`, so tests run against temp dirs and fakes.

**Tech Stack:** Node 24 (runtime ≥ 20), TypeScript 5.9, esbuild, vitest, Ink 6 + React 19, ink-testing-library, `herdr` CLI, `gh` CLI.

**Repo and paths.** Everything is relative to `~/src/ClaudeSkills`, branch `orchestrator`. The plugin lives at `plugins/orchestrator/`; run `npm` commands from there. Commit messages follow the repo's style (short sentence-case imperative) and end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep
```

---

## File structure

| File | Responsibility |
| --- | --- |
| `.claude-plugin/plugin.json` | manifest |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `build.mjs`, `.gitignore` | toolchain; `node_modules/` ignored, `bin/orch` and `lib/orch-tui.mjs` committed |
| `src/errors.ts` | `OrchError` (message + exit code) |
| `src/model.ts` | `Pool` / `Task` / `Evidence` types and every pool mutation, pure |
| `src/store.ts` | pool files: read, atomic write, lock, `update`, list, `orch.log` |
| `src/evidence.ts` | parse `--evidence`, grade it, describe it |
| `src/sources/sessions.ts` | live sessions from `~/.claude/sessions/*.json`, claude.ai link |
| `src/sources/herdr.ts` | `Herdr` interface and the `herdr` CLI implementation |
| `src/sources/gh.ts` | `Gh` interface: live CI / PR check with a 60 s cache |
| `src/overview.ts` | `buildOverview`: joins pools, live sessions, herdr and checks into a `Row` tree, pure |
| `src/format.ts` | text for rows and pools, shared by `orch status` and the TUI |
| `src/ctx.ts` | the `Ctx` type and `realCtx()` |
| `src/self.ts` | which session is calling `orch` |
| `src/collect.ts` | gathers all inputs through `Ctx` and calls `buildOverview` |
| `src/targets.ts` | resolve a session by id, prefix, name or title |
| `src/link.ts` | link a child session under a parent task |
| `src/spawn.ts` | `orch spawn-child` |
| `src/reply.ts` | `orch reply` |
| `src/hooks.ts` | `orch hook session-start` / `prompt-submit` |
| `src/out.ts` | the `Out` result type (`{code, stdout, stderr}`) and `ok()` |
| `src/cli.ts` | argument parsing and command dispatch |
| `src/main.ts` | process entry of `bin/orch` |
| `src/tui/App.tsx`, `src/tui/main.tsx` | the TUI and its entry |
| `hooks/hooks.json` | SessionStart and UserPromptSubmit → `bin/orch hook …` |
| `skills/orch-pool/SKILL.md` | teaches sessions the three habits (not named `orch`, which would collide with the `/orch` command) |
| `commands/orch.md` | `/orch`: interactive overview for Remote Control |
| `tests/*.test.ts(x)`, `tests/helpers.ts`, `tests/fixtures/` | vitest suites, fake `Ctx`, recorded fixtures |
| `README.md` | what it is, install, commands, keys |
| `../../.claude-plugin/marketplace.json` | gains the `orchestrator` entry |

**Commands used throughout** (from `plugins/orchestrator`):

```bash
npm test                      # vitest run
npm run typecheck             # tsc --noEmit
npm run build                 # esbuild → bin/orch, lib/orch-tui.mjs
```

---

### Task 0: Spike the three Remote Control assumptions

Nothing is built in this task. It checks, by hand, the three things §8 of the design relies on and that cannot be unit-tested. Do it before anything else; if a check fails, stop and tell the person, because the `/orch` design changes.

**Files:**
- Modify: `plugins/orchestrator/DESIGN.md` (append a "Verified" note to §8)

- [ ] **Step 1: AskUserQuestion renders as tappable choices over Remote Control**

In any session that is on Remote Control, ask Claude: *"Use AskUserQuestion to ask me to pick one of: alpha, beta, gamma."* Open the session on the phone (claude.ai/code).
Expected: the question shows with tappable options, and tapping one returns it to the session.

- [ ] **Step 2: `herdr agent prompt` submits into an idle Claude pane**

Spawn a throwaway session and prompt it:

```bash
bash ~/.claude/skills/herdr-spawn-rc/scripts/spawn-rc.sh tab --label orch-spike
herdr agent prompt orch-spike "reply with the single word: pong"
herdr agent wait orch-spike --timeout 120000
herdr agent read orch-spike --source visible | tail -5
```

Expected: the pane shows the prompt submitted and Claude answering `pong`.

- [ ] **Step 3: SendMessage reaches a session that is not in herdr**

Start `claude` in a plain terminal outside herdr. From this session, call ListAgents and SendMessage it *"reply with: pong"*.
Expected: the message appears in the external session as input. Then close the spike tab: `herdr tab close <tab_id from step 2>` and exit the external session.

- [ ] **Step 4: Record the result**

Append to §8 of `plugins/orchestrator/DESIGN.md`:

```markdown
**Verified 2026-10-14 (Task 0 spike):** AskUserQuestion renders as tappable choices over Remote Control; `herdr agent prompt` submits into an idle Claude pane; SendMessage reaches a session outside herdr.
```

If any check failed, write what happened instead and stop here.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/DESIGN.md
git commit -m "Record the Remote Control spike for the orchestrator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 1: Scaffold the plugin and toolchain

**Files:**
- Create: `plugins/orchestrator/.claude-plugin/plugin.json`
- Create: `plugins/orchestrator/package.json`
- Create: `plugins/orchestrator/tsconfig.json`
- Create: `plugins/orchestrator/vitest.config.ts`
- Create: `plugins/orchestrator/build.mjs`
- Create: `plugins/orchestrator/.gitignore`
- Create: `plugins/orchestrator/src/errors.ts`
- Create: `plugins/orchestrator/src/main.ts` (stub, replaced in Task 8)
- Test: `plugins/orchestrator/tests/errors.test.ts`

- [ ] **Step 1: Write the manifest and toolchain files**

`.claude-plugin/plugin.json`:

```json
{
  "name": "orchestrator",
  "version": "0.1.0",
  "description": "One view over every local Claude Code session: each session keeps a task pool with evidence, children nest under the task that spawned them, and /orch works from your phone.",
  "author": { "name": "Cybeaster", "email": "cybeastermail@gmail.com" }
}
```

`package.json`:

```json
{
  "name": "orchestrator",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check:bundle": "node build.mjs && git diff --exit-code -- bin lib"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.1.0",
    "esbuild": "^0.25.0",
    "ink": "^6.0.0",
    "ink-testing-library": "^4.0.0",
    "react": "^19.1.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts` (pins the automatic JSX runtime for the `.tsx` tests in Task 12):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ esbuild: { jsx: 'automatic' } })
```

`build.mjs` (the `require` shim lets bundled CommonJS code such as React load Node built-ins inside an ESM bundle; `react-devtools-core` is stubbed because, marked external, esbuild hoists Ink's lazy import of it to a top-level import that fails at load with `ERR_MODULE_NOT_FOUND`, found in review):

```js
import { build } from 'esbuild'
import { chmodSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('.', import.meta.url)))

const banner = {
  js: "#!/usr/bin/env node\nimport { createRequire as __orchRequire } from 'node:module';\nconst require = __orchRequire(import.meta.url);",
}

// Ink imports react-devtools-core only when DEV=true; as an external it would be hoisted to a
// top-level import and crash the ESM bundle at load, so it is stubbed instead.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'orch-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'orch-stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} }', loader: 'js' }))
  },
}

// esbuild captures process.cwd() when it is imported, before the chdir above runs, so pin it here.
const common = {
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  banner,
  plugins: [stubDevtools],
  logLevel: 'warning',
}

mkdirSync('bin', { recursive: true })
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'bin/orch' })
chmodSync('bin/orch', 0o755)
```

`.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Install**

Run: `cd plugins/orchestrator && npm install`
Expected: `added N packages`, a `package-lock.json`, no `ERESOLVE` error. If a `^` range has no release, take the newest published major with `npm view <pkg> version` and pin that.

- [ ] **Step 3: Write the failing test**

`tests/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'

describe('OrchError', () => {
  it('carries a message and defaults to exit code 1', () => {
    const e = new OrchError('nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('nope')
    expect(e.code).toBe(1)
    expect(e.name).toBe('OrchError')
    expect(new OrchError('usage', 2).code).toBe(2)
  })
})
```

- [ ] **Step 4: Run it to see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/errors.js'`.

- [ ] **Step 5: Implement**

`src/errors.ts`:

```ts
export class OrchError extends Error {
  override name = 'OrchError'

  constructor(message: string, readonly code = 1) {
    super(message)
  }
}
```

`src/main.ts` (stub so the build has an entry; Task 8 replaces it):

```ts
process.stdout.write('orch: not built yet\n')
```

- [ ] **Step 6: Run tests, typecheck and build**

Run: `npm test && npm run typecheck && npm run build && ./bin/orch`
Expected: 1 test passed; no type errors; `orch: not built yet`.

- [ ] **Step 7: Commit**

```bash
git add plugins/orchestrator
git commit -m "Scaffold the orchestrator plugin" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 2: Pool model

**Files:**
- Create: `plugins/orchestrator/src/model.ts`
- Test: `plugins/orchestrator/tests/model.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import {
  addTask, askTask, blockTask, clearQuestions, doneTask, linkChild, newPool, plan,
  setParent, setTitle, startTask, startTurn, unlinkChild,
} from '../src/model.js'
import type { Pool } from '../src/model.js'

const base = () => newPool('s1', '/repo', 100)

describe('plan', () => {
  it('numbers tasks from t1', () => {
    const p = plan(base(), ['a', 'b'], 200)
    expect(p.tasks.map(t => [t.id, t.text, t.status])).toEqual([['t1', 'a', 'pending'], ['t2', 'b', 'pending']])
    expect(p.touchedAt).toBe(200)
  })

  it('keeps started, done, blocked and asking tasks and never reuses ids', () => {
    let p = plan(base(), ['a', 'b', 'c', 'd'], 200)
    p = doneTask(p, 't1', { kind: 'commit', ref: 'abc1234' }, 210)
    p = blockTask(p, 't3', 'x', 215)
    p = startTask(p, 't2', 220)
    p = askTask(p, 't4', 'which?', 230)
    p = plan(p, ['x'], 240)
    expect(p.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(p.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('takes the next id from the highest existing one when seq is missing', () => {
    const p = plan(base(), ['a', 'b'], 200)
    delete (p as Partial<Pool>).seq
    expect(addTask(p, 'c', 210).tasks.map(t => t.id)).toEqual(['t1', 't2', 't3'])
    expect(plan(p, ['x', 'y'], 210).tasks.map(t => t.id)).toEqual(['t3', 't4'])
  })

  it('does not mutate its input', () => {
    const p = base()
    plan(p, ['a'], 200)
    expect(p.tasks).toEqual([])
  })
})

describe('task edits', () => {
  it('adds, starts, blocks and finishes', () => {
    let p = addTask(base(), 'a', 200)
    p = blockTask(p, 't1', 'waiting on CI', 210)
    expect(p.tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'waiting on CI' })
    p = startTask(p, 't1', 220)
    expect(p.tasks[0].blockedReason).toBeUndefined()
    p = doneTask(p, 't1', undefined, 230)
    expect(p.tasks[0]).toMatchObject({ status: 'done' })
    expect(p.tasks[0].evidence).toBeUndefined()
  })

  it('drops old evidence when ticked again without any', () => {
    let p = addTask(base(), 'a', 200)
    p = doneTask(p, 't1', { kind: 'pr', ref: '41' }, 210)
    p = doneTask(p, 't1', undefined, 220)
    expect(p.tasks[0].evidence).toBeUndefined()
  })

  it('clears a pending question when the task is finished', () => {
    let p = askTask(addTask(base(), 'a', 200), 't1', 'which?', 210)
    p = doneTask(p, 't1', undefined, 220)
    expect(p.tasks[0].needsInput).toBeUndefined()
  })

  it('drops evidence when a done task is started or blocked again', () => {
    const done = doneTask(addTask(base(), 'a', 200), 't1', { kind: 'commit', ref: 'abc1234' }, 210)
    expect(startTask(done, 't1', 220).tasks[0].evidence).toBeUndefined()
    expect(blockTask(done, 't1', 'x', 220).tasks[0].evidence).toBeUndefined()
  })

  it('throws OrchError for an unknown id', () => {
    expect(() => startTask(base(), 't9', 200)).toThrow(OrchError)
    // the parent may re-plan between the link check and the locked update; never skip silently
    expect(() => linkChild(base(), 't9', 'c1', 200)).toThrow(OrchError)
  })

  it('sets the title as an own write', () => {
    expect(setTitle(base(), 'Courses', 200)).toMatchObject({ title: 'Courses', touchedAt: 200 })
  })
})

describe('questions', () => {
  it('returns undefined when there is nothing to clear', () => {
    expect(clearQuestions(addTask(base(), 'a', 200), 300)).toBeUndefined()
  })

  it('clears one task or all, without counting as an own write', () => {
    let p = plan(base(), ['a', 'b'], 200)
    p = askTask(askTask(p, 't1', 'q1', 210), 't2', 'q2', 211)
    const one = clearQuestions(p, 300, 't1')!
    expect(one.tasks.map(t => t.needsInput)).toEqual([undefined, 'q2'])
    expect(one.touchedAt).toBe(211)
    expect(clearQuestions(p, 300)!.tasks.every(t => !t.needsInput)).toBe(true)
  })
})

describe('links', () => {
  it('links a child once and starts a pending task', () => {
    let p = plan(base(), ['fan out'], 200)
    p = linkChild(linkChild(p, 't1', 'c1', 300), 't1', 'c1', 301)
    expect(p.tasks[0]).toMatchObject({ children: ['c1'], status: 'in_progress' })
    expect(p.touchedAt).toBe(200)
  })

  it('counts a link made by the owner as an own write', () => {
    const p = linkChild(plan(base(), ['fan out'], 200), 't1', 'c1', 300, true)
    expect(p).toMatchObject({ touchedAt: 300, updatedAt: 300 })
    expect(p.tasks[0]).toMatchObject({ children: ['c1'], status: 'in_progress' })
  })

  it('keeps a done task done when a child is linked', () => {
    let p = doneTask(plan(base(), ['a'], 200), 't1', undefined, 210)
    p = linkChild(p, 't1', 'c1', 300, true)
    expect(p.tasks[0]).toMatchObject({ status: 'done', children: ['c1'] })
  })

  it('unlinks a child and drops an empty list', () => {
    let p = linkChild(plan(base(), ['fan out'], 200), 't1', 'c1', 300)
    p = unlinkChild(p, 't1', 'c1', 310)
    expect(p.tasks[0].children).toBeUndefined()
  })

  it('leaves the tasks alone when unlinking from an unknown task', () => {
    const p = plan(base(), ['a'], 200)
    const q = unlinkChild(p, 't9', 'c1', 310)
    expect(q.tasks).toEqual(p.tasks)
    expect(q.updatedAt).toBe(310)
  })

  it('records the parent and the brief', () => {
    const p = setParent(base(), { sessionId: 'p1', taskId: 't2' }, '/repo/brief.md', 300)
    expect(p).toMatchObject({ parent: { sessionId: 'p1', taskId: 't2' }, brief: '/repo/brief.md', updatedAt: 300 })
    expect(p.touchedAt).toBeUndefined()
  })

  it('drops the brief when moved to another parent without a new one', () => {
    const p1 = setParent(base(), { sessionId: 'p1', taskId: 't1' }, '/a.md', 300)
    const moved = setParent(p1, { sessionId: 'p2', taskId: 't1' }, undefined, 310)
    expect(moved.parent).toEqual({ sessionId: 'p2', taskId: 't1' })
    expect(moved.brief).toBeUndefined()
    expect(setParent(p1, { sessionId: 'p2', taskId: 't1' }, '/b.md', 310).brief).toBe('/b.md')
  })

  it('keeps the brief when the same parent is recorded again without one', () => {
    const p1 = setParent(base(), { sessionId: 'p1', taskId: 't1' }, '/a.md', 300)
    expect(setParent(p1, { sessionId: 'p1', taskId: 't3' }, undefined, 310).brief).toBe('/a.md')
  })
})

describe('turns', () => {
  it('marks the start of a turn without counting as an own write', () => {
    const p = startTurn(base(), 400)
    expect(p).toMatchObject({ turnStartedAt: 400, updatedAt: 400 })
    expect(p.touchedAt).toBeUndefined()
    expect(startTurn(plan(base(), ['a'], 200), 400).touchedAt).toBe(200)
  })
})

describe('immutability', () => {
  const rich = (): Pool => {
    let p = plan(base(), ['a', 'b', 'c', 'd'], 200)
    p = doneTask(p, 't1', { kind: 'cmd', ref: 'npm test', exit: 0 }, 210)
    p = linkChild(p, 't2', 'c1', 220)
    p = blockTask(p, 't3', 'waiting', 230)
    p = askTask(p, 't4', 'which?', 240)
    p = setParent(p, { sessionId: 'p1', taskId: 't9' }, '/repo/brief.md', 250)
    return startTurn(setTitle(p, 'Courses', 255), 260)
  }

  it('no mutation changes its input', () => {
    const mutations: [string, (p: Pool) => Pool | undefined][] = [
      ['plan', p => plan(p, ['x'], 300)],
      ['addTask', p => addTask(p, 'x', 300)],
      ['setTitle', p => setTitle(p, 'Other', 300)],
      ['startTask', p => startTask(p, 't3', 300)],
      ['blockTask', p => blockTask(p, 't1', 'x', 300)],
      ['doneTask', p => doneTask(p, 't4', { kind: 'pr', ref: '1' }, 300)],
      ['askTask', p => askTask(p, 't2', 'q', 300)],
      ['clearQuestions', p => clearQuestions(p, 300)],
      ['clearQuestions (one task)', p => clearQuestions(p, 300, 't4')],
      ['setParent', p => setParent(p, { sessionId: 'p2', taskId: 't1' }, undefined, 300)],
      ['linkChild', p => linkChild(p, 't2', 'c2', 300, true)],
      ['unlinkChild', p => unlinkChild(p, 't2', 'c1', 300)],
      ['startTurn', p => startTurn(p, 300)],
    ]
    const pool = rich()
    const before = structuredClone(pool)
    for (const [name, run] of mutations) {
      const out = run(pool)
      expect(out, name).not.toBe(pool)
      expect(pool, name).toEqual(before)
    }
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/model.test.ts`
Expected: FAIL, `Cannot find module '../src/model.js'`.

- [ ] **Step 3: Implement**

`src/model.ts`:

```ts
import { OrchError } from './errors.js'

export type Status = 'pending' | 'in_progress' | 'done' | 'blocked'

export type Evidence =
  | { kind: 'commit' | 'pr' | 'ci' | 'note'; ref: string }
  | { kind: 'cmd'; ref: string; exit: number }

export type Task = {
  id: string
  text: string
  status: Status
  blockedReason?: string
  evidence?: Evidence
  children?: string[]
  needsInput?: string
}

export type ParentLink = { sessionId: string; taskId: string }

export type Pool = {
  sessionId: string
  title: string
  cwd: string
  parent?: ParentLink
  brief?: string
  tasks: Task[]
  seq: number
  createdAt: number
  updatedAt: number
  touchedAt?: number
  turnStartedAt?: number
}

export function newPool(sessionId: string, cwd: string, now: number): Pool {
  return { sessionId, title: '', cwd, tasks: [], seq: 0, createdAt: now, updatedAt: now }
}

const clone = (p: Pool): Pool => structuredClone(p)

function find(p: Pool, id: string): Task {
  const t = p.tasks.find(t => t.id === id)
  if (!t) throw new OrchError(`no task ${id} in this pool (have: ${p.tasks.map(t => t.id).join(', ') || 'none'})`)
  return t
}

// seq may be missing from a hand-edited or older file; never hand out an id already present.
function nextId(p: Pool): string {
  p.seq = Math.max(p.seq ?? 0, ...p.tasks.map(t => Number(t.id.slice(1)) || 0)) + 1
  return `t${p.seq}`
}

// A write by the session itself through the CLI: it keeps the pool current.
function own(p: Pool, now: number): Pool {
  p.updatedAt = now
  p.touchedAt = now
  return p
}

export function plan(pool: Pool, texts: string[], now: number): Pool {
  const p = clone(pool)
  const kept = p.tasks.filter(t => t.status !== 'pending' || t.children?.length || t.needsInput)
  const fresh = texts.map(text => ({ id: nextId(p), text, status: 'pending' as const }))
  p.tasks = [...kept, ...fresh]
  return own(p, now)
}

export function addTask(pool: Pool, text: string, now: number): Pool {
  const p = clone(pool)
  p.tasks.push({ id: nextId(p), text, status: 'pending' })
  return own(p, now)
}

export function setTitle(pool: Pool, title: string, now: number): Pool {
  const p = clone(pool)
  p.title = title
  return own(p, now)
}

export function startTask(pool: Pool, id: string, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'in_progress'
  delete t.blockedReason
  delete t.evidence
  return own(p, now)
}

export function blockTask(pool: Pool, id: string, reason: string, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'blocked'
  t.blockedReason = reason
  delete t.evidence
  return own(p, now)
}

export function doneTask(pool: Pool, id: string, evidence: Evidence | undefined, now: number): Pool {
  const p = clone(pool)
  const t = find(p, id)
  t.status = 'done'
  delete t.blockedReason
  delete t.needsInput
  if (evidence) t.evidence = evidence
  else delete t.evidence
  return own(p, now)
}

export function askTask(pool: Pool, id: string, question: string, now: number): Pool {
  const p = clone(pool)
  find(p, id).needsInput = question
  return own(p, now)
}

// Not an own write: the person answered, the session did not touch its pool.
export function clearQuestions(pool: Pool, now: number, taskId?: string): Pool | undefined {
  if (!pool.tasks.some(t => t.needsInput && (!taskId || t.id === taskId))) return undefined
  const p = clone(pool)
  for (const t of p.tasks) if (!taskId || t.id === taskId) delete t.needsInput
  p.updatedAt = now
  return p
}

export function setParent(pool: Pool, parent: ParentLink, brief: string | undefined, now: number): Pool {
  const p = clone(pool)
  const moved = p.parent?.sessionId !== parent.sessionId
  p.parent = parent
  if (brief) p.brief = brief
  else if (moved) delete p.brief
  p.updatedAt = now
  return p
}

// byOwner: the parent session itself made the link (spawn-child, its own orch link), so it counts as keeping its pool current.
export function linkChild(pool: Pool, taskId: string, childId: string, now: number, byOwner = false): Pool {
  const p = clone(pool)
  const t = find(p, taskId)
  t.children = [...new Set([...(t.children ?? []), childId])]
  if (t.status === 'pending') t.status = 'in_progress'
  if (byOwner) return own(p, now)
  p.updatedAt = now
  return p
}

export function unlinkChild(pool: Pool, taskId: string, childId: string, now: number): Pool {
  const p = clone(pool)
  const t = p.tasks.find(t => t.id === taskId)
  if (t?.children) {
    t.children = t.children.filter(c => c !== childId)
    if (!t.children.length) delete t.children
  }
  p.updatedAt = now
  return p
}

// Set by the UserPromptSubmit hook: not an own write.
export function startTurn(pool: Pool, now: number): Pool {
  const p = clone(pool)
  p.turnStartedAt = now
  p.updatedAt = now
  return p
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test -- tests/model.test.ts && npm run typecheck`
Expected: all model tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/src/model.ts plugins/orchestrator/tests/model.test.ts
git commit -m "Add the orchestrator pool model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 3: Pool store

**Files:**
- Create: `plugins/orchestrator/src/store.ts`
- Test: `plugins/orchestrator/tests/store.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/store.test.ts`:

```ts
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { newPool } from '../src/model.js'
import { listPools, lockTiming, log, poolPath, readPool, update, updateIfExists, writePool } from '../src/store.js'

const dirs: string[] = []
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const home = () => tmp('orch-store-')
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Each worker is its own process, so the lock is contended for real; in one process every update
// would run to completion without yielding and never meet a held lock. Workers announce
// themselves, then wait for a start signal so that all of them hit the lock at the same moment.
const WORKER = `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [bundle, home, tag, dir] = process.argv.slice(2)
const { update } = await import(bundle)
writeFileSync(join(dir, 'ready-' + tag), '')
const until = Date.now() + 10000
while (!existsSync(join(dir, 'go'))) {
  if (Date.now() > until) throw new Error('no start signal')
  await new Promise(r => setTimeout(r, 2))
}
for (let i = 0; i < 25; i++) {
  const id = tag + '-' + i
  await update(home, 's1', p => ({ ...p, tasks: [...p.tasks, { id, text: id, status: 'pending' }] }))
}
`

const runWorker = (args: string[]) =>
  new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => (stderr += d))
    child.on('error', reject)
    child.on('close', code => resolve({ code, stderr }))
  })

describe('store', () => {
  it('round-trips a pool and leaves no temp file', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    expect(readPool(h, 's1')).toMatchObject({ sessionId: 's1', cwd: '/r' })
    expect(readdirSync(h)).toEqual(['s1.json'])
  })

  it('returns undefined for a missing pool', () => {
    expect(readPool(home(), 'nope')).toBeUndefined()
  })

  it('lists pools and reports unreadable ones', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 's2.json'), '{broken')
    writeFileSync(join(h, 'orch.log'), 'x')
    const entries = listPools(h).sort((a, b) => a.id.localeCompare(b.id))
    expect(entries[0]).toMatchObject({ id: 's1', pool: { sessionId: 's1' } })
    expect(entries[1].id).toBe('s2')
    expect(entries[1].error).toMatch(/JSON/)
    expect(entries).toHaveLength(2)
  })

  it('listPools ignores leftover temp files and lock directories', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 's1.json.123.abc.tmp'), '{"half":')
    mkdirSync(join(h, 's1.json.lock'))
    expect(listPools(h).map(e => e.id)).toEqual(['s1'])
  })

  it('listPools skips misnamed files and flags a file holding another session', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    const text = readFileSync(join(h, 's1.json'), 'utf8')
    for (const name of ['.hidden.json', 's1 copy.json', 'backup1.json']) writeFileSync(join(h, name), text)
    const entries = listPools(h).sort((a, b) => a.id.localeCompare(b.id))
    expect(entries.map(e => e.id)).toEqual(['backup1', 's1'])
    expect(entries[0].pool).toBeUndefined()
    expect(entries[0].error).toMatch(/holds session s1/)
    expect(entries[1]).toMatchObject({ id: 's1', pool: { sessionId: 's1' } })
  })

  it('readPool refuses a file that holds another session', () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    writeFileSync(join(h, 'backup1.json'), readFileSync(join(h, 's1.json'), 'utf8'))
    expect(() => readPool(h, 'backup1')).toThrow(OrchError)
    expect(() => readPool(h, 'backup1')).toThrow(/holds session s1/)
    expect(readPool(h, 's1')).toMatchObject({ sessionId: 's1' })
  })

  it('serialises updates from many processes', async () => {
    const h = home()
    const dir = tmp('orch-store-bundle-')
    await build({
      entryPoints: [fileURLToPath(new URL('../src/store.ts', import.meta.url))],
      outfile: join(dir, 'store.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    })
    const worker = join(dir, 'worker.mjs')
    writeFileSync(worker, WORKER)
    const bundle = pathToFileURL(join(dir, 'store.mjs')).href
    writePool(h, newPool('s1', '/r', 1))

    const tags = Array.from({ length: 6 }, (_, i) => `w${i}`)
    const state = { early: undefined as string | undefined }
    const runs = tags.map(tag =>
      runWorker([worker, bundle, h, tag, dir]).then(r => {
        if (!existsSync(join(dir, 'go'))) state.early = `worker ${tag} exited (${r.code}) before the start signal: ${r.stderr}`
        return r
      }),
    )
    const until = Date.now() + 10_000
    while (!tags.every(t => existsSync(join(dir, `ready-${t}`)))) {
      if (state.early) throw new Error(state.early)
      if (Date.now() > until) throw new Error('workers did not become ready')
      await sleep(2)
    }
    if (state.early) throw new Error(state.early)
    writeFileSync(join(dir, 'go'), '')

    const results = await Promise.all(runs)
    expect(results.map(r => r.code), results.map(r => r.stderr).join('')).toEqual(Array(6).fill(0))
    expect(readPool(h, 's1')!.tasks).toHaveLength(150)
  }, 30_000)

  it('breaks a stale lock', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    await update(h, 's1', () => newPool('s1', '/r', 1))
    expect(readPool(h, 's1')).toBeDefined()
    expect(existsSync(lock)).toBe(false)
  })

  // A stale lock that cannot be removed used to spin the event loop forever; it must fail instead.
  it.skipIf(process.getuid?.() === 0)('fails instead of spinning on a stale lock it cannot remove', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(join(lock, 'sub'), { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    chmodSync(lock, 0o555)
    try {
      const err = await update(h, 's1', () => newPool('s1', '/r', 1)).catch(e => e)
      expect(err).toBeInstanceOf(OrchError)
      expect(err.message).toContain('cannot break stale lock')
      expect(err.message).toContain(lock)
    } finally {
      chmodSync(lock, 0o755)
    }
  })

  it('times out on a live lock and names it', async () => {
    const h = home()
    const lock = join(h, 's1.json.lock')
    mkdirSync(lock)
    const saved = { ...lockTiming }
    Object.assign(lockTiming, { staleMs: 60_000, deadlineMs: 100 })
    try {
      const t0 = Date.now()
      const err = await update(h, 's1', () => newPool('s1', '/r', 1)).catch(e => e)
      expect(err).toBeInstanceOf(OrchError)
      expect(err.message).toContain(lock)
      expect(err.message).toMatch(/held \d+ ms/)
      expect(Date.now() - t0).toBeLessThan(1_000)
    } finally {
      Object.assign(lockTiming, saved)
    }
  })

  it('releases the lock when the update function throws', async () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    await expect(
      update(h, 's1', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
    await update(h, 's1', p => ({ ...p!, title: 'again' }))
    expect(readPool(h, 's1')!.title).toBe('again')
  })

  it('updateIfExists skips a missing pool', async () => {
    const h = home()
    expect(await updateIfExists(h, 'nope', p => p)).toBeUndefined()
    expect(existsSync(join(h, 'nope.json'))).toBe(false)
  })

  it('refuses to write a pool under a different session id', async () => {
    const h = home()
    writePool(h, newPool('s1', '/r', 1))
    const before = readFileSync(join(h, 's1.json'), 'utf8')
    await expect(update(h, 's1', () => newPool('other', '/r', 2))).rejects.toBeInstanceOf(OrchError)
    await expect(updateIfExists(h, 's1', () => newPool('other', '/r', 2))).rejects.toBeInstanceOf(OrchError)
    expect(readFileSync(join(h, 's1.json'), 'utf8')).toBe(before)
    expect(existsSync(join(h, 'other.json'))).toBe(false)
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
  })

  it('rejects session ids that are not plain names', async () => {
    const h = home()
    for (const bad of ['../x', 'a/b', '', '.hidden', '-flag', 'a b']) {
      expect(() => poolPath(h, bad), bad).toThrow(OrchError)
      expect(() => readPool(h, bad), bad).toThrow(OrchError)
      await expect(update(h, bad, () => newPool(bad, '/r', 1)), bad).rejects.toBeInstanceOf(OrchError)
    }
    expect(() => writePool(h, newPool('../evil', '/r', 1))).toThrow(/invalid session id/)
    expect(readdirSync(h)).toEqual([])
    expect(readdirSync(join(h, '..')).includes('evil.json')).toBe(false)
  })

  it.each([
    ['{broken', /not valid JSON/],
    ['null', /not a pool/],
    ['{}', /not a pool/],
  ])('reports a corrupt pool file (%s) instead of trusting it', async (text, message) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), text)
    expect(() => readPool(h, 's1')).toThrow(OrchError)
    expect(() => readPool(h, 's1')).toThrow(message)
    const [entry] = listPools(h)
    expect(entry.id).toBe('s1')
    expect(entry.pool).toBeUndefined()
    expect(entry.error).toMatch(message)
    await expect(update(h, 's1', p => p!)).rejects.toBeInstanceOf(OrchError)
    expect(existsSync(join(h, 's1.json.lock'))).toBe(false)
  })

  it.each([
    ['a null task', [null]],
    ['a task that is a string', ['t1']],
    ['a task with no text', [{ id: 't1', status: 'pending' }]],
    ['a numeric text', [{ id: 't1', text: 3, status: 'pending' }]],
    ['a numeric id', [{ id: 1, text: 'x', status: 'pending' }]],
    ['a task with no id', [{ text: 'x', status: 'pending' }]],
    ['an unknown status', [{ id: 't1', text: 'x', status: 'weird' }]],
    ['no status', [{ id: 't1', text: 'x' }]],
    ['children that is a string', [{ id: 't1', text: 'x', status: 'pending', children: 'C1' }]],
    ['children holding a number', [{ id: 't1', text: 'x', status: 'pending', children: ['C1', 2] }]],
    ['a good task followed by a bad one', [{ id: 't1', text: 'x', status: 'done' }, null]],
  ])('flags a pool with %s as unreadable instead of trusting it', (_name, tasks) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
    expect(() => readPool(h, 's1')).toThrow(/is not a pool; fix or delete it/)
  })

  it.each([
    ['a numeric cwd', { cwd: 5 }],
    ['a null cwd', { cwd: null }],
    ['no cwd', { cwd: undefined }],
  ])('flags a pool with %s as unreadable', (_name, over) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), ...over }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
    expect(() => readPool(h, 's1')).toThrow(/is not a pool; fix or delete it/)
  })

  it.each([
    ['an escape code', 't\u001b[31m1'],
    ['a newline', 't1\n'],
    ['a space', 't 1'],
    ['an empty string', ''],
    ['a slash', 't/1'],
    ['a non-ASCII letter', 'tä'],
  ])('flags a pool whose task id holds %s as unreadable', (_name, id) => {
    const h = home()
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks: [{ id, text: 'x', status: 'pending' }] }))
    expect(listPools(h)).toEqual([{ id: 's1', error: expect.stringMatching(/s1\.json is not a pool; fix or delete it$/) }])
  })

  it.each(['t1', 't12', 'T-3', 'task_4', '7'])('accepts the task id %s', id => {
    const h = home()
    const tasks = [{ id, text: 'x', status: 'pending' }]
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', pool: expect.objectContaining({ tasks }) }])
  })

  it('accepts every task shape the CLI writes', () => {
    const h = home()
    const tasks = [
      { id: 't1', text: 'a', status: 'pending' },
      { id: 't2', text: 'b', status: 'in_progress', children: ['C1', 'C2'], needsInput: 'q?' },
      { id: 't3', text: 'c', status: 'done', evidence: { kind: 'commit', ref: 'abc1234' } },
      { id: 't4', text: 'd', status: 'blocked', blockedReason: 'key' },
    ]
    writeFileSync(join(h, 's1.json'), JSON.stringify({ ...newPool('s1', '/r', 1), tasks }))
    expect(listPools(h)).toEqual([{ id: 's1', pool: expect.objectContaining({ tasks }) }])
  })

  it('writePool cleans up its temp file when the write fails', () => {
    const h = home()
    mkdirSync(poolPath(h, 's1'))
    expect(() => writePool(h, newPool('s1', '/r', 1))).toThrow()
    expect(readdirSync(h).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('appends to orch.log', () => {
    const h = home()
    log(h, 'hello')
    expect(readFileSync(join(h, 'orch.log'), 'utf8')).toMatch(/Z hello\n$/)
  })

  it('rotates orch.log once it passes 1 MB', () => {
    const h = home()
    const big = 'x'.repeat(1024 * 1024 + 10)
    writeFileSync(join(h, 'orch.log'), big)
    log(h, 'after')
    expect(statSync(join(h, 'orch.log.1')).size).toBe(big.length)
    expect(readFileSync(join(h, 'orch.log'), 'utf8')).toMatch(/Z after\n$/)
    expect(statSync(join(h, 'orch.log')).size).toBeLessThan(200)
    // a second rotation replaces the old backup
    writeFileSync(join(h, 'orch.log'), big + big)
    log(h, 'again')
    expect(statSync(join(h, 'orch.log.1')).size).toBe(2 * big.length)
  })

  it('log never throws', () => {
    const h = home()
    mkdirSync(join(h, 'orch.log'))
    expect(() => log(h, 'into a directory')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/store.test.ts`
Expected: FAIL, `Cannot find module '../src/store.js'`.

- [ ] **Step 3: Implement**

`src/store.ts`:

```ts
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { OrchError } from './errors.js'
import type { Pool, Status, Task } from './model.js'

export type PoolEntry = { id: string; pool?: Pool; error?: string }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Every pool, lock and temp path is built here, so this is the one place that vets a session id.
export function poolPath(home: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new OrchError(`invalid session id "${id}"`)
  return join(home, `${id}.json`)
}

// orch itself only writes t1, t2 and so on; anything else was edited in by hand, and an id is printed as is.
const TASK_ID = /^[A-Za-z0-9_-]+$/

const STATUSES: readonly Status[] = ['pending', 'in_progress', 'done', 'blocked']

// One malformed task (null, no text, a numeric id) would otherwise throw deep inside the overview and
// take every view down, so a pool with such a task is an unreadable pool.
function isTask(v: unknown): v is Task {
  const t = v as Partial<Task> | null | undefined
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    TASK_ID.test(t.id) &&
    typeof t.text === 'string' &&
    STATUSES.includes(t.status as Status) &&
    (t.children === undefined || (Array.isArray(t.children) && t.children.every(c => typeof c === 'string')))
  )
}

function isPool(v: unknown): v is Pool {
  const p = v as Partial<Pool> | null | undefined
  return typeof p?.sessionId === 'string' && typeof p.cwd === 'string' && Array.isArray(p.tasks) && p.tasks.every(isTask)
}

// A pool file must hold the session its name says; a copy such as backup1.json would otherwise
// show up as a second session with the original's tasks and questions.
function parsePool(path: string, id: string, text: string): Pool {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    throw new OrchError(`pool file ${path} is not valid JSON (${(e as Error).message}); fix or delete it`)
  }
  if (!isPool(v)) throw new OrchError(`pool file ${path} is not a pool; fix or delete it`)
  if (v.sessionId !== id) throw new OrchError(`pool file ${path} holds session ${v.sessionId}; fix or delete it`)
  return v
}

export function readPool(home: string, id: string): Pool | undefined {
  const path = poolPath(home, id)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return parsePool(path, id, text)
}

export function writePool(home: string, pool: Pool): void {
  const path = poolPath(home, pool.sessionId)
  mkdirSync(home, { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, JSON.stringify(pool, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the original failure is the one worth reporting
    }
    throw e
  }
}

export function listPools(home: string): PoolEntry[] {
  let names: string[]
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  // Names that are not valid session ids are never written by orch; skip them like temp files and lock dirs.
  return names
    .filter(n => n.endsWith('.json') && ID_PATTERN.test(n.slice(0, -'.json'.length)))
    .map(n => {
      const id = n.slice(0, -'.json'.length)
      const path = join(home, n)
      try {
        return { id, pool: parsePool(path, id, readFileSync(path, 'utf8')) }
      } catch (e) {
        return { id, error: e instanceof Error ? e.message : String(e) }
      }
    })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A holder only keeps the lock for one synchronous read-modify-write, so a lock older than staleMs
// belongs to a crashed process. A caller gives up after deadlineMs, which is longer than staleMs so
// that it outlasts a crashed holder instead of failing while the lock is still being broken.
// Exported so tests can shrink the times.
export const lockTiming = { staleMs: 5_000, deadlineMs: 7_000 }

// waitMs: how long this caller waits for the lock; hooks pass a short one so they never stall a prompt.
async function withLock<T>(home: string, id: string, fn: () => T, waitMs = lockTiming.deadlineMs): Promise<T> {
  const lock = `${poolPath(home, id)}.lock`
  mkdirSync(home, { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    let held = 0
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Known race: two processes that both judge the same crashed holder's lock stale can, inside a
      // microseconds-wide window, both proceed (one removes the other's fresh lock). That needs a
      // crash first, costs at most one lost update, and the pool file stays valid JSON because
      // writePool renames atomically.
      try {
        held = Date.now() - statSync(lock).mtimeMs
        if (held > lockTiming.staleMs) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // released meanwhile: retry now
        throw new OrchError(`cannot break stale lock ${lock}: ${(err as Error).message}`)
      }
      if (Date.now() > deadline) {
        throw new OrchError(
          `pool ${id} is locked (${lock}, held ${Math.round(held)} ms); if no orch is running, delete that directory`,
        )
      }
      await sleep(10 + Math.random() * 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// writePool names the file after pool.sessionId while the lock guards `id`; they must agree.
function writeUnder(home: string, id: string, next: Pool): Pool {
  if (next.sessionId !== id) {
    throw new OrchError(`refusing to write pool ${next.sessionId} under session ${id}`)
  }
  writePool(home, next)
  return next
}

// Read, change and write one pool under its lock. Never hold two locks at once.
export function update(home: string, id: string, fn: (p: Pool | undefined) => Pool, waitMs?: number): Promise<Pool> {
  return withLock(home, id, () => writeUnder(home, id, fn(readPool(home, id))), waitMs)
}

export function updateIfExists(home: string, id: string, fn: (p: Pool) => Pool, waitMs?: number): Promise<Pool | undefined> {
  return withLock(
    home,
    id,
    () => {
      const cur = readPool(home, id)
      if (!cur) return undefined
      return writeUnder(home, id, fn(cur))
    },
    waitMs,
  )
}

const LOG_MAX_BYTES = 1024 * 1024

export function log(home: string, message: string): void {
  try {
    mkdirSync(home, { recursive: true })
    const file = join(home, 'orch.log')
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // no log yet, or another process rotated it first
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never fail a hook
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test -- tests/store.test.ts && npm run typecheck`
Expected: all store tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/src/store.ts plugins/orchestrator/tests/store.test.ts
git commit -m "Add the orchestrator pool store with atomic writes and locks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 4: Evidence

**Files:**
- Create: `plugins/orchestrator/src/evidence.ts`
- Test: `plugins/orchestrator/tests/evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { checkKey, describeEvidence, grade, oneLine, parseEvidence } from '../src/evidence.js'
import type { Evidence } from '../src/model.js'

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('parseEvidence', () => {
  it('splits on the first colon', () => {
    expect(parseEvidence('ci:https://github.com/o/r/actions/runs/1')).toEqual({ kind: 'ci', ref: 'https://github.com/o/r/actions/runs/1' })
    expect(parseEvidence('cmd: npm test -- --run')).toEqual({ kind: 'cmd', ref: 'npm test -- --run' })
  })

  it('accepts every kind', () => {
    expect(parseEvidence('commit:9f3e2a1')).toEqual({ kind: 'commit', ref: '9f3e2a1' })
    expect(parseEvidence(`commit:${'a'.repeat(64)}`)).toEqual({ kind: 'commit', ref: 'a'.repeat(64) })
    expect(parseEvidence('pr:41')).toEqual({ kind: 'pr', ref: '41' })
    expect(parseEvidence('note: looked fine ')).toEqual({ kind: 'note', ref: 'looked fine' })
  })

  it('rejects unknown kinds and empty refs', () => {
    expect(() => parseEvidence('sha:abc')).toThrow(OrchError)
    expect(() => parseEvidence('commit:')).toThrow(/commit:<sha>/)
    expect(() => parseEvidence('abc')).toThrow(OrchError)
  })

  it('rejects no colon, a leading colon and a blank ref', () => {
    for (const s of ['notee', 'commitx', ':abc', 'note:   ']) expect(() => parseEvidence(s), s).toThrow(OrchError)
  })

  it('fails with exit code 2', () => {
    const err = thrown(() => parseEvidence('sha:abc'))
    expect(err).toBeInstanceOf(OrchError)
    expect(err).toMatchObject({ code: 2 })
  })

  it('requires a commit ref that looks like a sha', () => {
    for (const s of ['commit:fixed the login bug', 'commit:HEAD', 'commit:done', 'commit:abc', `commit:${'a'.repeat(65)}`]) {
      expect(() => parseEvidence(s), s).toThrow(/commit needs a sha, e\.g\. commit:\$\(git rev-parse --short HEAD\)/)
    }
    expect(thrown(() => parseEvidence('commit:HEAD'))).toMatchObject({ code: 2 })
    expect(parseEvidence('commit:abc1')).toEqual({ kind: 'commit', ref: 'abc1' })
    expect(parseEvidence('commit:9F3E2A1')).toEqual({ kind: 'commit', ref: '9F3E2A1' })
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(parseEvidence(`commit:${sha}`)).toEqual({ kind: 'commit', ref: sha })
  })
})

describe('grade', () => {
  it('trusts commits and commands orch ran, not notes', () => {
    expect(grade({ kind: 'commit', ref: 'a' })).toBe('proven')
    expect(grade({ kind: 'cmd', ref: 'x', exit: 0 })).toBe('proven')
    expect(grade({ kind: 'note', ref: 'x' })).toBe('claimed')
    expect(grade(undefined)).toBe('claimed')
  })

  it('contradicts a command that failed', () => {
    expect(grade({ kind: 'cmd', ref: 'x', exit: 1 })).toBe('contradicted')
  })

  it('follows the live check for CI and PRs', () => {
    expect(grade({ kind: 'ci', ref: 'u' }, 'pass')).toBe('proven')
    expect(grade({ kind: 'pr', ref: '4' }, 'fail')).toBe('contradicted')
    expect(grade({ kind: 'pr', ref: '4' }, 'pending')).toBe('unverified')
    expect(grade({ kind: 'ci', ref: 'u' })).toBe('unverified')
  })

  it('leaves CI unverified, never contradicted, when gh could not tell', () => {
    expect(grade({ kind: 'ci', ref: 'u' }, 'unknown')).toBe('unverified')
  })
})

describe('describeEvidence', () => {
  it('formats each kind', () => {
    expect(describeEvidence({ kind: 'commit', ref: '9f3e2a1c0ffee' })).toBe('commit 9f3e2a1')
    expect(describeEvidence({ kind: 'cmd', ref: 'npm test', exit: 0 })).toBe('cmd npm test (exit 0)')
    expect(describeEvidence({ kind: 'note', ref: 'looked fine' })).toBe('note: looked fine')
    expect(describeEvidence({ kind: 'pr', ref: '41' })).toBe('pr 41')
    expect(describeEvidence({ kind: 'ci', ref: 'u' })).toBe('ci u')
  })

  it('keeps the result on one line without escape codes', () => {
    expect(describeEvidence({ kind: 'note', ref: 'line1\nline2' })).toBe('note: line1 line2')
    const out = describeEvidence({ kind: 'note', ref: '\u001b[31mred' })
    expect(out).not.toContain('\u001b')
    expect(out).toBe('note: [31mred')
  })

  it('does not throw on a hand-edited pool entry without a ref', () => {
    expect(() => describeEvidence({ kind: 'commit' } as unknown as Evidence)).not.toThrow()
  })
})

describe('oneLine', () => {
  it('folds whitespace and control characters into single spaces', () => {
    expect(oneLine('a\n b\t\tc')).toBe('a b c')
    expect(oneLine('  x  ')).toBe('x')
    expect(oneLine('a\u001b]0;t\u0007b')).toBe('a ]0;t b')
    expect(oneLine('\u001b\u0007')).toBe('')
  })

  it('turns anything that is not text into text', () => {
    expect(oneLine(undefined)).toBe('')
    expect(oneLine(null)).toBe('')
    expect(oneLine(42)).toBe('42')
    expect(oneLine('')).toBe('')
  })
})

describe('checkKey', () => {
  it('keys a check by repo as well as by ref', () => {
    const pr: Evidence = { kind: 'pr', ref: '41' }
    expect(checkKey(pr, '/a')).toBe('/a\0pr:41')
    expect(checkKey(pr, '/a')).not.toBe(checkKey(pr, '/b'))
    expect(checkKey(pr, '/a')).not.toBe(checkKey({ kind: 'ci', ref: '41' }, '/a'))
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/evidence.test.ts`
Expected: FAIL, `Cannot find module '../src/evidence.js'`.

- [ ] **Step 3: Implement**

`src/evidence.ts`:

```ts
import { OrchError } from './errors.js'
import type { Evidence } from './model.js'

type Kind = Evidence['kind']

export type Check = 'pass' | 'fail' | 'pending' | 'unknown'
export type Grade = 'proven' | 'claimed' | 'contradicted' | 'unverified'
// cmd evidence gets its exit code from orch running the command, so the parsed form has none
export type ParsedEvidence = Exclude<Evidence, { kind: 'cmd' }> | { kind: 'cmd'; ref: string }

const KINDS: readonly Kind[] = ['commit', 'pr', 'ci', 'cmd', 'note']
const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k)
const USAGE = 'use commit:<sha> | pr:<number|url> | ci:<run-url> | cmd:<command> | note:<text>'
const SHA = /^[0-9a-f]{4,64}$/i

export function parseEvidence(s: string): ParsedEvidence {
  const i = s.indexOf(':')
  const kind = s.slice(0, i)
  const ref = s.slice(i + 1).trim()
  if (i < 1 || !isKind(kind) || !ref) throw new OrchError(`bad evidence "${s}": ${USAGE}`, 2)
  if (kind === 'commit' && !SHA.test(ref)) {
    throw new OrchError(`bad evidence "${s}": commit needs a sha, e.g. commit:$(git rev-parse --short HEAD)`, 2)
  }
  return { kind, ref }
}

export function grade(ev: Evidence | undefined, check?: Check): Grade {
  if (!ev || ev.kind === 'note') return 'claimed'
  if (ev.kind === 'commit') return 'proven'
  if (ev.kind === 'cmd') return ev.exit === 0 ? 'proven' : 'contradicted'
  if (check === 'pass') return 'proven'
  if (check === 'fail') return 'contradicted'
  return 'unverified'
}

// Text a session wrote, folded onto one line with control characters (ESC, BEL, newlines) gone, so it
// cannot move the cursor or retitle the terminal when it is printed.
export const oneLine = (s: unknown): string => String(s ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim()

export function describeEvidence(ev: Evidence): string {
  const ref = oneLine(ev.ref)
  switch (ev.kind) {
    case 'commit':
      return `commit ${ref.slice(0, 7)}`
    case 'cmd':
      return `cmd ${ref} (exit ${String(ev.exit)})`
    case 'note':
      return `note: ${ref}`
    default:
      return `${ev.kind} ${ref}`
  }
}

// gh resolves a bare PR or run number against the repo in cwd, so the same ref in two repos is two checks
export const checkKey = (ev: Evidence, cwd: string) => `${cwd}\0${ev.kind}:${ev.ref}`
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test -- tests/evidence.test.ts && npm run typecheck`
Expected: all evidence tests pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/src/evidence.ts plugins/orchestrator/tests/evidence.test.ts
git commit -m "Add evidence parsing and grading" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 5: Live sessions source

**Files:**
- Create: `plugins/orchestrator/src/sources/sessions.ts`
- Create: `plugins/orchestrator/tests/fixtures/claude/sessions/101.json`, `102.json`, `103.json`, `104.json`, `105.json.tmp`, `106.json`, `107.json`, `108.json`
- Test: `plugins/orchestrator/tests/sessions.test.ts`

- [ ] **Step 1: Write the fixtures**

These mirror the real files in `~/.claude/sessions/` (trimmed). `101.json`:

```json
{"pid":101,"sessionId":"s-parent","cwd":"/home/u/src/ItAbyss","startedAt":1791579905579,"version":"2.1.257","kind":"interactive","entrypoint":"cli","name":"beginner-courses","nameSource":"user","status":"idle","updatedAt":1791968067114,"procStart":"4242424","pidDomain":"linux:0123456789abcdef0123456789abcdef:pid:[4026531836]","bridgeSessionId":"session_01Parent"}
```

`102.json`:

```json
{"pid":102,"sessionId":"s-python","cwd":"/home/u/src/ItAbyss/.worktrees/course-python","kind":"interactive","entrypoint":"cli","name":"course-python-5f","status":"busy","updatedAt":1791968067000,"procStart":"4242425","pidDomain":"linux:0123456789abcdef0123456789abcdef:pid:[4026531836]","bridgeSessionId":null}
```

`103.json` (its process is gone):

```json
{"pid":103,"sessionId":"s-dead","cwd":"/tmp","kind":"interactive","status":"idle"}
```

`104.json`:

```
{not json
```

`105.json.tmp` (a valid session under a name that is not `<pid>.json`, standing in for half-written files and the `<pid>.<hash>.key` files the real directory also holds):

```json
{"pid":105,"sessionId":"s-temp","cwd":"/tmp","status":"idle"}
```

`106.json` (blocked on a dialog):

```json
{"pid":106,"sessionId":"s-wait","cwd":"/tmp","status":"waiting","waitingFor":"dialog open"}
```

`107.json` (a pre-started spare process, not a session yet):

```json
{"pid":107,"sessionId":"s-spare","cwd":"/tmp","status":"idle","spare":true}
```

`108.json` (pid is not a number):

```json
{"pid":"108","sessionId":"s-strpid","cwd":"/tmp","status":"idle"}
```

- [ ] **Step 2: Write the failing tests**

`tests/sessions.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type LiveSession, pidAlive, readLiveSessions, sessionLink } from '../src/sources/sessions.js'

const claudeHome = fileURLToPath(new URL('./fixtures/claude', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A claude home whose sessions/ holds exactly these files.
function homeWith(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'orch-sessions-'))
  dirs.push(home)
  mkdirSync(join(home, 'sessions'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, 'sessions', name), body)
  return home
}

const alive = () => true

describe('readLiveSessions', () => {
  it('reads live sessions and skips dead pids, broken files, other names, spares and string pids', () => {
    const s = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.sessionId)).toEqual(['s-parent', 's-python', 's-wait'])
    expect(s[0]).toMatchObject({ name: 'beginner-courses', status: 'idle', bridgeSessionId: 'session_01Parent' })
    expect(s[0].waitingFor).toBeUndefined()
    expect(s[1].status).toBe('busy')
    // Claude Code writes "bridgeSessionId": null outside Remote Control
    expect(s[1].bridgeSessionId).toBeUndefined()
  })

  it('surfaces a session that waits on a dialog as idle with waitingFor', () => {
    const s = readLiveSessions(claudeHome, pid => pid !== 103).find(x => x.sessionId === 's-wait')
    expect(s).toMatchObject({ status: 'idle', waitingFor: 'dialog open' })
  })

  it('hands each record procStart to the liveness check', () => {
    const seen = new Map<number, string | undefined>()
    readLiveSessions(claudeHome, (pid, procStart) => {
      seen.set(pid, procStart)
      return true
    })
    expect(seen.get(101)).toBe('4242424')
    expect(seen.has(103)).toBe(true)
    expect(seen.get(103)).toBeUndefined()
    // a string pid never reaches the liveness check
    expect(seen.has(108)).toBe(false)
  })

  it('returns nothing when the directory is missing', () => {
    expect(readLiveSessions('/nonexistent', () => true)).toEqual([])
  })

  it('maps every status except busy to idle', () => {
    const home = homeWith({
      '201.json': '{"pid":201,"sessionId":"s-none","cwd":"/tmp"}',
      '202.json': '{"pid":202,"sessionId":"s-shell","cwd":"/tmp","status":"shell"}',
      '203.json': '{"pid":203,"sessionId":"s-busy","cwd":"/tmp","status":"busy"}',
      '204.json': '{"pid":204,"sessionId":"s-bare-wait","cwd":"/tmp","status":"waiting"}',
    })
    const s = readLiveSessions(home, alive).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.status)).toEqual(['idle', 'idle', 'busy', 'idle'])
    expect(s.map(x => x.waitingFor)).toEqual([undefined, undefined, undefined, 'input'])
  })

  it('falls back to input when a waiting session names nothing readable, and cleans what it names', () => {
    const waiting = (pid: number, waitingFor: unknown) =>
      `${JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: '/tmp', status: 'waiting', waitingFor })}`
    const home = homeWith({
      '231.json': waiting(231, '  '),
      '232.json': waiting(232, ''),
      '233.json': waiting(233, '\n\u001b\u0007'),
      '234.json': waiting(234, 7),
      '235.json': waiting(235, 'dialog\nopen\u001b]0;x\u0007'),
      '236.json': waiting(236, 'permission prompt'),
    })
    const s = readLiveSessions(home, alive).sort((a, b) => a.pid - b.pid)
    expect(s.map(x => x.waitingFor)).toEqual(['input', 'input', 'input', 'input', 'dialog open ]0;x', 'permission prompt'])
    expect(s.every(x => x.status === 'idle')).toBe(true)
  })

  it('falls back to an empty cwd and no name when they are not strings', () => {
    const home = homeWith({
      '221.json': '{"pid":221,"sessionId":"s-bare","status":"idle"}',
      '222.json': '{"pid":222,"sessionId":"s-odd","cwd":7,"name":7,"status":"idle"}',
    })
    const s = readLiveSessions(home, alive)
    expect(s.map(x => x.cwd)).toEqual(['', ''])
    expect(s.map(x => x.name)).toEqual([undefined, undefined])
  })

  it('skips parked jobs and files that are not objects', () => {
    const home = homeWith({
      '211.json': '{"pid":211,"sessionId":"s-parked","cwd":"/tmp","status":"idle","parkedJobId":"job-1"}',
      '212.json': 'null',
      '213.json': '{"pid":213,"sessionId":"s-ok","cwd":"/tmp","status":"idle"}',
    })
    expect(readLiveSessions(home, alive).map(x => x.sessionId)).toEqual(['s-ok'])
  })

  it('builds the claude.ai link from bridgeSessionId', () => {
    const [p, py] = readLiveSessions(claudeHome, pid => pid !== 103).sort((a, b) => a.pid - b.pid)
    expect(sessionLink(p)).toBe('https://claude.ai/code/session_01Parent')
    expect(sessionLink(py)).toBeUndefined()
  })
})

describe('sessionLink', () => {
  const live = (bridgeSessionId?: string): LiveSession => ({ pid: 1, sessionId: 's', cwd: '/', status: 'idle', bridgeSessionId })

  it('rewrites the cse_ prefix to session_', () => {
    expect(sessionLink(live('cse_X'))).toBe('https://claude.ai/code/session_X')
  })

  it('refuses ids that could carry escape codes or path tricks', () => {
    expect(sessionLink(live('bad\u001b[31m'))).toBeUndefined()
    expect(sessionLink(live('a/../b'))).toBeUndefined()
    expect(sessionLink(live(''))).toBeUndefined()
    expect(sessionLink(undefined)).toBeUndefined()
  })
})

describe('pidAlive', () => {
  const hasProc = (() => {
    try {
      readFileSync('/proc/self/stat', 'utf8')
      return true
    } catch {
      return false
    }
  })()

  it('sees its own process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('rejects pids that mean a group, init or nothing', () => {
    expect(pidAlive(1)).toBe(false)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(2 ** 22 + 1)).toBe(false)
  })

  it.skipIf(!hasProc)('compares the process start time to spot a recycled pid', () => {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    expect(pidAlive(process.pid, startTime)).toBe(true)
    expect(pidAlive(process.pid, '1')).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/sessions.test.ts`
Expected: FAIL, `Cannot find module '../src/sources/sessions.js'`.

- [ ] **Step 4: Implement**

`src/sources/sessions.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { oneLine } from '../evidence.js'

export type LiveSession = {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status: 'busy' | 'idle'
  // set while a permission prompt or dialog blocks the session (Claude writes status "waiting")
  waitingFor?: string
  bridgeSessionId?: string
}

// Field 22 of /proc/<pid>/stat; Claude Code stores it as procStart to spot a recycled pid.
function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

export function pidAlive(pid: number, procStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false // ESRCH: gone; EPERM: another user's process, so the pid was reused
  }
  if (procStart === undefined) return true
  const now = startTimeOf(pid)
  return now === undefined || now === procStart
}

// One file per running Claude process: ~/.claude/sessions/<pid>.json. A file can outlive its process.
export function readLiveSessions(
  claudeHome: string,
  isAlive: (pid: number, procStart?: string) => boolean = pidAlive,
): LiveSession[] {
  const dir = join(claudeHome, 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue
    try {
      const o = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>
      // spare and parked processes are pre-started and not sessions yet
      if (o.spare === true || typeof o.parkedJobId === 'string') continue
      if (typeof o.sessionId !== 'string' || typeof o.pid !== 'number') continue
      if (!isAlive(o.pid, typeof o.procStart === 'string' ? o.procStart : undefined)) continue
      out.push({
        pid: o.pid,
        sessionId: o.sessionId,
        cwd: typeof o.cwd === 'string' ? o.cwd : '',
        name: typeof o.name === 'string' ? o.name : undefined,
        status: o.status === 'busy' ? 'busy' : 'idle',
        // a blank or unprintable reason still means the session is waiting, so it falls back to 'input'
        waitingFor: o.status === 'waiting' ? oneLine(typeof o.waitingFor === 'string' ? o.waitingFor : '') || 'input' : undefined,
        bridgeSessionId: typeof o.bridgeSessionId === 'string' ? o.bridgeSessionId : undefined,
      })
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return out
}

export function sessionLink(s: LiveSession | undefined): string | undefined {
  const id = s?.bridgeSessionId?.replace(/^cse_/, 'session_')
  // the id goes into a terminal link, so anything but plain id characters is refused
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? `https://claude.ai/code/${id}` : undefined
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm test -- tests/sessions.test.ts && npm run typecheck`
Expected: all session tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/src/sources/sessions.ts plugins/orchestrator/tests/sessions.test.ts plugins/orchestrator/tests/fixtures
git commit -m "Read live Claude sessions from the session registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 6: herdr and gh sources

**Files:**
- Create: `plugins/orchestrator/src/sources/herdr.ts`
- Create: `plugins/orchestrator/src/sources/gh.ts`
- Create: `plugins/orchestrator/tests/fixtures/herdr-agent-list.json`
- Test: `plugins/orchestrator/tests/herdr.test.ts`, `plugins/orchestrator/tests/gh.test.ts`

- [ ] **Step 1: Write the fixture**

`tests/fixtures/herdr-agent-list.json`, trimmed from a real `herdr agent list`:

```json
{"id":"cli:agent:list","result":{"agents":[
{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"s-parent"},"agent_status":"done","cwd":"/home/u/src/ItAbyss","name":"beginner-courses","pane_id":"w1:pR","tab_id":"w1:tR","terminal_title_stripped":"Beginner courses for all languages","workspace_id":"w1"},
{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"s-python"},"agent_status":"working","cwd":"/home/u/src/ItAbyss/.worktrees/course-python","name":"course-python","pane_id":"wS:p1","tab_id":"wS:t1","terminal_title_stripped":"TEC-660 python-beginners course","workspace_id":"wS"},
{"agent":"codex","agent_status":"idle","cwd":"/tmp","pane_id":"wZ:p1","workspace_id":"wZ"}
],"type":"agent_list"}}
```

- [ ] **Step 2: Write the failing tests**

`tests/herdr.test.ts`:

```ts
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchError } from '../src/errors.js'
import { cliHerdr, HerdrError, runHerdr, type Run } from '../src/sources/herdr.js'

const listJson = readFileSync(new URL('./fixtures/herdr-agent-list.json', import.meta.url), 'utf8')

type Reply = { code?: number; stdout?: string; stderr?: string; error?: string }

function fakeRun(replies: Record<string, Reply>) {
  const calls: string[][] = []
  const timeouts: (number | undefined)[] = []
  const run: Run = async (args, timeoutMs) => {
    calls.push(args)
    timeouts.push(timeoutMs)
    const r = replies[args.slice(0, 2).join(' ')] ?? {}
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
  }
  return { run, calls, timeouts }
}

const agentOf = (session: unknown, status = 'idle') =>
  JSON.stringify({ result: { agent: { agent_status: status, agent_session: session } } })

describe('cliHerdr', () => {
  it('lists claude agents only', async () => {
    const { run } = fakeRun({ 'agent list': { stdout: listJson } })
    const agents = await cliHerdr(run).list()
    expect(agents).toEqual([
      { name: 'beginner-courses', paneId: 'w1:pR', status: 'done', sessionId: 's-parent', title: 'Beginner courses for all languages' },
      { name: 'course-python', paneId: 'wS:p1', status: 'working', sessionId: 's-python', title: 'TEC-660 python-beginners course' },
    ])
  })

  it('throws OrchError when herdr fails', async () => {
    const { run } = fakeRun({ 'agent list': { code: 1, stderr: 'server not running' } })
    await expect(cliHerdr(run).list()).rejects.toThrow(OrchError)
  })

  it('creates a tab and starts claude with the given args', async () => {
    const { run, calls } = fakeRun({ 'tab create': { stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) } })
    const h = cliHerdr(run)
    expect(await h.createTab({ workspace: 'w1', cwd: '/r', label: 'go' })).toEqual({ paneId: 'w1:p9' })
    await h.startClaude({ name: 'go', paneId: 'w1:p9', args: ['--remote-control', 'go'] })
    expect(calls[0]).toEqual(['tab', 'create', '--workspace', 'w1', '--cwd', '/r', '--label', 'go', '--no-focus'])
    expect(calls[1]).toEqual(['agent', 'start', 'go', '--kind', 'claude', '--pane', 'w1:p9', '--timeout', '60000', '--', '--remote-control', 'go'])
  })

  it('reads a session id, or undefined when the agent is unknown', async () => {
    const get = agentOf({ kind: 'id', value: 's-new' })
    expect(await cliHerdr(fakeRun({ 'agent get': { stdout: get } }).run).sessionIdOf('go')).toBe('s-new')
    expect(await cliHerdr(fakeRun({ 'agent get': { code: 1 } }).run).sessionIdOf('go')).toBeUndefined()
  })

  it('waits for a resting state and reports it', async () => {
    const get = JSON.stringify({ result: { agent: { agent_status: 'blocked' } } })
    const { run, calls } = fakeRun({ 'agent get': { stdout: get } })
    expect(await cliHerdr(run).waitIdle('w1:p1', 5000)).toBe('blocked')
    expect(calls[0]).toEqual(['agent', 'wait', 'w1:p1', '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', '5000'])
  })

  it('prompts and focuses', async () => {
    const { run, calls } = fakeRun({})
    const h = cliHerdr(run)
    await h.prompt('w1:p1', 'hello')
    await h.focus('w1:p1')
    expect(calls).toEqual([['agent', 'prompt', 'w1:p1', 'hello'], ['agent', 'focus', 'w1:p1']])
  })
})

describe('cliHerdr failures', () => {
  // orch reply clears a flag only after prompt resolves, so a failed send must reject
  it.each([
    ['prompt', (h: ReturnType<typeof cliHerdr>) => h.prompt('w1:p1', 'hi')],
    ['wait', (h: ReturnType<typeof cliHerdr>) => h.waitIdle('w1:p1', 5000)],
    ['focus', (h: ReturnType<typeof cliHerdr>) => h.focus('w1:p1')],
    ['start', (h: ReturnType<typeof cliHerdr>) => h.startClaude({ name: 'go', paneId: 'w1:p1', args: [] })],
  ])('rejects with OrchError when agent %s exits non-zero', async (sub, call) => {
    // agent get answers fine, so only the failing call itself can make the promise reject
    const { run } = fakeRun({ [`agent ${sub}`]: { code: 1, stderr: 'nope' }, 'agent get': { stdout: agentOf(undefined) } })
    const e = await call(cliHerdr(run)).catch(x => x)
    expect(e).toBeInstanceOf(OrchError)
    expect(e.message).toBe(`herdr agent ${sub} failed: nope`)
  })

  it('turns the JSON error form into a HerdrError with its code', async () => {
    const stderr = JSON.stringify({ error: { code: 'agent_blocked', message: 'agent is waiting for input' } })
    const e = await cliHerdr(fakeRun({ 'agent prompt': { code: 1, stderr } }).run).prompt('w1:p1', 'hi').catch(x => x)
    expect(e).toBeInstanceOf(HerdrError)
    expect(e).toBeInstanceOf(OrchError)
    expect(e.message).toBe('herdr agent prompt failed: agent is waiting for input (agent_blocked)')
    expect(e.herdrCode).toBe('agent_blocked')
  })

  it('reads the JSON error from stdout when stderr is empty', async () => {
    const stdout = JSON.stringify({ error: { code: 'agent_not_ready', message: 'pane is not at a prompt' } })
    const e = await cliHerdr(fakeRun({ 'agent start': { code: 1, stdout } }).run)
      .startClaude({ name: 'go', paneId: 'w1:p1', args: [] })
      .catch(x => x)
    expect(e).toBeInstanceOf(HerdrError)
    expect(e.herdrCode).toBe('agent_not_ready')
    expect(e.message).toBe('herdr agent start failed: pane is not at a prompt (agent_not_ready)')
  })

  it('falls back to trimmed stderr, then stdout, then the exec error', async () => {
    const msg = async (r: Reply) => {
      const e = await cliHerdr(fakeRun({ 'agent list': { code: 1, ...r } }).run).list().catch(x => x)
      expect(e).toBeInstanceOf(HerdrError)
      expect(e.herdrCode).toBeUndefined()
      return e.message
    }
    expect(await msg({ stderr: '  server not running\n', stdout: 'ignored', error: 'ignored too' })).toBe('herdr agent list failed: server not running')
    expect(await msg({ stdout: ' only stdout \n', error: 'ignored' })).toBe('herdr agent list failed: only stdout')
    expect(await msg({ error: 'spawn herdr ENOENT' })).toBe('herdr agent list failed: spawn herdr ENOENT')
    // JSON that is not the error form is just text
    expect(await msg({ stderr: '{"oops":1}' })).toBe('herdr agent list failed: {"oops":1}')
  })

  it.each([
    ['output that is not JSON', 'herdr: oops'],
    ['JSON null', 'null'],
    ['a reply without result', '{}'],
    ['a reply without an agents array', '{"result":{}}'],
    ['agents that is not an array', '{"result":{"agents":{}}}'],
  ])('rejects agent list with %s as an OrchError', async (_what, stdout) => {
    await expect(cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()).rejects.toThrow(OrchError)
  })

  it('skips list entries that are not agents with a pane', async () => {
    const stdout = JSON.stringify({ result: { agents: [null, 'x', { agent: 'claude' }, { agent: 'claude', pane_id: 'w1:p1', agent_status: 'idle' }] } })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents.map(a => a.paneId)).toEqual(['w1:p1'])
  })

  it('rejects a tab create reply without a pane id, or without JSON', async () => {
    const make = (stdout: string) => cliHerdr(fakeRun({ 'tab create': { stdout } }).run).createTab({ workspace: 'w1', cwd: '/r', label: 'go' })
    await expect(make('{"result":{"root_pane":{}}}')).rejects.toThrow(OrchError)
    await expect(make('{"result":{}}')).rejects.toThrow(OrchError)
    await expect(make('not json')).rejects.toThrow(OrchError)
  })

  it('rejects a wait whose follow-up get has no status, or no JSON', async () => {
    const wait = (stdout: string) => cliHerdr(fakeRun({ 'agent get': { stdout } }).run).waitIdle('w1:p1', 5000)
    await expect(wait('{"result":{"agent":{}}}')).rejects.toThrow(OrchError)
    await expect(wait('not json')).rejects.toThrow(OrchError)
  })
})

describe('session ids', () => {
  const claude = (agent_session: unknown) => ({ agent: 'claude', pane_id: 'w1:p1', agent_status: 'idle', agent_session })

  it('only counts an agent_session of kind id', async () => {
    const stdout = JSON.stringify({
      result: { agents: [claude({ kind: 'path', value: '/x/s.jsonl' }), claude({ value: 's-nokind' }), claude({ kind: 'id', value: 's-ok' })] },
    })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents.map(a => a.sessionId)).toEqual([undefined, undefined, 's-ok'])
  })

  it('gives sessionIdOf undefined for a path kind, no kind, or an empty value', async () => {
    const of = (s: unknown) => cliHerdr(fakeRun({ 'agent get': { stdout: agentOf(s) } }).run).sessionIdOf('go')
    expect(await of({ kind: 'path', value: '/x/s.jsonl' })).toBeUndefined()
    expect(await of({ value: 's-nokind' })).toBeUndefined()
    expect(await of({ kind: 'id', value: '' })).toBeUndefined()
    expect(await of(undefined)).toBeUndefined()
  })

  it('gives list an undefined sessionId for an empty id value', async () => {
    const stdout = JSON.stringify({ result: { agents: [claude({ kind: 'id', value: '' })] } })
    const agents = await cliHerdr(fakeRun({ 'agent list': { stdout } }).run).list()
    expect(agents[0].sessionId).toBeUndefined()
  })
})

describe('timeouts', () => {
  it('bounds start and wait, and leaves every other call on the default', async () => {
    const { run, calls, timeouts } = fakeRun({
      'agent list': { stdout: listJson },
      'tab create': { stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }) },
      'agent get': { stdout: agentOf({ kind: 'id', value: 's-1' }) },
    })
    const h = cliHerdr(run)
    await h.list()
    await h.focus('w1:p1')
    await h.createTab({ workspace: 'w1', cwd: '/r', label: 'go' })
    await h.startClaude({ name: 'go', paneId: 'w1:p9', args: [] })
    await h.prompt('w1:p9', 'hi')
    await h.waitIdle('w1:p9', 5000)
    await h.sessionIdOf('go')
    expect(calls.map((c, i) => [c.slice(0, 2).join(' '), timeouts[i]])).toEqual([
      ['agent list', undefined],
      ['agent focus', undefined],
      ['tab create', undefined],
      ['agent start', 75_000],
      ['agent prompt', undefined],
      ['agent wait', 15_000],
      ['agent get', undefined],
      ['agent get', undefined],
    ])
  })
})

describe('runHerdr', () => {
  const savedPath = process.env.PATH
  const dirs: string[] = []
  afterEach(() => {
    process.env.PATH = savedPath
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // PATH starts at a throwaway dir, so the real herdr is never reached; with no script the dir is all of
  // PATH, since herdr may also live in /usr/bin
  function fakeHerdr(script?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'fake-herdr-'))
    dirs.push(dir)
    if (script) {
      writeFileSync(join(dir, 'herdr'), `#!/bin/sh\n${script}\n`)
      chmodSync(join(dir, 'herdr'), 0o755)
    }
    process.env.PATH = script ? `${dir}:/usr/bin:/bin` : dir
  }

  it('hands back exit code, stdout and stderr', async () => {
    fakeHerdr('echo "args: $*"; echo bad >&2; exit 3')
    const r = await runHerdr(['agent', 'list'])
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('args: agent list\n')
    expect(r.stderr).toBe('bad\n')
  })

  it('reports why when the binary is missing', async () => {
    fakeHerdr()
    const r = await runHerdr(['agent', 'list'])
    expect(r.code).not.toBe(0)
    expect(r.error).toMatch(/ENOENT/)
  })

  it('kills a call that outlives its timeout and says so', async () => {
    fakeHerdr('exec sleep 3')
    const t0 = Date.now()
    const r = await runHerdr(['agent', 'list'], 100)
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(r.code).not.toBe(0)
    expect(r.error).toBe('timed out after 100ms')
  })
})
```

`tests/gh.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Check } from '../src/evidence.js'
import { cliGh, type GhRun } from '../src/sources/gh.js'

// bare PR and run numbers are only checked from a cwd that exists, so the fixtures need real directories
const repoA = mkdtempSync(join(tmpdir(), 'gh-test-a-'))
const repoB = mkdtempSync(join(tmpdir(), 'gh-test-b-'))
afterAll(() => {
  for (const d of [repoA, repoB]) rmSync(d, { recursive: true, force: true })
})

// a string is stdout as is, anything else is sent as JSON
function fakeRun(stdout: unknown, code = 0) {
  const calls: string[][] = []
  const cwds: string[] = []
  const run: GhRun = async (args, cwd) => {
    calls.push(args)
    cwds.push(cwd)
    return { code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout) }
  }
  return { run, calls, cwds }
}

const ci = (ref: string) => ({ kind: 'ci' as const, ref })
const pr = (ref: string) => ({ kind: 'pr' as const, ref })
const done = (conclusion: unknown) => ({ status: 'completed', conclusion })

describe('cliGh', () => {
  it('reads a CI run from its URL', async () => {
    const { run, calls } = fakeRun({ status: 'completed', conclusion: 'failure' })
    expect(await cliGh(run).check(ci('https://github.com/o/r/actions/runs/77'), repoA)).toBe('fail')
    expect(calls[0]).toEqual(['run', 'view', '77', '-R', 'o/r', '--json', 'status,conclusion'])
  })

  it('reads a bare CI id from the repo in cwd', async () => {
    const { run, calls, cwds } = fakeRun(done('success'))
    expect(await cliGh(run).check(ci('77'), repoA)).toBe('pass')
    expect(calls[0]).toEqual(['run', 'view', '77', '--json', 'status,conclusion'])
    expect(cwds[0]).toBe(repoA)
  })

  it('reports a running CI run as pending', async () => {
    expect(await cliGh(fakeRun({ status: 'in_progress', conclusion: '' }).run).check(ci('77'), repoA)).toBe('pending')
    expect(await cliGh(fakeRun({ status: 'queued', conclusion: null }).run).check(ci('77'), repoA)).toBe('pending')
  })

  it.each<[unknown, Check]>([
    ['success', 'pass'],
    ['skipped', 'pass'],
    ['neutral', 'pass'],
    ['failure', 'fail'],
    ['cancelled', 'fail'],
    ['timed_out', 'fail'],
    ['startup_failure', 'fail'],
    ['stale', 'unknown'],
    ['something_new', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
  ])('grades a completed CI run with conclusion %j as %s', async (conclusion, want) => {
    expect(await cliGh(fakeRun(done(conclusion)).run).check(ci('77'), repoA)).toBe(want)
  })

  it('grades PRs by state and checks', async () => {
    const grade = (o: unknown) => cliGh(fakeRun(o).run).check(pr('41'), repoA)
    expect(await grade({ state: 'MERGED', statusCheckRollup: [] })).toBe('pass')
    expect(await grade({ state: 'CLOSED', statusCheckRollup: [] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'STARTUP_FAILURE' }] })).toBe('fail')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] })).toBe('pass')
    expect(await grade({ state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS' }] })).toBe('pending')
  })

  it('reads commit statuses by their state', async () => {
    const grade = (state: string) => cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: [{ state }] }).run).check(pr('41'), repoA)
    expect(await grade('ERROR')).toBe('fail')
    expect(await grade('FAILURE')).toBe('fail')
    expect(await grade('PENDING')).toBe('pending')
    expect(await grade('SUCCESS')).toBe('pass')
  })

  it('keeps an open PR without checks pending', async () => {
    expect(await cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: [] }).run).check(pr('41'), repoA)).toBe('pending')
    expect(await cliGh(fakeRun({ state: 'OPEN', statusCheckRollup: null }).run).check(pr('41'), repoA)).toBe('pending')
  })

  it('says unknown when gh fails and ignores other kinds', async () => {
    expect(await cliGh(fakeRun({}, 1).run).check(ci('1'), repoA)).toBe('unknown')
    expect(await cliGh(fakeRun({}, 1).run).check(pr('1'), repoA)).toBe('unknown')
    const other = fakeRun({})
    const gh = cliGh(other.run)
    expect(await gh.check({ kind: 'commit', ref: 'a' }, repoA)).toBe('unknown')
    expect(await gh.check({ kind: 'note', ref: 'a' }, repoA)).toBe('unknown')
    expect(other.calls).toHaveLength(0)
  })

  it('says unknown when gh prints something that is not JSON', async () => {
    expect(await cliGh(fakeRun('HTTP 502 bad gateway').run).check(pr('41'), repoA)).toBe('unknown')
    expect(await cliGh(fakeRun('').run).check(ci('77'), repoA)).toBe('unknown')
  })

  it('says unknown when the runner itself rejects', async () => {
    const run: GhRun = async () => {
      throw new Error('spawn gh ENOENT')
    }
    expect(await cliGh(run).check(ci('77'), repoA)).toBe('unknown')
  })
})

describe('cliGh cache', () => {
  const passed = done('success')

  it('caches answers for 60 s per repo', async () => {
    const { run, calls } = fakeRun(passed)
    let now = 0
    const gh = cliGh(run, () => now)
    const ev = ci('1')
    await gh.check(ev, repoA)
    now = 59_000
    await gh.check(ev, repoA)
    expect(calls).toHaveLength(1)
    now = 61_000
    await gh.check(ev, repoA)
    expect(calls).toHaveLength(2)
    await gh.check(ev, repoB)
    expect(calls).toHaveLength(3)
  })

  it('asks again about an unknown after 15 s', async () => {
    const calls: string[][] = []
    let reply = { code: 1, stdout: '' }
    const run: GhRun = async args => {
      calls.push(args)
      return reply
    }
    let now = 0
    const gh = cliGh(run, () => now)
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    reply = { code: 0, stdout: JSON.stringify(passed) }
    now = 14_000
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    expect(calls).toHaveLength(1)
    now = 16_000
    expect(await gh.check(ci('1'), repoA)).toBe('pass')
    expect(calls).toHaveLength(2)
  })

  it('keeps a pass for 60 s, not the 15 s an unknown gets', async () => {
    const { run, calls } = fakeRun(passed)
    let now = 0
    const gh = cliGh(run, () => now)
    await gh.check(ci('1'), repoA)
    now = 20_000
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(1)
  })

  it('runs gh once for two checks of the same key at the same time', async () => {
    const { run, calls } = fakeRun(passed)
    const gh = cliGh(run)
    const got = await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoA)])
    expect(got).toEqual(['pass', 'pass'])
    expect(calls).toHaveLength(1)
  })

  it('does not share a check across repos while it is in flight', async () => {
    const { run, calls } = fakeRun(passed)
    const gh = cliGh(run)
    await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoB)])
    expect(calls).toHaveLength(2)
  })

  it('lets a late asker join a check that is still in flight', async () => {
    const calls: string[][] = []
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    const run: GhRun = async args => {
      calls.push(args)
      await gate
      return { code: 0, stdout: JSON.stringify(passed) }
    }
    let now = 0
    const gh = cliGh(run, () => now)
    const first = gh.check(ci('1'), repoA)
    now = 1_000_000
    const second = gh.check(ci('1'), repoA)
    open()
    expect(await Promise.all([first, second])).toEqual(['pass', 'pass'])
    expect(calls).toHaveLength(1)
  })

  it('measures freshness from when the answer arrived, not from when gh was asked', async () => {
    const calls: string[][] = []
    let open!: () => void
    const gate = new Promise<void>(r => (open = r))
    let first = true
    const run: GhRun = async args => {
      calls.push(args)
      if (first) {
        first = false
        await gate
      }
      return { code: 0, stdout: JSON.stringify(passed) }
    }
    let now = 0
    const gh = cliGh(run, () => now)
    const pending = gh.check(ci('1'), repoA)
    now = 50_000
    open()
    await pending
    now = 100_000 // 100 s after the ask, but only 50 s after the answer
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(1)
    now = 111_000
    await gh.check(ci('1'), repoA)
    expect(calls).toHaveLength(2)
  })

  it('turns a rejection into unknown for everyone waiting, and asks again after 15 s', async () => {
    let calls = 0
    const run: GhRun = async () => {
      calls++
      throw new Error('boom')
    }
    let now = 0
    const gh = cliGh(run, () => now)
    expect(await Promise.all([gh.check(ci('1'), repoA), gh.check(ci('1'), repoA)])).toEqual(['unknown', 'unknown'])
    expect(calls).toBe(1)
    now = 16_000
    expect(await gh.check(ci('1'), repoA)).toBe('unknown')
    expect(calls).toBe(2)
  })
})

describe('cliGh when the cwd is gone', () => {
  const gone = [join(tmpdir(), 'orch-gh-test-no-such-dir'), '']

  it.each(gone)('runs a URL ref from an existing directory, not orch\'s own (cwd %j)', async cwd => {
    const ciRun = fakeRun(done('success'))
    expect(await cliGh(ciRun.run).check(ci('https://github.com/o/r/actions/runs/77'), cwd)).toBe('pass')
    expect(ciRun.calls).toEqual([['run', 'view', '77', '-R', 'o/r', '--json', 'status,conclusion']])
    expect(ciRun.cwds[0]).toBe(tmpdir())
    expect(existsSync(ciRun.cwds[0])).toBe(true)

    const prRun = fakeRun({ state: 'MERGED', statusCheckRollup: [] })
    expect(await cliGh(prRun.run).check(pr('https://github.com/o/r/pull/41'), cwd)).toBe('pass')
    expect(prRun.calls).toEqual([['pr', 'view', 'https://github.com/o/r/pull/41', '--json', 'state,statusCheckRollup']])
    expect(prRun.cwds[0]).toBe(tmpdir())
  })

  it.each(gone)('says unknown for a bare number without running gh (cwd %j)', async cwd => {
    const { run, calls } = fakeRun(done('success'))
    const gh = cliGh(run)
    expect(await gh.check(ci('77'), cwd)).toBe('unknown')
    expect(await gh.check(pr('41'), cwd)).toBe('unknown')
    expect(calls).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/herdr.test.ts tests/gh.test.ts`
Expected: FAIL, cannot find the two modules.

- [ ] **Step 4: Implement**

`src/sources/herdr.ts`:

```ts
import { execFile } from 'node:child_process'
import { OrchError } from '../errors.js'

export type HerdrAgent = { name?: string; paneId: string; status: string; sessionId?: string; title?: string }

export interface Herdr {
  list(): Promise<HerdrAgent[]>
  focus(target: string): Promise<void>
  createTab(o: { workspace: string; cwd: string; label: string }): Promise<{ paneId: string }>
  startClaude(o: { name: string; paneId: string; args: string[] }): Promise<void>
  sessionIdOf(name: string): Promise<string | undefined>
  waitIdle(target: string, timeoutMs: number): Promise<string>
  prompt(target: string, text: string): Promise<void>
}

export type Run = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>

// herdr failed. herdrCode is the code from its {error:{code,message}} reply (agent_not_ready, agent_blocked, ...), when it sent one
export class HerdrError extends OrchError {
  override name = 'HerdrError'

  constructor(message: string, readonly herdrCode?: string) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 75_000 // herdr's own --timeout 60000 plus slack
const WAIT_SLACK_MS = 10_000

export const runHerdr: Run = (args, timeoutMs) => {
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise(resolve => {
    execFile('herdr', args, { timeout: limit, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      // a kill by the timeout has no exit code and killed set; a maxBuffer kill has a string code
      const timedOut = err?.killed === true && typeof err.code !== 'string'
      const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0
      const error = err ? (timedOut ? `timed out after ${limit}ms` : err.message) : undefined
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error })
    })
  })
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const agentIn = (reply: unknown) => (isObj(reply) && isObj(reply.result) && isObj(reply.result.agent) ? reply.result.agent : undefined)
const snippet = (v: unknown) => JSON.stringify(v).slice(0, 200)
// only a session of kind id is a Claude sessionId; a path kind points at a transcript file instead
const sessionIdIn = (s: unknown) => (isObj(s) && s.kind === 'id' && typeof s.value === 'string' && s.value ? s.value : undefined)

function herdrErrorIn(text: string): { code?: string; message?: string } | undefined {
  try {
    const e: unknown = JSON.parse(text)?.error
    if (isObj(e) && (typeof e.code === 'string' || typeof e.message === 'string')) return { code: str(e.code), message: str(e.message) }
  } catch {
    // not JSON, so it is plain text
  }
  return undefined
}

function failure(args: string[], r: { stdout: string; stderr: string; error?: string }): HerdrError {
  const what = `herdr ${args.slice(0, 2).join(' ')} failed`
  const e = herdrErrorIn(r.stderr) ?? herdrErrorIn(r.stdout)
  if (e) return new HerdrError(`${what}: ${e.message ?? e.code}${e.message && e.code ? ` (${e.code})` : ''}`, e.code)
  return new HerdrError(`${what}: ${r.stderr.trim() || r.stdout.trim() || (r.error ?? '').trim()}`)
}

export function cliHerdr(run: Run = runHerdr): Herdr {
  const ok = async (args: string[], timeoutMs?: number) => {
    const r = await run(args, timeoutMs)
    if (r.code !== 0) throw failure(args, r)
    return r.stdout
  }
  const json = async (args: string[], timeoutMs?: number): Promise<unknown> => {
    const out = await ok(args, timeoutMs)
    try {
      return JSON.parse(out)
    } catch {
      throw new HerdrError(`herdr ${args.slice(0, 2).join(' ')} did not answer with JSON: ${out.trim().slice(0, 200)}`)
    }
  }

  return {
    async list() {
      const o = await json(['agent', 'list'])
      const agents = isObj(o) && isObj(o.result) ? o.result.agents : undefined
      if (!Array.isArray(agents)) throw new HerdrError(`unexpected herdr agent list reply: ${snippet(o)}`)
      return agents
        .filter((a): a is Record<string, unknown> & { pane_id: string } => isObj(a) && a.agent === 'claude' && typeof a.pane_id === 'string')
        .map(a => ({
          name: str(a.name),
          paneId: a.pane_id,
          status: str(a.agent_status) ?? 'unknown',
          sessionId: sessionIdIn(a.agent_session),
          title: str(a.terminal_title_stripped),
        }))
    },
    async focus(target) {
      await ok(['agent', 'focus', target])
    },
    async createTab({ workspace, cwd, label }) {
      const o = await json(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'])
      const root = isObj(o) && isObj(o.result) ? o.result.root_pane : undefined
      const paneId = isObj(root) ? str(root.pane_id) : undefined
      if (!paneId) throw new HerdrError(`unexpected herdr tab create reply: ${snippet(o)}`)
      return { paneId }
    },
    async startClaude({ name, paneId, args }) {
      await ok(['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '60000', '--', ...args], START_TIMEOUT_MS)
    },
    async sessionIdOf(name) {
      try {
        return sessionIdIn(agentIn(await json(['agent', 'get', name]))?.agent_session)
      } catch {
        return undefined
      }
    },
    async waitIdle(target, timeoutMs) {
      await ok(['agent', 'wait', target, '--until', 'idle', '--until', 'done', '--until', 'blocked', '--timeout', String(timeoutMs)], timeoutMs + WAIT_SLACK_MS)
      const o = await json(['agent', 'get', target])
      const status = str(agentIn(o)?.agent_status)
      if (!status) throw new HerdrError(`unexpected herdr agent get reply: ${snippet(o)}`)
      return status
    },
    async prompt(target, text) {
      // no --wait; don't retry a failure, herdr says a timeout does not prove the prompt was not delivered
      await ok(['agent', 'prompt', target, text])
    },
  }
}
```

`src/sources/gh.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { checkKey, type Check } from '../evidence.js'
import type { Evidence } from '../model.js'

export interface Gh {
  check(ev: Evidence, cwd: string): Promise<Check>
}

export type GhRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>

const runGh: GhRun = (args, cwd) =>
  new Promise(resolve => {
    execFile('gh', args, { cwd, timeout: 20_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout) }))
  })

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

const ANSWER_TTL_MS = 60_000
const UNKNOWN_TTL_MS = 15_000

async function ciCheck(run: GhRun, ref: string, cwd: string): Promise<Check> {
  const m = ref.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/)
  const args = m ? ['run', 'view', m[2], '-R', m[1], '--json', 'status,conclusion'] : ['run', 'view', ref, '--json', 'status,conclusion']
  const r = await run(args, cwd)
  if (r.code !== 0) return 'unknown'
  const o = JSON.parse(r.stdout)
  if (o.status !== 'completed') return 'pending'
  const c = String(o.conclusion ?? '').toUpperCase()
  return PASSED.includes(c) ? 'pass' : FAILED.includes(c) ? 'fail' : 'unknown'
}

async function prCheck(run: GhRun, ref: string, cwd: string): Promise<Check> {
  const r = await run(['pr', 'view', ref, '--json', 'state,statusCheckRollup'], cwd)
  if (r.code !== 0) return 'unknown'
  const o = JSON.parse(r.stdout)
  if (o.state === 'MERGED') return 'pass'
  if (o.state === 'CLOSED') return 'fail'
  const states: string[] = (o.statusCheckRollup ?? []).map((c: { conclusion?: string; state?: string }) => c.conclusion || c.state || '')
  if (states.some(s => FAILED.includes(s))) return 'fail'
  if (states.length && states.every(s => PASSED.includes(s))) return 'pass'
  return 'pending'
}

// A finished child's worktree is deleted, and gh must never fall back to orch's own cwd:
// a URL names its repo, so it runs from the temp dir; a bare number means nothing without its repo.
function runDir(ref: string, cwd: string): string | undefined {
  if (cwd && existsSync(cwd)) return cwd
  return /^https?:\/\//i.test(ref) ? tmpdir() : undefined
}

async function ask(run: GhRun, ev: Evidence, cwd: string): Promise<Check> {
  const dir = runDir(ev.ref, cwd)
  if (dir === undefined) return 'unknown'
  return ev.kind === 'ci' ? ciCheck(run, ev.ref, dir) : prCheck(run, ev.ref, dir)
}

type Entry = { promise: Promise<Check>; value?: Check; arrivedAt?: number }

export function cliGh(run: GhRun = runGh, now: () => number = Date.now): Gh {
  // the promise is cached, not the answer, so two checks of one key while gh runs spawn it once
  const cache = new Map<string, Entry>()
  return {
    async check(ev, cwd) {
      if (ev.kind !== 'ci' && ev.kind !== 'pr') return 'unknown'
      const key = checkKey(ev, cwd)
      const hit = cache.get(key)
      if (hit && (hit.arrivedAt === undefined || now() - hit.arrivedAt < (hit.value === 'unknown' ? UNKNOWN_TTL_MS : ANSWER_TTL_MS))) {
        return hit.promise
      }
      const entry: Entry = {
        promise: ask(run, ev, cwd)
          .catch((): Check => 'unknown')
          .then(value => {
            entry.value = value
            entry.arrivedAt = now()
            return value
          }),
      }
      cache.set(key, entry)
      return entry.promise
    },
  }
}
```

- [ ] **Step 5: Run them to see them pass**

Run: `npm test -- tests/herdr.test.ts tests/gh.test.ts && npm run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/src/sources plugins/orchestrator/tests/herdr.test.ts plugins/orchestrator/tests/gh.test.ts plugins/orchestrator/tests/fixtures/herdr-agent-list.json
git commit -m "Add herdr and gh sources for the orchestrator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 7: Overview and text format

**Files:**
- Create: `plugins/orchestrator/src/overview.ts`
- Create: `plugins/orchestrator/src/format.ts`
- Test: `plugins/orchestrator/tests/overview.test.ts`, `plugins/orchestrator/tests/format.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/overview.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkKey, type Check } from '../src/evidence.js'
import { header, flatten } from '../src/format.js'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, DAY, type OverviewInput, type Row } from '../src/overview.js'
import type { HerdrAgent } from '../src/sources/herdr.js'
import type { LiveSession } from '../src/sources/sessions.js'
import { listPools } from '../src/store.js'

const NOW = 10 * DAY

function pool(id: string, tasks: Partial<Task>[], extra: Partial<Pool> = {}): Pool {
  return {
    ...newPool(id, `/src/${id}`, NOW - 1000),
    tasks: tasks.map((t, i) => ({ id: `t${i + 1}`, text: `task ${i + 1}`, status: 'pending', ...t })),
    ...extra,
  }
}
const live = (sessionId: string, extra: Partial<LiveSession> = {}): LiveSession => ({ pid: 1, sessionId, cwd: `/src/${sessionId}`, status: 'idle', ...extra })
const agent = (sessionId: string, name: string): HerdrAgent => ({ sessionId, name, paneId: `p-${name}`, status: 'idle' })

function input(over: Partial<OverviewInput>): OverviewInput {
  return { pools: [], live: [], agents: [], checks: new Map<string, Check>(), now: NOW, ...over }
}

describe('buildOverview', () => {
  it('nests children under their parent and rolls up flags', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ status: 'done', evidence: { kind: 'commit', ref: 'abc' } }, { children: ['C1', 'C2'], status: 'in_progress' }], { title: 'Courses' }) },
        { id: 'C1', pool: pool('C1', [{ status: 'done', evidence: { kind: 'commit', ref: 'x' } }], { parent: { sessionId: 'P', taskId: 't2' } }) },
        { id: 'C2', pool: pool('C2', [{ needsInput: 'which curve?' }], { parent: { sessionId: 'P', taskId: 't2' } }) },
      ],
      live: [live('P'), live('C1'), live('C2', { status: 'busy' })],
      agents: [agent('P', 'beginner-courses'), agent('C1', 'course-go'), agent('C2', 'course-python')],
    }))
    expect(rows).toHaveLength(1)
    const [p] = rows
    expect(p).toMatchObject({ name: 'beginner-courses', title: 'Courses', tag: 'herdr', flags: 1, done: 1, total: 2 })
    expect(p.children.map(c => c.name)).toEqual(['course-go', 'course-python'])
    expect(p.tasks[1]).toMatchObject({ status: 'in_progress', mark: '◐', detail: '2 children: 1 ✓ 1 running' })
    expect(p.children[1].tasks[0]).toMatchObject({ mark: '⚑', detail: '"which curve?"' })
  })

  it('counts a parent task done once every child pool is done, and not before', () => {
    const child = (id: string, status: 'done' | 'pending') => ({ id, pool: pool(id, [{ status, evidence: { kind: 'commit' as const, ref: 'a' } }], { parent: { sessionId: 'P', taskId: 't1' } }) })
    const make = (s: 'done' | 'pending') => buildOverview(input({
      pools: [{ id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) }, child('C', s)],
      live: [live('P'), live('C')],
    }))[0]
    expect(make('done')).toMatchObject({ done: 1, total: 1, complete: true })
    expect(make('done').tasks[0].mark).toBe('✓')
    expect(make('pending').tasks[0].status).toBe('in_progress')
  })

  it('grades evidence with the live checks', () => {
    const checks = new Map<string, Check>([
      [checkKey({ kind: 'ci', ref: 'u1' }, '/src/S'), 'fail'],
      [checkKey({ kind: 'pr', ref: '4' }, '/src/S'), 'pending'],
      [checkKey({ kind: 'pr', ref: '4' }, '/src/other'), 'fail'],
    ])
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { status: 'done', evidence: { kind: 'ci', ref: 'u1' } },
        { status: 'done', evidence: { kind: 'pr', ref: '4' } },
        { status: 'done' },
        { status: 'blocked', blockedReason: 'needs key' },
      ]) }],
      live: [live('S')],
      checks,
    }))
    expect(row.tasks.map(t => t.mark)).toEqual(['✗', '?', '~', '!'])
    expect(row.tasks[0].detail).toBe('ci u1 ✗ failing (live)')
    expect(row.tasks[1].detail).toBe('pr 4 (unverified)')
    expect(row.tasks[2].detail).toBe('claimed, no evidence')
    expect(row.tasks[3].detail).toBe('needs key')
  })

  it('clips long evidence but keeps the live verdict', () => {
    const url = 'https://github.com/kvalitskii/ClaudeSkills/actions/runs/12345678901'
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { status: 'done', evidence: { kind: 'ci', ref: url } },
        { status: 'done', evidence: { kind: 'note', ref: 'x'.repeat(80) } },
      ]) }],
      live: [live('S')],
      checks: new Map<string, Check>([[checkKey({ kind: 'ci', ref: url }, '/src/S'), 'fail']]),
    }))
    expect(row.tasks[0].detail).toMatch(/… ✗ failing \(live\)$/)
    expect(row.tasks[1].detail).toHaveLength(40)
    expect(row.tasks[1].detail).toMatch(/x…$/)
  })

  it('tags sessions outside herdr as external and links Remote Control sessions', () => {
    const [row] = buildOverview(input({ live: [live('S', { name: 'api-fix', bridgeSessionId: 'session_01X', pid: 77 })], agents: [] }))
    expect(row).toMatchObject({ name: 'api-fix', tag: 'external', hasPool: false, link: 'https://claude.ai/code/session_01X', pid: 77 })
  })

  it('shows a session blocked on a dialog as waiting', () => {
    const [row] = buildOverview(input({ live: [live('S', { waitingFor: 'dialog open' })] }))
    expect(row).toMatchObject({ state: 'waiting', waitingFor: 'dialog open' })
  })

  it('drops ended sessions after a day unless their parent is live', () => {
    const old = (id: string, extra: Partial<Pool> = {}) => ({ id, pool: pool(id, [{}], { updatedAt: NOW - 2 * DAY, ...extra }) })
    const rows = buildOverview(input({
      pools: [old('gone'), old('kept', { parent: { sessionId: 'P', taskId: 't1' } }), { id: 'P', pool: pool('P', [{ children: ['kept'] }]) }],
      live: [live('P')],
    }))
    expect(rows.map(r => r.sessionId)).toEqual(['P'])
    expect(rows[0].children[0]).toMatchObject({ sessionId: 'kept', state: 'ended', tag: '—' })
  })

  it('survives a parent cycle and shows every member exactly once', () => {
    const p = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    // B and C are each other's parent; A and T hang off B; S is its own parent. A comes first in `ids`.
    const rows = buildOverview(input({
      pools: [p('A', 'B'), p('B', 'C'), p('C', 'B'), p('S', 'S'), p('T', 'B')],
      live: [live('A'), live('B'), live('C'), live('S'), live('T')],
    }))
    const count = (rs: Row[]): number => rs.reduce((n, r) => n + 1 + count(r.children), 0)
    expect(count(rows)).toBe(5)
    expect(flatten(rows).map(l => l.row.sessionId).sort()).toEqual(['A', 'B', 'C', 'S', 'T'])
    expect(header(rows)).toMatch(/ 5 live /)
  })

  it('shows a long tail hanging off a cycle once, whatever order it is listed in', () => {
    const p = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    // E -> D -> A -> B <-> C
    const pools = [p('E', 'D'), p('D', 'A'), p('A', 'B'), p('B', 'C'), p('C', 'B')]
    for (const order of [['E', 'D', 'A', 'B', 'C'], ['C', 'B', 'A', 'D', 'E'], ['D', 'C', 'E', 'A', 'B']]) {
      const rows = buildOverview(input({ pools, live: order.map(id => live(id)) }))
      expect(flatten(rows).map(l => l.row.sessionId).sort(), order.join()).toEqual(['A', 'B', 'C', 'D', 'E'])
      expect(rows, order.join()).toHaveLength(1)
    }
  })

  it('keeps ordinary roots as they are next to a cycle', () => {
    const p = (id: string, parent?: string) => ({ id, pool: pool(id, [{}], parent ? { parent: { sessionId: parent, taskId: 't1' } } : {}) })
    const rows = buildOverview(input({
      pools: [p('R'), p('K', 'R'), p('X', 'Y'), p('Y', 'X')],
      live: [live('Y'), live('K'), live('R'), live('X')],
    }))
    const r = rows.find(row => row.sessionId === 'R')!
    expect(r.children.map(c => c.sessionId)).toEqual(['K'])
    expect(flatten(rows).map(l => l.row.sessionId).sort()).toEqual(['K', 'R', 'X', 'Y'])
  })

  it('marks orphans and unreadable pools', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'O', pool: pool('O', [{}], { parent: { sessionId: 'missing', taskId: 't1' } }) }, { id: 'B', error: 'Unexpected token' }],
      live: [live('O'), live('B')],
    }))
    expect(rows.find(r => r.sessionId === 'O')!.orphan).toBe(true)
    expect(rows.find(r => r.sessionId === 'B')!.unreadable).toBe('Unexpected token')
  })

  it('puts sessions with open questions first, ended last', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'a', pool: pool('a', [{}], { title: 'a' }) },
        { id: 'b', pool: pool('b', [{ needsInput: 'q' }], { title: 'b' }) },
        { id: 'c', pool: pool('c', [{}], { title: 'c' }) },
      ],
      live: [live('a'), live('b')],
    }))
    expect(rows.map(r => r.sessionId)).toEqual(['b', 'a', 'c'])
  })

  it('keeps a session name, title, question and task text on one line without escape codes', () => {
    const evil = (s: string) => `${s}\n${s}\u001b]0;x\u0007${s}`
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [
        { text: 'fix\nthe\u001b]0;x\u0007bug', needsInput: 'which\ncurve\u001b]0;x\u0007?' },
        { status: 'blocked', blockedReason: 'needs\nkey\u001b]0;x\u0007' },
      ], { title: evil('t') }) }],
      live: [live('S', { waitingFor: 'dialog\nopen\u001b]0;x\u0007' })],
      agents: [agent('S', 'bad\nname\u001b]0;x\u0007')],
    }))
    expect(row.tasks[0].text).toBe('fix the ]0;x bug')
    expect(row.tasks[0].detail).toBe('"which curve ]0;x ?"')
    expect(row.tasks[1].detail).toBe('needs key ]0;x')
    expect(row.name).toBe('bad name ]0;x')
    expect(row.title).toBe('t t ]0;x t')
    expect(row.waitingFor).toBe('dialog open ]0;x')
    for (const text of [row.name, row.title, row.waitingFor!, ...row.tasks.flatMap(t => [t.text, t.detail])]) {
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
  })

  describe('keeps what a session wrote on one line', () => {
    const evil = 'a\nb\u001b]0;x\u0007'
    const titled = { id: 'S', pool: pool('S', [{}], { title: evil }) }
    const cases: [string, Partial<OverviewInput>, 'name' | 'title'][] = [
      ['a herdr name', { live: [live('S')], agents: [agent('S', evil)] }, 'name'],
      ['a session name', { live: [live('S', { name: evil })] }, 'name'],
      ['a pool title used as the name', { pools: [titled], live: [live('S')] }, 'name'],
      ['the start of the session id used as the name', { live: [live(`${evil}cdef`)] }, 'name'],
      ['a pool title', { pools: [titled], live: [live('S')] }, 'title'],
      ['a herdr title', { live: [live('S')], agents: [{ ...agent('S', 'n'), title: evil }] }, 'title'],
    ]
    it.each(cases)('%s', (_what, over, field) => {
      const [row] = buildOverview(input(over))
      expect(row[field]).toBe('a b ]0;x')
    })
  })

  it('keeps the reason a pool is unreadable on one line', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'B', error: 'bad\njson\u001b]0;x\u0007 here' }, { id: 'G', pool: pool('G', [{}]) }],
      live: [live('B'), live('G')],
    }))
    expect(rows.find(r => r.sessionId === 'B')!.unreadable).toBe('bad json ]0;x here')
    expect(rows.find(r => r.sessionId === 'G')!.unreadable).toBeUndefined()
  })

  it('keeps the error of a real broken pool file on one line', () => {
    // V8 quotes the start of the bad JSON in its message, so a session can get its own bytes into it
    const home = mkdtempSync(join(tmpdir(), 'orch-overview-'))
    try {
      writeFileSync(join(home, 's1.json'), '{"a":\n\u001b]0;x\u0007')
      const [entry] = listPools(home)
      expect(entry.error).toMatch(/[\u0000-\u001f]/)
      const [row] = buildOverview(input({ pools: [entry], live: [live('s1')] }))
      expect(row.unreadable).toContain('is not valid JSON')
      expect(row.unreadable).not.toMatch(/[\u0000-\u001f\u007f]/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('clips evidence by code point, so an emoji at the cut is not split', () => {
    // 'note: ' + 32 x is 38 characters, so the emoji starts at the 39th; the clip keeps 39 and adds the ellipsis
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ status: 'done', evidence: { kind: 'note', ref: `${'x'.repeat(32)}😀tail` } }]) }],
      live: [live('S')],
    }))
    expect(row.tasks[0].detail).toBe(`note: ${'x'.repeat(32)}😀…`)
    expect(row.tasks[0].detail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('replaces control characters in a cwd but keeps its spaces', () => {
    const dirty = '/src/my project\n\u001b]0;x\u0007/sub dir'
    const clean = '/src/my project??]0;x?/sub dir'
    const [fromPool] = buildOverview(input({ pools: [{ id: 'S', pool: pool('S', [{}], { cwd: dirty }) }], live: [live('S')] }))
    const [fromSession] = buildOverview(input({ live: [live('S', { cwd: dirty })] }))
    expect(fromPool.cwd).toBe(clean)
    expect(fromSession.cwd).toBe(clean)
    expect(fromPool.cwd).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('still looks up checks by the real cwd of the pool', () => {
    const cwd = '/src/my project\u001b'
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ status: 'done', evidence: { kind: 'ci', ref: 'u1' } }], { cwd }) }],
      live: [live('S')],
      checks: new Map<string, Check>([[checkKey({ kind: 'ci', ref: 'u1' }, cwd), 'fail']]),
    }))
    expect(row.tasks[0].mark).toBe('✗')
  })

  it('does not clip a question or a blocked reason', () => {
    const long = 'q'.repeat(120)
    const [row] = buildOverview(input({
      pools: [{ id: 'S', pool: pool('S', [{ needsInput: long }, { status: 'blocked', blockedReason: long }]) }],
      live: [live('S')],
    }))
    expect(row.tasks[0].detail).toBe(`"${long}"`)
    expect(row.tasks[1].detail).toBe(long)
  })

  it('falls back to the next name when one is blank', () => {
    const name = (a: string, s: string | undefined, title: string, id = 'abcdefghijkl') => {
      const [row] = buildOverview(input({
        pools: [{ id, pool: pool(id, [{}], { title }) }],
        live: [live(id, { name: s })],
        agents: [agent(id, a)],
      }))
      return row.name
    }
    expect(name('', 'api-fix', 'Courses')).toBe('api-fix')
    expect(name('', '', 'Courses')).toBe('Courses')
    expect(name('', '', '')).toBe('abcdefgh')
    expect(name('  \n', undefined, 'Courses')).toBe('Courses')
    expect(name('herdr-name', 'api-fix', 'Courses')).toBe('herdr-name')
  })

  it('is not complete, and does not finish its parent task, while a child pool is still empty', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) },
        { id: 'C', pool: pool('C', [], { parent: { sessionId: 'P', taskId: 't1' } }) },
      ],
      live: [live('P'), live('C')],
    }))
    const [p] = rows
    expect(p.tasks[0]).toMatchObject({ status: 'in_progress', detail: '1 children: 0 ✓ 1 running' })
    expect(p).toMatchObject({ done: 0, total: 1, complete: false })
    expect(p.children[0]).toMatchObject({ hasPool: false, total: 0, complete: false })
  })

  it('is complete only once every child is, not just some of them', () => {
    const make = (second: 'done' | 'pending') => buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C1', 'C2'] }]) },
        { id: 'C1', pool: pool('C1', [{ status: 'done', evidence: { kind: 'commit', ref: 'a' } }], { parent: { sessionId: 'P', taskId: 't1' } }) },
        { id: 'C2', pool: pool('C2', [{ status: second, evidence: { kind: 'commit', ref: 'b' } }], { parent: { sessionId: 'P', taskId: 't1' } }) },
      ],
      live: [live('P'), live('C1'), live('C2')],
    }))[0]
    expect(make('pending')).toMatchObject({ complete: false, done: 0, total: 1 })
    expect(make('pending').tasks[0]).toMatchObject({ status: 'pending', detail: '2 children: 1 ✓ 1 running' })
    expect(make('done')).toMatchObject({ complete: true, done: 1, total: 1 })
  })

  it('judges completeness the same whatever order the sessions are listed in', () => {
    // C's own task says done, but its child G is not: C is not complete, so P's task is not done.
    // C has no parent link, so whether C is built before P depends on the order of `ids`.
    const pools = [
      { id: 'P', pool: pool('P', [{ children: ['C'], status: 'done' }]) },
      { id: 'C', pool: pool('C', [{ children: ['G'], status: 'done' }]) },
      { id: 'G', pool: pool('G', [{ status: 'pending' }]) },
    ]
    const a = buildOverview(input({ pools, live: [live('P'), live('C'), live('G')] }))
    const b = buildOverview(input({ pools, live: [live('G'), live('C'), live('P')] }))
    const c = buildOverview(input({ pools: [...pools].reverse(), live: [live('C'), live('P'), live('G')] }))
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    const p = a.find(r => r.sessionId === 'P')!
    expect(p.tasks[0].status).toBe('in_progress')
    expect(p).toMatchObject({ done: 0, complete: false })
    expect(a.find(r => r.sessionId === 'C')).toMatchObject({ complete: false, done: 0 })
  })

  it('counts a chain of finished children as complete all the way up', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'P', pool: pool('P', [{ children: ['C'] }]) },
        { id: 'C', pool: pool('C', [{ children: ['G'] }], { parent: { sessionId: 'P', taskId: 't1' } }) },
        { id: 'G', pool: pool('G', [{ status: 'done', evidence: { kind: 'commit', ref: 'abc' } }], { parent: { sessionId: 'C', taskId: 't1' } }) },
      ],
      live: [live('G'), live('C'), live('P')],
    }))
    const [p] = rows
    expect(p).toMatchObject({ complete: true, done: 1, total: 1 })
    expect(p.children[0]).toMatchObject({ complete: true })
    expect(p.children[0].children[0]).toMatchObject({ complete: true })
  })

  it('never counts a parent cycle as complete', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'A', pool: pool('A', [{ children: ['B'], status: 'done' }]) },
        { id: 'B', pool: pool('B', [{ children: ['A'], status: 'done' }]) },
      ],
      live: [live('A'), live('B')],
    }))
    for (const { row } of flatten(rows)) expect(row.complete, row.sessionId).toBe(false)
  })

  it('lists ended sessions after live ones even when their names sort first', () => {
    const rows = buildOverview(input({
      pools: [
        { id: 'a', pool: pool('a', [{}], { title: 'aaa' }) },
        { id: 'z', pool: pool('z', [{}], { title: 'zzz' }) },
        { id: 'm', pool: pool('m', [{}], { title: 'mmm' }) },
      ],
      live: [live('z'), live('m')],
    }))
    expect(rows.map(r => r.name)).toEqual(['mmm', 'zzz', 'aaa'])
  })

  it('sorts children by name', () => {
    const child = (id: string, title: string) => ({ id, pool: pool(id, [{}], { title, parent: { sessionId: 'P', taskId: 't1' } }) })
    const rows = buildOverview(input({
      pools: [{ id: 'P', pool: pool('P', [{ children: ['Z', 'A', 'M'] }]) }, child('Z', 'zeta'), child('A', 'alpha'), child('M', 'mid')],
      live: [live('P'), live('Z'), live('A'), live('M')],
    }))
    expect(rows[0].children.map(c => c.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('carries the herdr pane of a session, and none for an external one', () => {
    const rows = buildOverview(input({
      live: [live('H'), live('E')],
      agents: [agent('H', 'in-herdr')],
    }))
    expect(rows.find(r => r.sessionId === 'H')).toMatchObject({ paneId: 'p-in-herdr', tag: 'herdr' })
    expect(rows.find(r => r.sessionId === 'E')!.paneId).toBeUndefined()
  })

  it('does not call a child an orphan while its parent is live without a pool, or ended with one', () => {
    const child = (id: string, parent: string) => ({ id, pool: pool(id, [{}], { parent: { sessionId: parent, taskId: 't1' } }) })
    const rows = buildOverview(input({
      // D was last written two days ago, so only its live child K2 brings it onto the screen
      pools: [child('K1', 'L'), child('K2', 'D'), { id: 'D', pool: pool('D', [{ children: ['K2'] }], { updatedAt: NOW - 2 * DAY }) }],
      live: [live('L'), live('K1'), live('K2')],
    }))
    const all = flatten(rows).map(l => l.row)
    expect(rows.find(r => r.sessionId === 'D')).toMatchObject({ state: 'ended', children: [{ sessionId: 'K2' }] })
    expect(all.find(r => r.sessionId === 'K1')!.orphan).toBe(false)
    expect(all.find(r => r.sessionId === 'K2')!.orphan).toBe(false)
    expect(all.find(r => r.sessionId === 'L')).toMatchObject({ orphan: false, hasPool: false })
    expect(all.find(r => r.sessionId === 'K1')).toMatchObject({ hasPool: true })
  })

  it('reports hasPool only for a pool that has tasks', () => {
    const rows = buildOverview(input({
      pools: [{ id: 'E', pool: pool('E', []) }, { id: 'F', pool: pool('F', [{}]) }, { id: 'U', error: 'bad' }],
      live: [live('E'), live('F'), live('U'), live('N')],
    }))
    const has = Object.fromEntries(rows.map(r => [r.sessionId, r.hasPool]))
    expect(has).toEqual({ E: false, F: true, U: false, N: false })
    expect(rows.find(r => r.sessionId === 'F')).toMatchObject({ orphan: false, total: 1, done: 0, complete: false })
  })
})
```

`tests/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { flatten, header, listLine, poolLines, renderList, shortCwd } from '../src/format.js'
import type { Row } from '../src/overview.js'

const row = (o: Partial<Row>): Row => ({
  sessionId: 's', name: 's', title: '', cwd: '/home/u/src/ItAbyss', state: 'idle', tag: 'herdr',
  hasPool: true, orphan: false, done: 0, total: 0, complete: false, flags: 0, tasks: [], children: [], ...o,
})

describe('format', () => {
  it('draws the tree prefixes', () => {
    const tree = [row({ name: 'p', children: [row({ name: 'a', children: [row({ name: 'x' })] }), row({ name: 'b' })] }), row({ name: 'q' })]
    expect(flatten(tree).map(l => l.prefix + l.row.name)).toEqual(['p', '├ a', '│ └ x', '└ b', 'q'])
  })

  it('shortens cwd', () => {
    expect(shortCwd('/home/u/src/ItAbyss/.worktrees/course-go', '/home/u')).toBe('ItAbyss/wt/course-go')
    expect(shortCwd('/home/u/notes', '/home/u')).toBe('~/notes')
  })

  it('renders a list line with progress, flags and state', () => {
    const line = listLine({ prefix: '', row: row({ name: 'beginner-courses', done: 2, total: 4, flags: 1 }) })
    expect(line).toMatch(/^beginner-courses\s+.*\s+idle\s+herdr\s+2\/4  ⚑1$/)
    expect(listLine({ prefix: '', row: row({ hasPool: false }) })).toMatch(/—  no pool$/)
    expect(listLine({ prefix: '', row: row({ done: 3, total: 3, complete: true }) })).toMatch(/3\/3 ✓$/)
  })

  it('counts live, flags and ended in the header', () => {
    expect(header([row({ flags: 2, children: [row({ state: 'ended' })] }), row({ state: 'busy' })])).toBe('ORCHESTRATOR  2 live · 2 ⚑ · 1 ended')
    expect(header([row({ state: 'waiting' })])).toBe('ORCHESTRATOR  1 live · 0 ⚑ · 0 ended')
    expect(listLine({ prefix: '', row: row({ state: 'waiting' }) })).toMatch(/\swaiting\s+herdr\s/)
  })

  it('adds the claude.ai link under a row in text output', () => {
    expect(renderList([row({ name: 'x', link: 'https://claude.ai/code/session_1' })])).toContain('→ https://claude.ai/code/session_1')
  })

  it('renders a pool', () => {
    const lines = poolLines(row({ name: 'p', title: 'Courses', tasks: [{ id: 't1', text: 'Write brief', status: 'done', mark: '✓', detail: 'commit 9f3e2a1' }] }))
    expect(lines[0]).toBe('p — Courses')
    expect(lines[1]).toMatch(/^✓ t1\s+Write brief\s+commit 9f3e2a1$/)
    expect(poolLines(row({ name: 'p', tasks: [] }))).toEqual(['p', '(no pool yet)'])
  })

  it('only rewrites the home prefix of a path', () => {
    expect(shortCwd('/mnt/home/u/src/x', '/home/u')).toBe('/mnt/home/u/src/x')
    expect(shortCwd('/mnt/home/u/notes', '/home/u')).toBe('/mnt/home/u/notes')
    expect(shortCwd('/srv/home/u/', '/home/u')).toBe('/srv/home/u/')
    expect(shortCwd('/home/u', '/home/u')).toBe('~')
    expect(shortCwd('/home/user/src/x', '/home/u')).toBe('/home/user/src/x')
    expect(shortCwd('/home/u/src/a/b', '/home/u')).toBe('a/b')
    expect(shortCwd('/opt/p/.worktrees/w', '/home/u')).toBe('/opt/p/wt/w')
    expect(shortCwd('', '/home/u')).toBe('')
  })

  it('clips a long name or path with an ellipsis', () => {
    const line = listLine({ prefix: '', row: row({ name: 'n'.repeat(30), cwd: '/srv/' + 'c'.repeat(40) }) })
    expect(line.startsWith(`${'n'.repeat(23)}… `)).toBe(true)
    expect(line).toContain(` /srv/${'c'.repeat(16)}… `)
    expect(line).not.toContain('n'.repeat(24))
  })

  it('clips by code point, so an emoji is never cut in half', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    const line = listLine({ prefix: '', row: row({ name: `${'n'.repeat(22)}😀tail` }) })
    expect(line.startsWith(`${'n'.repeat(22)}😀… `)).toBe(true)
    expect(lone.test(line)).toBe(false)
    const short = listLine({ prefix: '', row: row({ name: '😀'.repeat(3) }) })
    expect(short.startsWith(`😀😀😀${' '.repeat(21)} `)).toBe(true)
    const text = poolLines(row({ name: 'p', tasks: [{ id: 't1', text: `${'w'.repeat(33)}😀😀`, status: 'pending', mark: '·', detail: '' }] }))[1]
    expect(text).toBe(`· t1   ${'w'.repeat(33)}…`)
    expect(lone.test(text)).toBe(false)
  })

  it('shows orphan and unreadable pool in the list', () => {
    expect(listLine({ prefix: '', row: row({ orphan: true, done: 1, total: 2 }) })).toMatch(/1\/2  orphan$/)
    expect(listLine({ prefix: '', row: row({ unreadable: 'Unexpected token', hasPool: false }) })).toMatch(/ unreadable pool$/)
    expect(listLine({ prefix: '', row: row({ unreadable: 'x', hasPool: false, flags: 1, orphan: true }) })).toMatch(/unreadable pool  ⚑1  orphan$/)
  })

  it('counts flags once: from top-level rows, which already include their children', () => {
    // buildOverview rolls a child's flags up, so the parent's 2 is its own 1 plus the child's 1
    const rows = [row({ flags: 2, children: [row({ flags: 1 })] }), row({ flags: 1 })]
    expect(header(rows)).toBe('ORCHESTRATOR  3 live · 3 ⚑ · 0 ended')
  })

  it('says why a pool cannot be shown', () => {
    expect(poolLines(row({ name: 'p', unreadable: 'Unexpected token' }))).toEqual(['p', 'unreadable pool: Unexpected token'])
    expect(poolLines(row({ name: 'p', title: 'Courses', unreadable: 'bad' }))).toEqual(['p — Courses', 'unreadable pool: bad'])
  })

  it('leaves the title off the pool head when it repeats the name', () => {
    expect(poolLines(row({ name: 'beginner-courses', title: 'beginner-courses' }))[0]).toBe('beginner-courses')
    expect(poolLines(row({ name: 'a', title: 'b' }))[0]).toBe('a — b')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/overview.test.ts tests/format.test.ts`
Expected: FAIL, cannot find the two modules.

- [ ] **Step 3: Implement**

`src/overview.ts`:

```ts
import { checkKey, describeEvidence, grade, oneLine, type Check } from './evidence.js'
import type { Status, Task } from './model.js'
import type { PoolEntry } from './store.js'
import type { HerdrAgent } from './sources/herdr.js'
import { sessionLink, type LiveSession } from './sources/sessions.js'

export const DAY = 24 * 60 * 60 * 1000

// Clips evidence text only, to keep a pool row on one line; the live verdict is appended after clipping so it
// always shows. A question or a blocked reason is never clipped: /orch needs the whole of it. It cuts by
// code point, so an emoji at the cut is never split.
const clip = (s: string, n: number) => {
  const chars = Array.from(s)
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s
}

export type Mark = '✓' | '~' | '✗' | '?' | '◐' | '·' | '!' | '⚑'
export type TaskView = { id: string; text: string; status: Status; mark: Mark; detail: string }

export type Row = {
  sessionId: string
  name: string
  title: string
  cwd: string
  state: 'busy' | 'idle' | 'waiting' | 'ended'
  waitingFor?: string
  tag: 'herdr' | 'external' | '—'
  paneId?: string
  link?: string
  pid?: number
  hasPool: boolean
  unreadable?: string
  orphan: boolean
  done: number
  total: number
  complete: boolean
  flags: number
  tasks: TaskView[]
  children: Row[]
}

export type OverviewInput = {
  pools: PoolEntry[]
  live: LiveSession[]
  agents: HerdrAgent[] | null // null: herdr is not running
  checks: Map<string, Check>
  now: number
}

function viewTask(t: Task, cwd: string, checks: Map<string, Check>, childDone: (id: string) => boolean): TaskView {
  const kids = t.children ?? []
  const kidsDone = kids.filter(childDone).length
  let status: Status = t.status
  if (kids.length) status = kidsDone === kids.length ? 'done' : t.status === 'done' ? 'in_progress' : t.status

  let mark: Mark
  let detail = kids.length ? `${kids.length} children: ${kidsDone} ✓ ${kids.length - kidsDone} running` : ''
  if (t.needsInput) {
    mark = '⚑'
    detail = `"${oneLine(t.needsInput)}"`
  } else if (status === 'done' && kids.length && !t.evidence) {
    mark = '✓'
  } else if (status === 'done') {
    const g = grade(t.evidence, t.evidence ? checks.get(checkKey(t.evidence, cwd)) : undefined)
    mark = g === 'proven' ? '✓' : g === 'claimed' ? '~' : g === 'contradicted' ? '✗' : '?'
    detail = t.evidence ? clip(describeEvidence(t.evidence), 40) : 'claimed, no evidence'
    if (g === 'contradicted') detail += ' ✗ failing (live)'
    if (g === 'unverified') detail += ' (unverified)'
  } else if (status === 'in_progress') {
    mark = '◐'
  } else if (status === 'blocked') {
    mark = '!'
    detail = oneLine(t.blockedReason) || 'blocked'
  } else {
    mark = '·'
  }
  return { id: t.id, text: oneLine(t.text), status, mark, detail }
}

const byName = (a: Row, b: Row) => a.name.localeCompare(b.name)
const byPriority = (a: Row, b: Row) =>
  b.flags - a.flags || Number(a.state === 'ended') - Number(b.state === 'ended') || byName(a, b)

export function buildOverview(input: OverviewInput): Row[] {
  const pools = new Map(input.pools.map(e => [e.id, e]))
  const live = new Map(input.live.map(s => [s.sessionId, s]))
  const agents = new Map((input.agents ?? []).filter(a => a.sessionId).map(a => [a.sessionId!, a]))
  const parentOf = (id: string) => pools.get(id)?.pool?.parent?.sessionId

  // Who is shown: every live session, pools written in the last day, ended children of live
  // parents, and the parent of anything shown.
  const ids = new Set(live.keys())
  for (const [id, e] of pools) if (e.error || (e.pool && input.now - e.pool.updatedAt < DAY)) ids.add(id)
  for (let grew = true; grew; ) {
    grew = false
    for (const id of pools.keys()) {
      const parent = parentOf(id)
      if (!parent) continue
      if (!ids.has(id) && live.has(parent)) { ids.add(id); grew = true }
      if (ids.has(id) && pools.has(parent) && !ids.has(parent)) { ids.add(parent); grew = true }
    }
  }

  const built = new Map<string, Row>()

  // A session is complete when its pool has tasks and every one is done. A task with children is done
  // exactly when every child session is complete (viewTask applies the same rule), so this never
  // depends on which rows happen to be built first. A session met again while it is being worked out
  // sits on a cycle, which can never finish, and counts as not complete.
  const memo = new Map<string, boolean>()
  const completeWalk = (id: string, visiting: Set<string>): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const tasks = pools.get(id)?.pool?.tasks
    if (!tasks?.length || visiting.has(id)) return false
    visiting.add(id)
    const ok = tasks.every(t => (t.children?.length ? t.children.every(c => completeWalk(c, visiting)) : t.status === 'done'))
    visiting.delete(id)
    memo.set(id, ok)
    return ok
  }
  const isComplete = (id: string) => completeWalk(id, new Set())

  const build = (id: string, path: Set<string>): Row => {
    const inner = new Set(path).add(id)
    const children = [...ids].filter(c => parentOf(c) === id && !inner.has(c)).map(c => build(c, inner)).sort(byName)
    const e = pools.get(id)
    const pool = e?.pool
    const s = live.get(id)
    const a = agents.get(id)
    const tasks = (pool?.tasks ?? []).map(t => viewTask(t, pool?.cwd ?? '', input.checks, isComplete))
    const done = tasks.filter(t => t.status === 'done').length
    const parent = pool?.parent?.sessionId
    const row: Row = {
      sessionId: id,
      name: oneLine(a?.name) || oneLine(s?.name) || oneLine(pool?.title) || oneLine(id.slice(0, 8)),
      title: oneLine(pool?.title) || oneLine(a?.title),
      // a path may hold spaces, so control characters are replaced rather than folded away by oneLine
      cwd: (pool?.cwd || s?.cwd || '').replace(/\p{Cc}/gu, '?'),
      state: s ? (s.waitingFor ? 'waiting' : s.status) : 'ended',
      waitingFor: s?.waitingFor ? oneLine(s.waitingFor) : undefined,
      tag: s ? (a ? 'herdr' : 'external') : '—',
      paneId: a?.paneId,
      link: sessionLink(s),
      pid: s?.pid,
      hasPool: tasks.length > 0,
      unreadable: e?.error === undefined ? undefined : oneLine(e.error),
      orphan: !!parent && !pools.has(parent) && !live.has(parent),
      done,
      total: tasks.length,
      complete: isComplete(id),
      flags: (pool?.tasks.filter(t => t.needsInput).length ?? 0) + children.reduce((n, c) => n + c.flags, 0),
      tasks,
      children,
    }
    built.set(id, row)
    return row
  }

  const top = [...ids].filter(id => {
    const p = parentOf(id)
    return !p || !ids.has(p)
  })
  const rows = top.map(id => build(id, new Set()))
  // Whatever is still unbuilt hangs off a parent cycle, which has no top. Walk up from it to a member of
  // the cycle and build from there, so each session shows once, under the cycle, rather than twice.
  for (const id of ids) {
    if (built.has(id)) continue
    let root = id
    for (const seen = new Set<string>(); !seen.has(root); root = parentOf(root) ?? root) seen.add(root)
    rows.push(build(root, new Set()))
  }
  return rows.sort(byPriority)
}
```

`src/format.ts`:

```ts
import { homedir } from 'node:os'
import type { Row } from './overview.js'

export type Line = { row: Row; prefix: string }

export function flatten(rows: Row[]): Line[] {
  const out: Line[] = []
  const walk = (rs: Row[], indent: string, nested: boolean) =>
    rs.forEach((r, i) => {
      const last = i === rs.length - 1
      out.push({ row: r, prefix: nested ? `${indent}${last ? '└ ' : '├ '}` : '' })
      walk(r.children, nested ? `${indent}${last ? '  ' : '│ '}` : '', true)
    })
  walk(rows, '', false)
  return out
}

// Only the start of a path can be the home directory, so /mnt/home/u/src/x is left alone.
export function shortCwd(cwd: string, home = homedir()): string {
  const src = `${home}/src/`
  const short = cwd === home ? '~' : cwd.startsWith(src) ? cwd.slice(src.length) : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
  return short.replace('/.worktrees/', '/wt/')
}

// Counts and cuts by code point: slicing UTF-16 units could leave half of an emoji.
const pad = (s: string, n: number) => {
  const chars = Array.from(s)
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s + ' '.repeat(n - chars.length)
}

export function listLine({ row, prefix }: Line): string {
  const progress = row.unreadable
    ? 'unreadable pool'
    : row.hasPool
      ? `${row.done}/${row.total}${row.complete ? ' ✓' : ''}`
      : '—  no pool'
  const flags = row.flags ? `  ⚑${row.flags}` : ''
  const orphan = row.orphan ? '  orphan' : ''
  return `${pad(prefix + row.name, 24)} ${pad(shortCwd(row.cwd), 22)} ${pad(row.state, 7)} ${pad(row.tag, 9)} ${progress}${flags}${orphan}`
}

export function header(rows: Row[]): string {
  const all = flatten(rows).map(l => l.row)
  const live = all.filter(r => r.state !== 'ended').length
  const flags = rows.reduce((n, r) => n + r.flags, 0)
  return `ORCHESTRATOR  ${live} live · ${flags} ⚑ · ${all.length - live} ended`
}

export function renderList(rows: Row[]): string {
  const lines = flatten(rows).map(l => {
    const link = l.row.link ? `\n${' '.repeat(l.prefix.length + 2)}→ ${l.row.link}` : ''
    return listLine(l) + link
  })
  return [header(rows), ...lines].join('\n') + '\n'
}

export function poolLines(row: Row): string[] {
  const head = row.title && row.title !== row.name ? `${row.name} — ${row.title}` : row.name
  if (row.unreadable) return [head, `unreadable pool: ${row.unreadable}`]
  if (!row.tasks.length) return [head, '(no pool yet)']
  return [head, ...row.tasks.map(t => `${t.mark} ${t.id.padEnd(4)} ${pad(t.text, 34)} ${t.detail}`.trimEnd())]
}

export const renderPool = (row: Row) => poolLines(row).join('\n') + '\n'
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test -- tests/overview.test.ts tests/format.test.ts && npm run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/src/overview.ts plugins/orchestrator/src/format.ts plugins/orchestrator/tests/overview.test.ts plugins/orchestrator/tests/format.test.ts
git commit -m "Build the session tree and its text form" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 8: Ctx, self, collect and the pool commands

**Files:**
- Create: `plugins/orchestrator/src/ctx.ts`
- Create: `plugins/orchestrator/src/self.ts`
- Create: `plugins/orchestrator/src/collect.ts`
- Create: `plugins/orchestrator/src/out.ts`
- Create: `plugins/orchestrator/src/cli.ts`
- Modify: `plugins/orchestrator/src/main.ts` (replace the stub)
- Create: `plugins/orchestrator/tests/helpers.ts`
- Test: `plugins/orchestrator/tests/cli.test.ts`, `plugins/orchestrator/tests/exec.test.ts`, `plugins/orchestrator/tests/main.test.ts`, `plugins/orchestrator/tests/helpers.test.ts`

- [ ] **Step 1: Write the test helpers**

`tests/helpers.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { Ctx, ExecResult } from '../src/ctx.js'
import type { Check } from '../src/evidence.js'
import type { Evidence } from '../src/model.js'
import type { Gh } from '../src/sources/gh.js'
import type { Herdr, HerdrAgent } from '../src/sources/herdr.js'

export type FakeHerdr = Herdr & { calls: string[][]; agents: HerdrAgent[] }

export function fakeHerdr(agents: HerdrAgent[] = []): FakeHerdr {
  const calls: string[][] = []
  const h: FakeHerdr = {
    calls,
    agents,
    async list() {
      return h.agents
    },
    async focus(target) {
      calls.push(['focus', target])
    },
    async createTab(o) {
      calls.push(['createTab', o.workspace, o.cwd, o.label])
      return { paneId: 'w9:p1' }
    },
    async startClaude(o) {
      calls.push(['startClaude', o.name, o.paneId, ...o.args])
      h.agents.push({ name: o.name, paneId: o.paneId, status: 'idle', sessionId: 's-child' })
    },
    async sessionIdOf(name) {
      return h.agents.find(a => a.name === name)?.sessionId
    },
    async waitIdle(target) {
      calls.push(['waitIdle', target])
      return h.agents.find(a => a.paneId === target)?.status === 'blocked' ? 'blocked' : 'idle'
    },
    async prompt(target, text) {
      calls.push(['prompt', target, text])
    },
  }
  return h
}

export type FakeExec = Ctx['exec'] & { calls: [command: string, cwd: string][] }

// Records [command, cwd] for every run; the reply decides what the command "printed".
export function fakeExec(
  reply: (command: string) => ExecResult = command => (command.includes('fail') ? { code: 1, out: 'boom\n' } : { code: 0, out: 'ok\n' }),
): FakeExec {
  const calls: FakeExec['calls'] = []
  const exec = (async (command: string, cwd: string) => {
    calls.push([command, cwd])
    return reply(command)
  }) as FakeExec
  exec.calls = calls
  return exec
}

export type FakeGh = Gh & { calls: [ev: Evidence, cwd: string][] }

export function fakeGh(answer: Check = 'unknown'): FakeGh {
  const calls: FakeGh['calls'] = []
  return {
    calls,
    async check(ev, cwd) {
      calls.push([ev, cwd])
      return answer
    },
  }
}

export type TestCtx = Ctx & { stdin: string; herdr: FakeHerdr; exec: FakeExec }

// Every makeCtx home is removed after the test that made it.
const roots: string[] = []
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

export function makeCtx(over: Partial<TestCtx> = {}): TestCtx {
  const root = mkdtempSync(join(tmpdir(), 'orch-'))
  roots.push(root)
  const claudeHome = join(root, 'claude')
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true })
  let t = 1_000_000
  const ctx: TestCtx = {
    env: { CLAUDE_SESSION_ID: 's-self' },
    claudeHome,
    orchHome: join(root, 'orch'),
    cwd: root,
    pid: 4242,
    now: () => (t += 1000),
    sleep: async () => {},
    ppidOf: () => undefined,
    isAlive: () => true,
    stdin: '',
    readStdin: async () => ctx.stdin,
    exec: fakeExec(),
    herdr: fakeHerdr(),
    gh: { check: async () => 'unknown' } satisfies Gh,
    ...over,
  }
  return ctx
}

export function writeSession(ctx: Ctx, o: { pid: number; sessionId: string; cwd?: string; name?: string; status?: string; waitingFor?: string; bridgeSessionId?: string }) {
  writeFileSync(join(ctx.claudeHome, 'sessions', `${o.pid}.json`), JSON.stringify({ cwd: ctx.cwd, status: 'idle', kind: 'interactive', ...o }))
}

// A zombie still answers kill(pid, 0); only a process that is neither running nor waiting to be reaped is gone.
export function pidGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z'
  } catch {
    return true
  }
}

export async function waitFor<T>(probe: () => T | undefined | false, what: string, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 20))
  }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { doneTask, linkChild, newPool, plan, setParent } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { fakeExec, fakeGh, fakeHerdr, makeCtx, writeSession } from './helpers.js'

describe('orch plan / task / ask / title', () => {
  it('counts finished children in the pool it prints', async () => {
    const ctx = makeCtx()
    await run(['plan', 'fan out'], ctx)
    writePool(ctx.orchHome, linkChild(readPool(ctx.orchHome, 's-self')!, 't1', 's-kid', ctx.now()))
    const kid = setParent(plan(newPool('s-kid', '/k', 1), ['write'], 2), { sessionId: 's-self', taskId: 't1' }, undefined, 3)
    writePool(ctx.orchHome, doneTask(kid, 't1', undefined, 4))
    expect((await run(['plan', 'next'], ctx)).stdout).toMatch(/^✓ t1 /m)
  })

  it('creates the pool of the calling session', async () => {
    const ctx = makeCtx()
    const out = await run(['plan', 'Create course', 'Run audit'], ctx)
    expect(out.code).toBe(0)
    expect(out.stdout).toMatch(/· t1\s+Create course/)
    expect(readPool(ctx.orchHome, 's-self')!.tasks.map(t => t.text)).toEqual(['Create course', 'Run audit'])
  })

  it('re-plans without losing finished work', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'commit:abc1234'], ctx)
    await run(['plan', 'c'], ctx)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p.tasks.map(t => t.id)).toEqual(['t1', 't3'])
    expect(p.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('says a tick without evidence is only claimed', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1'], ctx)
    expect(out.stdout).toMatch(/claimed/)
  })

  it('runs cmd evidence itself and refuses a failing command', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b'], ctx)
    const bad = await run(['task', 'done', 't1', '--evidence', 'cmd:npm run fail'], ctx)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/exited 1.*\n.*boom/s)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('pending')
    const good = await run(['task', 'done', 't2', '--evidence', 'cmd:npm test'], ctx)
    expect(good.code).toBe(0)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[1].evidence).toEqual({ kind: 'cmd', ref: 'npm test', exit: 0 })
  })

  it('rejects bad evidence and unknown tasks', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    expect((await run(['task', 'done', 't1', '--evidence', 'sha:1'], ctx)).code).toBe(2)
    const split = await run(['task', 'done', 't1', '--evidence', 'note:looked', 'fine'], ctx)
    expect(split.code).toBe(2)
    expect(split.stderr).toMatch(/quote the evidence/)
    const missing = await run(['task', 'start', 't9'], ctx)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/no task t9/)
  })

  it('adds, starts, blocks, titles and asks', async () => {
    const ctx = makeCtx()
    await run(['task', 'add', 'Re-check', 'CI'], ctx)
    await run(['task', 'block', 't1', 'waiting', 'on', 'runner'], ctx)
    await run(['title', 'Beginner courses'], ctx)
    const ask = await run(['ask', 't1', 'Strict or lenient?'], ctx)
    expect(ask.stdout).toMatch(/push notification/)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p).toMatchObject({ title: 'Beginner courses' })
    expect(p.tasks[0]).toMatchObject({ text: 'Re-check CI', status: 'blocked', blockedReason: 'waiting on runner', needsInput: 'Strict or lenient?' })
  })

  it('finds its session through the parent pid chain', async () => {
    const parents = new Map([[4242, 300], [300, 77]])
    const ctx = makeCtx({ env: {}, ppidOf: pid => parents.get(pid) })
    // other live sessions on both sides, so only the pid chain can pick s-77
    writeSession(ctx, { pid: 76, sessionId: 's-76' })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    writeSession(ctx, { pid: 78, sessionId: 's-78' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-76')).toBeUndefined()
    expect(readPool(ctx.orchHome, 's-78')).toBeUndefined()
  })

  it('fails clearly outside a Claude session', async () => {
    const out = await run(['plan', 'a'], makeCtx({ env: {} }))
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/Claude Code session/)
  })
})

describe('orch status', () => {
  it('shows this session, then every session as text and JSON', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me', bridgeSessionId: 'session_01Me' })
    writeSession(ctx, { pid: 2, sessionId: 's-other', name: 'other' })
    expect((await run(['status'], ctx)).stdout).toMatch(/no pool yet/)
    await run(['plan', 'a'], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^me\n· t1\s+a/)
    const all = await run(['status', '--all'], ctx)
    expect(all.stdout).toMatch(/ORCHESTRATOR  2 live/)
    expect(all.stdout).toContain('→ https://claude.ai/code/session_01Me')
    const json = JSON.parse((await run(['status', '--all', '--json'], ctx)).stdout)
    expect(json.map((r: { name: string }) => r.name).sort()).toEqual(['me', 'other'])
    expect(json.some((r: object) => 'tasks' in r)).toBe(false)
    const one = JSON.parse((await run(['status', 's-self', '--json'], ctx)).stdout)
    expect(one.tasks.map((t: { text: string }) => t.text)).toEqual(['a'])
    expect((await run(['status', 's-nope'], ctx)).stderr).toMatch(/no session s-nope/)
    expect((await run(['status', 's-other'], ctx)).stdout).toBe('other has no pool yet\n')
  })

  it('grades CI evidence with the live check', async () => {
    const ctx = makeCtx({ gh: { check: async () => 'fail' } })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'ci:https://github.com/o/r/actions/runs/1'], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^✗ t1 /m)
  })

  it('prints help and rejects unknown commands', async () => {
    expect((await run([], makeCtx())).stdout).toMatch(/orch plan/)
    expect((await run(['frob'], makeCtx())).code).toBe(2)
  })
})

const CI = 'ci:https://github.com/o/r/actions/runs/1'

describe('orch help and free text', () => {
  it('prints help for --help and -h without touching the pool', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a', 'b', 'c'], ctx)
    const before = readPool(ctx.orchHome, 's-self')
    for (const argv of [['plan', '--help'], ['plan', '-h'], ['plan', 'x', '--help'], ['title', '-h'], ['task', 'add', '--help'], ['task', 'done', 't1', '-h'], ['ask', 't1', '--help'], ['status', '--help']]) {
      const out = await run(argv, ctx)
      expect(out, argv.join(' ')).toMatchObject({ code: 0, stderr: '' })
      expect(out.stdout, argv.join(' ')).toMatch(/orch plan/)
    }
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
    expect(before!.tasks.map(t => t.text)).toEqual(['a', 'b', 'c'])
  })

  it('exits 2 on an unknown option instead of turning it into text', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const before = readPool(ctx.orchHome, 's-self')
    for (const argv of [['plan', '-x'], ['plan', 'b', '--nope'], ['title', '-z'], ['task', 'add', '--oops'], ['task', 'block', 't1', '-q'], ['ask', 't1', '-q']]) {
      const out = await run(argv, ctx)
      expect(out.code, argv.join(' ')).toBe(2)
      expect(out.stderr, argv.join(' ')).toMatch(/^orch: /)
    }
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
  })

  it('takes text that starts with a dash after --', async () => {
    const ctx = makeCtx()
    expect((await run(['plan', '--', '-x'], ctx)).code).toBe(0)
    await run(['task', 'add', '--', '--help', 'me'], ctx)
    await run(['title', '--', '-v2'], ctx)
    const p = readPool(ctx.orchHome, 's-self')!
    expect(p.tasks.map(t => t.text)).toEqual(['-x', '--help me'])
    expect(p.title).toBe('-v2')
  })

  it('refuses a plan with no steps or a blank one, and changes nothing', async () => {
    const ctx = makeCtx()
    const none = await run(['plan'], ctx)
    expect(none.code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toBeUndefined()
    expect((await run(['plan', '', '  '], ctx)).code).toBe(2)
    expect((await run(['plan', 'real', ' '], ctx)).code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toBeUndefined()
    await run(['plan', '  padded  '], ctx)
    expect(readPool(ctx.orchHome, 's-self')!.tasks.map(t => t.text)).toEqual(['padded'])
    const before = readPool(ctx.orchHome, 's-self')
    expect((await run(['plan'], ctx)).code).toBe(2)
    expect(readPool(ctx.orchHome, 's-self')).toEqual(before)
  })

  it('names what is missing without dumping the help', async () => {
    const out = await run(['task', 'add'], makeCtx())
    expect(out.code).toBe(2)
    expect(out.stderr).toBe('orch: missing task text (orch help lists the commands)\n')
  })
})

describe('orch task done --evidence', () => {
  it('treats an empty --evidence as a usage error and keeps the evidence it has', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', 'commit:abc1234'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', ''], ctx)
    expect(out.code).toBe(2)
    expect(out.stderr).toMatch(/bad evidence/)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].evidence).toEqual({ kind: 'commit', ref: 'abc1234' })
  })

  it('runs cmd evidence in the session cwd, not the pool cwd, and says where', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s-self', '/elsewhere', 1), ['a', 'b'], 2))
    const good = await run(['task', 'done', 't1', '--evidence', 'cmd:npm test'], ctx)
    expect(ctx.exec.calls).toEqual([['npm test', ctx.cwd]])
    expect(good.stdout).toBe(`t1 done (cmd npm test (exit 0) in ${ctx.cwd})\n`)
    const bad = await run(['task', 'done', 't2', '--evidence', 'cmd:npm run fail'], ctx)
    expect(ctx.exec.calls[1]).toEqual(['npm run fail', ctx.cwd])
    expect(bad.stderr).toContain(`\`npm run fail\` exited 1 in ${ctx.cwd}, so t2 stays open`)
  })

  it('does not run the command for a task that is not there', async () => {
    const ctx = makeCtx()
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't9', '--evidence', 'cmd:npm test'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/no task t9/)
    expect(ctx.exec.calls).toEqual([])
  })

  it('refuses a command that timed out, shows what it printed and says how to prove long work', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: 'building…\nwaiting for lock\n', signal: 'SIGTERM', timedOut: true })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:make all'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toBe(`orch: refused: \`make all\` timed out after 110 s in ${ctx.cwd}, so t1 stays open; run long commands yourself and tick with commit:, ci: or note:\nbuilding…\nwaiting for lock\n`)
    expect(readPool(ctx.orchHome, 's-self')!.tasks[0].status).toBe('pending')
  })

  it('leaves no blank line when a refused command printed nothing', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: '', timedOut: true })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:make all'], ctx)
    expect(out.stderr).toMatch(/or note:\n$/)
    expect(out.stderr).not.toMatch(/\n\n/)
    const quiet = makeCtx({ exec: fakeExec(() => ({ code: 2, out: '' })) })
    await run(['plan', 'a'], quiet)
    expect((await run(['task', 'done', 't1', '--evidence', 'cmd:true'], quiet)).stderr).toMatch(/stays open\n$/)
  })

  it('names the signal that killed the command instead of calling it an exit', async () => {
    const ctx = makeCtx({ exec: fakeExec(() => ({ code: 1, out: 'Segmentation fault\n', signal: 'SIGSEGV' })) })
    await run(['plan', 'a'], ctx)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:./crash'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toContain(`\`./crash\` was killed by SIGSEGV in ${ctx.cwd}, so t1 stays open`)
    expect(out.stderr).not.toMatch(/exited/)
  })

  it('shows a cleaned tail of a failing command: no escape sequences or control characters, 20 lines, about 4 KB', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const dirty = makeCtx({
      exec: fakeExec(() => ({
        code: 1,
        // a title (OSC ended by BEL), a colour (CSI), a hyperlink (OSC ended by ESC \), a tab, NUL and DEL
        out: `${lines}\nprogress 1\rprogress 2\r\n\x1b]0;evil\x07\x1b[31mred\x1b[0m \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ tab\there\x00\x7f\n`,
      })),
    })
    await run(['plan', 'a'], dirty)
    const out = await run(['task', 'done', 't1', '--evidence', 'cmd:build'], dirty)
    // eslint-disable-next-line no-control-regex
    expect(out.stderr.replace(/\n/g, '').replace(/\t/g, '')).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(out.stderr).toContain('progress 1\nprogress 2\n')
    expect(out.stderr).toContain('red link tab\there')
    for (const left of ['evil', '[31m', '[0m', 'http://x', ']8;;', ']0;']) expect(out.stderr, left).not.toContain(left)
    // 33 cleaned lines, so the last 20 start at line 14
    expect(out.stderr).toContain('line 14\n')
    expect(out.stderr).not.toMatch(/line 13\n/)
    expect(out.stderr.trimEnd().split('\n').length).toBeLessThanOrEqual(22)

    const huge = makeCtx({ exec: fakeExec(() => ({ code: 1, out: `${'x'.repeat(50_000)}END\n` })) })
    await run(['plan', 'a'], huge)
    const big = await run(['task', 'done', 't1', '--evidence', 'cmd:build'], huge)
    expect(big.stderr.length).toBeLessThan(4096 + 300)
    expect(big.stderr).toContain('xxxEND')
  })
})

describe('who is calling', () => {
  it('prefers CLAUDE_CODE_SESSION_ID over our own CLAUDE_SESSION_ID', async () => {
    const ctx = makeCtx({ env: { CLAUDE_CODE_SESSION_ID: 's-code', CLAUDE_SESSION_ID: 's-hook' } })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-code')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-hook')).toBeUndefined()
  })

  it('falls back to CLAUDE_SESSION_ID when Claude Code sets none', async () => {
    const ctx = makeCtx({ env: { CLAUDE_SESSION_ID: 's-hook' } })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-hook')).toBeDefined()
  })

  it('looks CLAUDE_PID up in the live registry without walking /proc', async () => {
    const ctx = makeCtx({
      env: { CLAUDE_PID: '77' },
      ppidOf: () => {
        throw new Error('walked the process tree')
      },
    })
    writeSession(ctx, { pid: 76, sessionId: 's-76' })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    writeSession(ctx, { pid: 78, sessionId: 's-78' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
    expect(readPool(ctx.orchHome, 's-76')).toBeUndefined()
    expect(readPool(ctx.orchHome, 's-78')).toBeUndefined()
  })

  it('walks the process tree when CLAUDE_PID is not a registered session', async () => {
    const parents = new Map([[4242, 77]])
    const ctx = makeCtx({ env: { CLAUDE_PID: '999' }, ppidOf: pid => parents.get(pid) })
    writeSession(ctx, { pid: 77, sessionId: 's-77' })
    await run(['plan', 'a'], ctx)
    expect(readPool(ctx.orchHome, 's-77')).toBeDefined()
  })
})

describe('orch status and gh', () => {
  it('asks gh nothing for status --all, as text or JSON', async () => {
    const gh = fakeGh('fail')
    const ctx = makeCtx({ gh })
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me' })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    expect((await run(['status', '--all'], ctx)).code).toBe(0)
    expect((await run(['status', '--all', '--json'], ctx)).code).toBe(0)
    expect(gh.calls).toEqual([])
  })

  it('asks gh only about the pool it shows, even with another pool holding PR evidence', async () => {
    const gh = fakeGh('pass')
    const ctx = makeCtx({ gh })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    writePool(ctx.orchHome, doneTask(plan(newPool('s-other', '/o', 1), ['x'], 2), 't1', { kind: 'pr', ref: '7' }, 3))
    await run(['status'], ctx)
    expect(gh.calls.map(([ev]) => ev.kind)).toEqual(['ci'])
    gh.calls.length = 0
    await run(['status', 's-other', '--json'], ctx)
    expect(gh.calls.map(([ev, cwd]) => [ev.kind, ev.ref, cwd])).toEqual([['pr', '7', '/o']])
  })

  it('fails fast outside a session, before herdr or gh is asked', async () => {
    const herdr = fakeHerdr()
    let listed = 0
    herdr.list = async () => {
      listed++
      return []
    }
    const gh = fakeGh()
    const out = await run(['status'], makeCtx({ env: {}, herdr, gh }))
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/Claude Code session/)
    expect(listed).toBe(0)
    expect(gh.calls).toEqual([])
  })

  it('starts herdr and the gh checks together', async () => {
    let ghStarted!: () => void
    const started = new Promise<void>(r => (ghStarted = r))
    const herdr = fakeHerdr()
    // herdr answers only once a gh check is under way, so asking them one after the other would hang
    herdr.list = async () => {
      await started
      return []
    }
    const gh = { check: async () => (ghStarted(), 'pass' as const) }
    const ctx = makeCtx({ herdr, gh })
    await run(['plan', 'a'], ctx)
    await run(['task', 'done', 't1', '--evidence', CI], ctx)
    expect((await run(['status'], ctx)).stdout).toMatch(/^✓ t1 /m)
  }, 1500)

  it('still lists sessions, as external, when herdr is down', async () => {
    const herdr = fakeHerdr()
    herdr.list = async () => {
      throw new HerdrError('herdr is not running')
    }
    const ctx = makeCtx({ herdr })
    writeSession(ctx, { pid: 1, sessionId: 's-self', name: 'me' })
    writeSession(ctx, { pid: 2, sessionId: 's-other', name: 'other' })
    const all = await run(['status', '--all', '--json'], ctx)
    expect(all.code).toBe(0)
    expect(JSON.parse(all.stdout).map((r: { tag: string }) => r.tag)).toEqual(['external', 'external'])
    expect((await run(['status', '--all'], ctx)).stdout).toMatch(/external/)
    expect((await run(['status', 's-other'], ctx)).stdout).toBe('other has no pool yet\n')
  })
})
```

`tests/exec.test.ts` (the real shell runner behind `cmd:` evidence):

```ts
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CMD_TIMEOUT_MS, execShell, ppidOf } from '../src/ctx.js'
import { pidGone, waitFor } from './helpers.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orch-exec-')))
  dirs.push(d)
  return d
}

describe('execShell', () => {
  it('runs bash in the cwd and returns the exit code with stdout and stderr together', async () => {
    const dir = tempDir()
    const r = await execShell('pwd; echo e >&2; exit 3', dir)
    expect(r.code).toBe(3)
    expect(r.out).toContain(dir)
    expect(r.out).toContain('e\n')
    expect(r.signal).toBeUndefined()
    expect(r.timedOut).toBeUndefined()
  })

  it('reports exit 0 for a command that works', async () => {
    expect(await execShell('echo hi', tempDir())).toEqual({ code: 0, out: 'hi\n' })
  })

  it('keeps only the last 64 KB of the output', async () => {
    const r = await execShell("head -c 40000 /dev/zero | tr '\\0' A; head -c 30000 /dev/zero | tr '\\0' B", tempDir())
    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(64 * 1024)
    expect(r.out.endsWith('B'.repeat(30_000))).toBe(true)
    expect(r.out.startsWith('A'.repeat(64 * 1024 - 30_000))).toBe(true)
  })

  it('decodes multi-byte characters that arrive in pieces', async () => {
    const r = await execShell("printf '\\xe2\\x9c'; sleep 0.1; printf '\\x93 done'", tempDir())
    expect(r.out).toBe('✓ done')
  })

  it('refuses a missing directory at once with code 127', async () => {
    const dir = join(tempDir(), 'gone')
    expect(await execShell('echo never', dir)).toEqual({ code: 127, out: `directory ${dir} does not exist` })
  })

  it('times out after 110 s by default', () => {
    expect(CMD_TIMEOUT_MS).toBe(110_000)
  })

  it('kills a command and its child group on timeout', async () => {
    const started = Date.now()
    const r = await execShell('sleep 30 & echo $!; wait', tempDir(), { timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGTERM')
    expect(r.code).not.toBe(0)
    const child = Number(r.out.trim().split('\n')[0])
    expect(child).toBeGreaterThan(1)
    await waitFor(() => pidGone(child), 'the background sleep to die')
  })

  it('does not call a success a timeout when a background child holds the pipe past the deadline', async () => {
    // the shell exits 0 at ~0.1 s, the deadline is 0.6 s, and close is awaited until 0.9 s after the exit
    const r = await execShell('sleep 30 & echo $!; sleep 0.1', tempDir(), { timeoutMs: 600, closeWaitMs: 900 })
    expect(r.code).toBe(0)
    expect(r.timedOut).toBeUndefined()
    expect(r.signal).toBeUndefined()
    await waitFor(() => pidGone(Number(r.out.trim().split('\n')[0])), 'the background sleep to die')
  })

  it('escalates to SIGKILL when the command ignores SIGTERM', async () => {
    const r = await execShell("trap '' TERM; echo ready; sleep 30", tempDir(), { timeoutMs: 400, graceMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGKILL')
    expect(r.out).toContain('ready')
  })

  it('does not hang on a background child that keeps the pipe open, and kills it', async () => {
    const started = Date.now()
    const r = await execShell('sleep 30 & echo $!', tempDir(), { closeWaitMs: 100 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.code).toBe(0)
    expect(r.timedOut).toBeUndefined()
    const child = Number(r.out.trim())
    expect(child).toBeGreaterThan(1)
    await waitFor(() => pidGone(child), 'the background sleep to die')
  })

  it('leaves no signal listeners behind', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
    const count = () => signals.map(s => process.listenerCount(s))
    const before = count()
    await execShell('true', tempDir())
    await execShell('sleep 30', tempDir(), { timeoutMs: 100 })
    expect(count()).toEqual(before)
  })
})

describe('ppidOf', () => {
  it.skipIf(!existsSync('/proc/self/stat'))('reads the parent of this very process from /proc', () => {
    expect(ppidOf(process.pid)).toBe(process.ppid)
  })

  it('is undefined for a pid that does not exist', () => {
    expect(ppidOf(2 ** 22 + 12345)).toBeUndefined()
  })
})
```

`tests/main.test.ts` (runs the built `bin/orch`, so build before testing):

```ts
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { describeFailure } from '../src/cli.js'
import { readPool } from '../src/store.js'
import { pidGone, waitFor } from './helpers.js'

// These run the built bin/orch, so `npm run build` has to come first (check:bundle keeps it current).
const BIN = fileURLToPath(new URL('../bin/orch', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// Inside Claude Code these are set to the real session, which would win over the test's own id.
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orch-main-')))
  dirs.push(dir)
  const env: NodeJS.ProcessEnv = { ...process.env, ORCH_HOME: join(dir, 'orch'), ORCH_CLAUDE_HOME: join(dir, 'claude'), CLAUDE_SESSION_ID: 's-main' }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_PID
  return { dir, env }
}

describe('bin/orch', () => {
  it('prints help and exits 0', () => {
    const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: sandbox().env })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/orch plan/)
  })

  it('reports a failure that is not ours as one line, without a stack trace', () => {
    const { dir, env } = sandbox()
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'not a directory')
    const r = spawnSync(process.execPath, [BIN, 'plan', 'a'], { encoding: 'utf8', env: { ...env, ORCH_HOME: join(blocker, 'pools') } })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/^orch: .*(ENOTDIR|EEXIST)/)
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(r.stderr).not.toMatch(/\n\s+at |Node\.js v|node:internal/)
  })

  // The command's group is detached from orch's, so a signal to orch alone would leave it running.
  // Whatever orch is sent, the command is stopped with SIGTERM and the tick is refused.
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const)('kills the command and its group when orch gets %s mid-command', async signal => {
    const { dir, env } = sandbox()
    expect(spawnSync(process.execPath, [BIN, 'plan', 'a'], { env }).status).toBe(0)
    expect(readPool(env.ORCH_HOME!, 's-main')).toBeDefined()
    const pidFile = join(dir, 'pid')
    const child = spawn(process.execPath, [BIN, 'task', 'done', 't1', '--evidence', `cmd:echo $$ > ${pidFile}; exec sleep 30`], { env, cwd: dir })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => (stderr += d))
    const closed = new Promise<number | null>(resolve => child.on('close', resolve))
    let pid = 0
    try {
      pid = await waitFor(() => Number((() => { try { return readFileSync(pidFile, 'utf8') } catch { return '' } })().trim()) || undefined, 'the command to start')
      child.kill(signal)
      expect(await closed).toBe(1)
      expect(stderr).toMatch(/killed by SIGTERM/)
      await waitFor(() => pidGone(pid), 'the command to die')
    } finally {
      if (pid && !pidGone(pid)) process.kill(pid, 'SIGKILL')
      child.kill('SIGKILL')
    }
  })
})

describe('describeFailure', () => {
  it('is the message alone for an ordinary error', () => {
    expect(describeFailure(new Error('boom'))).toBe('orch: boom\n')
    expect(describeFailure('plain')).toBe('orch: plain\n')
  })

  it('points at the sandbox when a write is denied', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      const text = describeFailure(Object.assign(new Error(`${code}: denied, mkdir '/home/u/.claude/orchestrator'`), { code }))
      expect(text).toContain(`orch: ${code}: denied`)
      expect(text).toContain('if Claude Code\'s Bash sandbox is on, add "orch *" to sandbox.excludedCommands in ~/.claude/settings.json')
    }
    expect(describeFailure(Object.assign(new Error('missing'), { code: 'ENOENT' }))).not.toMatch(/sandbox/)
  })
})
```

`tests/helpers.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeCtx } from './helpers.js'

describe('makeCtx', () => {
  let home = ''

  it('makes a home that exists while the test runs', () => {
    home = makeCtx().cwd
    expect(existsSync(home)).toBe(true)
  })

  it('has removed the home of the test before it', () => {
    expect(home).not.toBe('')
    expect(existsSync(home)).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL, cannot find `../src/ctx.js` / `../src/cli.js`.

- [ ] **Step 4: Implement `ctx.ts`, `self.ts`, `collect.ts`**

`src/ctx.ts`:

```ts
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { cliGh, type Gh } from './sources/gh.js'
import { cliHerdr, type Herdr } from './sources/herdr.js'
import { pidAlive } from './sources/sessions.js'

// signal: the command was killed by it (code is then 1). timedOut: orch killed it at CMD_TIMEOUT_MS.
export type ExecResult = { code: number; out: string; signal?: string; timedOut?: boolean }

// A cmd: proof should be a quick check, not a long suite. This cap stops one from hanging a session
// or leaving work running (Claude Code's Bash tool backgrounds a slow call rather than ending it).
export const CMD_TIMEOUT_MS = 110_000
const OUT_KEEP = 64 * 1024

// Every side effect a command needs. Tests pass a fake (tests/helpers.ts).
export type Ctx = {
  env: Record<string, string | undefined>
  claudeHome: string
  orchHome: string
  cwd: string
  pid: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  ppidOf: (pid: number) => number | undefined
  isAlive: (pid: number, procStart?: string) => boolean
  readStdin: () => Promise<string>
  exec: (command: string, cwd: string) => Promise<ExecResult>
  herdr: Herdr
  gh: Gh
}

export function ppidOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    return Number.isFinite(ppid) ? ppid : undefined
  } catch {
    return undefined
  }
}

// The command's group is detached from orch's, so these are forwarded to it. SIGKILL cannot be forwarded.
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

export type ExecOptions = { timeoutMs?: number; graceMs?: number; closeWaitMs?: number }

// Runs `bash -c` in its own process group, so a timeout or a signal to orch takes the whole tree down.
// Keeps the last 64 KB of stdout and stderr together. Resolves when the shell exits; a background child
// that still holds the pipes gets closeWaitMs to let go, then the group is killed.
export function execShell(command: string, cwd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const { timeoutMs = CMD_TIMEOUT_MS, graceMs = 2_000, closeWaitMs = 1_000 } = opts
  if (!existsSync(cwd)) return Promise.resolve({ code: 127, out: `directory ${cwd} does not exist` })
  return new Promise(resolve => {
    let out = ''
    let pid: number | undefined
    let timedOut = false
    let terminating = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, sig)
      } catch {
        // already gone
      }
    }
    // SIGTERM first; SIGKILL after the grace period, at once if asked again
    const terminate = () => {
      if (terminating) return killGroup('SIGKILL')
      terminating = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs)
    }
    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const settle = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      for (const sig of FORWARDED) process.off(sig, terminate)
      killGroup('SIGKILL')
      resolve({ ...r, out, ...(timedOut ? { timedOut } : {}) })
    }
    // listening before the shell exists, so a signal can never arrive while nobody would forward it
    for (const sig of FORWARDED) process.on(sig, terminate)

    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      out = String(e)
      return settle({ code: 127, out })
    }
    pid = child.pid
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const keep = (d: string) => (out = (out + d).slice(-OUT_KEEP))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => {
      out = String(e)
      settle({ code: 127, out })
    })
    let exited: ExecResult | undefined
    child.on('exit', (code, signal) => {
      // the shell finished in time: whatever still holds the pipes is bounded by closeWaitMs, not the deadline
      clearTimeout(deadline)
      exited = { code: code ?? 1, out, ...(signal ? { signal } : {}) }
      setTimeout(() => settle(exited!), closeWaitMs).unref()
    })
    // close comes after exit, once the pipes are drained
    child.on('close', () => exited && settle(exited))
  })
}

async function readStdin(): Promise<string> {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}

export function realCtx(): Ctx {
  const env = process.env
  const claudeHome = env.ORCH_CLAUDE_HOME ?? join(homedir(), '.claude')
  return {
    env,
    claudeHome,
    orchHome: env.ORCH_HOME ?? join(claudeHome, 'orchestrator'),
    cwd: process.cwd(),
    pid: process.pid,
    now: Date.now,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    ppidOf,
    isAlive: pidAlive,
    readStdin,
    exec: (command, cwd) => execShell(command, cwd),
    herdr: cliHerdr(),
    gh: cliGh(),
  }
}
```

`src/self.ts`:

```ts
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { readLiveSessions } from './sources/sessions.js'

// Which session is calling, from the most to the least direct source:
//   CLAUDE_CODE_SESSION_ID  set by Claude Code in every Bash and hook subprocess, and kept current across /clear;
//   CLAUDE_SESSION_ID       our SessionStart hook's export (CLAUDE_ENV_FILE), for a Claude Code that sets no CLAUDE_CODE_ one;
//   CLAUDE_PID              the Claude process's pid, looked up in ~/.claude/sessions;
//   the process tree        walked up from orch until a pid is one of the registered Claude processes.
export function resolveSelf(ctx: Ctx): string {
  const fromEnv = ctx.env.CLAUDE_CODE_SESSION_ID || ctx.env.CLAUDE_SESSION_ID
  if (fromEnv) return fromEnv
  const live = readLiveSessions(ctx.claudeHome, ctx.isAlive)
  const claudePid = Number(ctx.env.CLAUDE_PID)
  if (ctx.env.CLAUDE_PID && Number.isInteger(claudePid)) {
    const s = live.find(x => x.pid === claudePid)
    if (s) return s.sessionId
  }
  const byPid = new Map(live.map(s => [s.pid, s.sessionId]))
  let pid: number | undefined = ctx.pid
  for (let i = 0; i < 32 && pid && pid > 1; i++) {
    const id = byPid.get(pid)
    if (id) return id
    pid = ctx.ppidOf(pid)
  }
  throw new OrchError('cannot tell which session this is: run orch from inside a Claude Code session')
}

export function trySelf(ctx: Ctx): string | undefined {
  try {
    return resolveSelf(ctx)
  } catch {
    return undefined
  }
}
```

`src/collect.ts`:

```ts
import type { Ctx } from './ctx.js'
import { checkKey, type Check } from './evidence.js'
import { buildOverview, type Row } from './overview.js'
import { listPools } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

// Whose CI and PR evidence gh is asked about: nobody's (the default), every live session's pool,
// or exactly these sessions' pools. gh is slow, so a caller asks only for the pools it shows.
export type CollectOpts = { checks?: 'none' | 'live' | ReadonlySet<string> }

export async function collect(ctx: Ctx, opts: CollectOpts = {}): Promise<Row[]> {
  const which = opts.checks ?? 'none'
  const pools = listPools(ctx.orchHome)
  const live = readLiveSessions(ctx.claudeHome, ctx.isAlive)
  const liveIds = new Set(live.map(s => s.sessionId))
  const wanted = (id: string) => (which === 'none' ? false : which === 'live' ? liveIds.has(id) : which.has(id))
  const checks = new Map<string, Check>()
  // herdr and every check run at once; a herdr that is down only costs the herdr tag
  const [agents] = await Promise.all([
    (async () => ctx.herdr.list())().catch(() => null),
    ...pools
      .filter(e => wanted(e.id))
      .flatMap(e =>
        (e.pool?.tasks ?? [])
          .filter(t => t.status === 'done' && (t.evidence?.kind === 'ci' || t.evidence?.kind === 'pr'))
          .map(async t => checks.set(checkKey(t.evidence!, e.pool!.cwd ?? ''), await ctx.gh.check(t.evidence!, e.pool!.cwd))),
      ),
  ])
  return buildOverview({ pools, live, agents, checks, now: ctx.now() })
}
```

- [ ] **Step 5: Implement `out.ts`, `cli.ts` and `main.ts`**

`src/out.ts` (its own module so `hooks.ts`, `spawn.ts` and `reply.ts` never import `cli.ts`, which imports them):

```ts
export type Out = { code: number; stdout: string; stderr: string }

export const ok = (stdout = ''): Out => ({ code: 0, stdout, stderr: '' })
```

`src/cli.ts`:

```ts
import { parseArgs } from 'node:util'
import { collect } from './collect.js'
import { CMD_TIMEOUT_MS, type Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { describeEvidence, parseEvidence } from './evidence.js'
import { flatten, renderList, renderPool } from './format.js'
import { addTask, askTask, blockTask, doneTask, newPool, plan, setTitle, startTask, type Evidence, type Pool } from './model.js'
import { ok, type Out } from './out.js'
import { buildOverview } from './overview.js'
import { resolveSelf } from './self.js'
import { listPools, readPool, update } from './store.js'

const HELP = `orch — task pools for Claude Code sessions

  orch plan "step" "step" …              replace the pending part of this session's pool
  orch title "what this session is for"
  orch task add "text"
  orch task start <id>
  orch task block <id> "why"
  orch task done <id> [--evidence commit:<sha> | pr:<n|url> | ci:<run-url> | cmd:<command> | note:<text>]
  orch ask <id> "question"               flag a question for the person (⚑)
  orch status [<session-id>] [--json]    this (or that) session's pool
  orch status --all [--json]             every session
  orch link <child> <parent> <taskId>    attach a session under a parent task
  orch spawn-child <taskId> --name <n> --cwd <dir> --brief <file> [--prompt <text>]
  orch reply <session> "text" [--mark-only]
  orch tui
`

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new OrchError(`missing ${what} (orch help lists the commands)`, 2)
  return v
}

// The words of a free-text command. An option-looking word (-x) is an error rather than task text;
// a word that starts with a dash goes after `--`.
const words = (args: string[]): string[] => parseArgs({ args, allowPositionals: true }).positionals

function mutateSelf(ctx: Ctx, f: (p: Pool) => Pool): Promise<Pool> {
  const id = resolveSelf(ctx)
  return update(ctx.orchHome, id, p => f(p ?? newPool(id, ctx.cwd, ctx.now())))
}

// Built from the whole store, so a task that waits on children shows their real progress.
function poolText(ctx: Ctx, p: Pool): string {
  const rows = buildOverview({ pools: listPools(ctx.orchHome), live: [], agents: null, checks: new Map(), now: ctx.now() })
  const row = flatten(rows).map(l => l.row).find(r => r.sessionId === p.sessionId)
  return row ? renderPool(row) : ''
}

async function cmdPlan(ctx: Ctx, args: string[]): Promise<Out> {
  const steps = words(args).map(s => s.trim())
  if (!steps.length) throw new OrchError('orch plan needs at least one step', 2)
  if (steps.some(s => !s)) throw new OrchError('orch plan steps cannot be blank', 2)
  const p = await mutateSelf(ctx, p => plan(p, steps, ctx.now()))
  return ok(poolText(ctx, p))
}

async function cmdTitle(ctx: Ctx, args: string[]): Promise<Out> {
  const title = need(words(args).join(' ').trim() || undefined, 'title')
  await mutateSelf(ctx, p => setTitle(p, title, ctx.now()))
  return ok(`title: ${title}\n`)
}

// What a failing command printed, safe to show: whole escape sequences (CSI such as colours, OSC such as
// titles and links) gone, then every other control character but newline and tab (\r becomes a line
// break), the last 20 lines, about 4 KB.
function tailOf(out: string): string {
  const clean = out
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cc}/gu, c => (c === '\n' || c === '\t' ? c : ''))
    .trimEnd()
    .split('\n')
    .slice(-20)
    .join('\n')
  return clean.length > 4096 ? `…${clean.slice(-4096)}` : clean
}

// A refusal, followed by the tail of what the command printed when it printed anything.
function refusal(message: string, out: string): OrchError {
  const tail = tailOf(out)
  return new OrchError(tail ? `${message}\n${tail}` : message)
}

async function cmdDone(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { evidence: { type: 'string' } }, allowPositionals: true })
  const id = need(positionals[0], 'task id')
  if (positionals.length > 1) throw new OrchError(`orch task done takes one task id, got "${positionals.join(' ')}"; quote the evidence, e.g. --evidence "note:looked fine"`, 2)
  let evidence: Evidence | undefined
  if (values.evidence !== undefined) {
    const e = parseEvidence(values.evidence)
    if (e.kind === 'cmd') {
      const self = readPool(ctx.orchHome, resolveSelf(ctx))
      if (!self?.tasks.some(t => t.id === id)) throw new OrchError(`no task ${id} in this pool`)
      // where the session is (the Bash tool's current directory), which is not always where its pool began
      const r = await ctx.exec(e.ref, ctx.cwd)
      if (r.timedOut) {
        throw refusal(`refused: \`${e.ref}\` timed out after ${CMD_TIMEOUT_MS / 1000} s in ${ctx.cwd}, so ${id} stays open; run long commands yourself and tick with commit:, ci: or note:`, r.out)
      }
      if (r.signal || r.code !== 0) {
        const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.code}`
        throw refusal(`refused: \`${e.ref}\` ${how} in ${ctx.cwd}, so ${id} stays open`, r.out)
      }
      evidence = { kind: 'cmd', ref: e.ref, exit: 0 }
    } else {
      evidence = e
    }
  }
  await mutateSelf(ctx, p => doneTask(p, id, evidence, ctx.now()))
  const where = evidence?.kind === 'cmd' ? ` in ${ctx.cwd}` : ''
  return ok(evidence ? `${id} done (${describeEvidence(evidence)}${where})\n` : `${id} done, but only claimed: add --evidence to prove it\n`)
}

async function cmdTask(ctx: Ctx, args: string[]): Promise<Out> {
  const [sub, ...rest] = args
  const now = ctx.now()
  switch (sub) {
    case 'add': {
      const text = need(words(rest).join(' ').trim() || undefined, 'task text')
      const p = await mutateSelf(ctx, p => addTask(p, text, now))
      return ok(`added ${p.tasks.at(-1)!.id}\n`)
    }
    case 'start': {
      const id = need(words(rest)[0], 'task id')
      await mutateSelf(ctx, p => startTask(p, id, now))
      return ok(`${id} in progress\n`)
    }
    case 'block': {
      const [id, ...reason] = words(rest)
      need(id, 'task id')
      const why = need(reason.join(' ').trim() || undefined, 'reason')
      await mutateSelf(ctx, p => blockTask(p, id, why, now))
      return ok(`${id} blocked: ${why}\n`)
    }
    case 'done':
      return cmdDone(ctx, rest)
    default:
      throw new OrchError(`usage: orch task add|start|block|done …\n\n${HELP}`, 2)
  }
}

async function cmdAsk(ctx: Ctx, args: string[]): Promise<Out> {
  const [id, ...rest] = words(args)
  need(id, 'task id')
  const question = need(rest.join(' ').trim() || undefined, 'question')
  await mutateSelf(ctx, p => askTask(p, id, question, ctx.now()))
  return ok(`⚑ ${id}: ${question}\nNow send the person a push notification naming this session and the question.\n`)
}

async function cmdStatus(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: true })
  // --all --json drops task lists and indentation so /orch's Bash output stays small; /orch then asks for one session by id.
  // The overview asks gh nothing: it would wait on one call per finished task of every session.
  if (values.all) {
    const rows = await collect(ctx)
    return ok(values.json ? `${JSON.stringify(rows, (k, v) => (k === 'tasks' ? undefined : v))}\n` : renderList(rows))
  }
  // the id first, so outside a session this fails before herdr or gh is asked; gh only about the pool shown
  const id = positionals[0] ?? resolveSelf(ctx)
  const rows = await collect(ctx, { checks: new Set([id]) })
  const row = flatten(rows).map(l => l.row).find(r => r.sessionId === id)
  if (positionals[0] && !row) throw new OrchError(`no session ${id}`)
  if (values.json) return ok(`${JSON.stringify(row ?? null)}\n`)
  if (row?.tasks.length) return ok(renderPool(row))
  return ok(row && positionals[0] ? `${row.name} has no pool yet\n` : 'no pool yet: run orch plan "step" "step" …\n')
}

// How main prints a failure that run did not turn into an Out: the message alone, never a stack trace.
export function describeFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  const sandbox = code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
  return `orch: ${message}\n${sandbox ? `if Claude Code's Bash sandbox is on, add "orch *" to sandbox.excludedCommands in ~/.claude/settings.json\n` : ''}`
}

export async function run(argv: string[], ctx: Ctx): Promise<Out> {
  const [cmd, ...rest] = argv
  // --help or -h anywhere before a `--` is a request for help, never task text
  const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (flags.includes('--help') || flags.includes('-h')) return ok(HELP)
  try {
    switch (cmd) {
      case 'plan':
        return await cmdPlan(ctx, rest)
      case 'title':
        return await cmdTitle(ctx, rest)
      case 'task':
        return await cmdTask(ctx, rest)
      case 'ask':
        return await cmdAsk(ctx, rest)
      case 'status':
        return await cmdStatus(ctx, rest)
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return ok(HELP)
      default:
        return { code: 2, stdout: '', stderr: `orch: unknown command ${cmd}\n\n${HELP}` }
    }
  } catch (e) {
    if (e instanceof OrchError) return { code: e.code, stdout: '', stderr: `orch: ${e.message}\n` }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) return { code: 2, stdout: '', stderr: `orch: ${e.message}\n` }
    throw e
  }
}
```

`src/main.ts` (replace the stub):

```ts
import { describeFailure, run } from './cli.js'
import { realCtx } from './ctx.js'

try {
  const out = await run(process.argv.slice(2), realCtx())
  process.stdout.write(out.stdout)
  process.stderr.write(out.stderr)
  process.exitCode = out.code
} catch (e) {
  process.stderr.write(describeFailure(e))
  process.exitCode = 1
}
```

- [ ] **Step 6: Run them to see them pass**

Run: `npm run build && npm test && npm run typecheck` (`tests/main.test.ts` runs the built `bin/orch`)
Expected: every suite passes; no type errors.

- [ ] **Step 7: Build and try it by hand**

Run: `npm run build && ORCH_HOME=$(mktemp -d) CLAUDE_CODE_SESSION_ID=demo ./bin/orch plan "Create course" "Run audit"`
Expected: `demo` then `· t1   Create course` and `· t2   Run audit`.

- [ ] **Step 8: Commit**

```bash
git add plugins/orchestrator/src plugins/orchestrator/tests plugins/orchestrator/bin
git commit -m "Add the orch CLI pool commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 9: Hooks

**Files:**
- Create: `plugins/orchestrator/src/hooks.ts`
- Modify: `plugins/orchestrator/src/cli.ts` (add the `hook` case)
- Create: `plugins/orchestrator/hooks/hooks.json`
- Test: `plugins/orchestrator/tests/hooks.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/hooks.test.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { askTask, newPool, plan } from '../src/model.js'
import { poolPath, readPool, writePool } from '../src/store.js'
import { makeCtx, type TestCtx } from './helpers.js'

const hook = (ctx: TestCtx, name: string, input: object) => {
  ctx.stdin = JSON.stringify(input)
  return run(['hook', name], ctx)
}
const contextOf = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string

function transcript(ctx: TestCtx, tools: { name: string; at: number }[]): string {
  const path = join(ctx.cwd, 't.jsonl')
  writeFileSync(path, tools.map(t => JSON.stringify({ type: 'assistant', timestamp: new Date(t.at).toISOString(), message: { content: [{ type: 'tool_use', name: t.name, input: {} }] } })).join('\n') + '\n')
  return path
}

describe('hook session-start', () => {
  it('registers the session and exports its id', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    const out = await hook(ctx, 'session-start', { session_id: 's-new', cwd: '/repo', source: 'startup' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(readPool(ctx.orchHome, 's-new')).toMatchObject({ sessionId: 's-new', cwd: '/repo' })
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-new\n')
  })

  it('links a hand-started child from ORCH_* and points it at the brief', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make courses'], 2), title: 'Courses' })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't1', ORCH_BRIEF: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r/wt', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')).toMatchObject({ parent: { sessionId: 's-par', taskId: 't1' }, brief: '/r/brief.md' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0]).toMatchObject({ children: ['s-kid'], status: 'in_progress' })
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(contextOf(out.stdout)).toMatch(/child of "Courses".*t1 \("Make courses"\).*Read \/r\/brief\.md first/)
  })

  it('does not export an id that failed vetting into the env file', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    const out = await hook(ctx, 'session-start', { session_id: 'x; touch /tmp/pwned', cwd: '/repo' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(existsSync(envFile)).toBe(false)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/invalid session id/)
  })

  const parentPool = (ctx: TestCtx) => writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['Make courses'], 2), title: 'Courses' })
  const orchEnv = (ctx: TestCtx, task = 't1', parent = 's-par') =>
    Object.assign(ctx.env, { ORCH_PARENT: parent, ORCH_PARENT_TASK: task, ORCH_BRIEF: '/r/brief.md' })
  const lockDir = (ctx: TestCtx, id: string) => mkdirSync(`${poolPath(ctx.orchHome, id)}.lock`, { recursive: true })

  it('keeps the brief when ORCH_PARENT_TASK names no task', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx, 't9')
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    const kid = readPool(ctx.orchHome, 's-kid')!
    expect(kid.parent).toBeUndefined()
    expect(kid.brief).toBe('/r/brief.md')
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toBeUndefined()
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/t9/)
  })

  it('keeps the brief when ORCH_PARENT is not a valid session id', async () => {
    const ctx = makeCtx()
    orchEnv(ctx, 't1', '../x')
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')).toMatchObject({ brief: '/r/brief.md' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toBeUndefined()
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/invalid session id/)
  })

  it('links only on startup, so /clear cannot add a duplicate child', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    await hook(ctx, 'session-start', { session_id: 'kid2', cwd: '/r', source: 'clear' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['kid1'])
    expect(readPool(ctx.orchHome, 'kid2')!.parent).toBeUndefined()
  })

  it('does not re-parent or duplicate a resumed child', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    const out = await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'resume' })
    await hook(ctx, 'session-start', { session_id: 'kid1', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['kid1'])
    expect(contextOf(out.stdout)).toMatch(/Read \/r\/brief\.md first/)
  })

  it('does not link into a parent other than the one the child already has', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    writePool(ctx.orchHome, { ...newPool('s-kid', '/r', 1), parent: { sessionId: 's-other', taskId: 't1' } })
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-other', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toBeUndefined()
  })

  it('does not link under a task other than the one the child is already under', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s-par', '/r', 1), ['one', 'two'], 2), title: 'Courses' })
    writePool(ctx.orchHome, { ...newPool('s-kid', '/r', 1), parent: { sessionId: 's-par', taskId: 't1' } })
    Object.assign(ctx.env, { ORCH_PARENT: 's-par', ORCH_PARENT_TASK: 't2', ORCH_BRIEF: '/r/brief.md' })
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[1].children).toBeUndefined()
  })

  it('unsets ORCH_* in the env file so nested claude runs do not inherit them', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    orchEnv(ctx)
    await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'startup' })
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-kid\nunset ORCH_PARENT ORCH_PARENT_TASK ORCH_BRIEF\n')
  })

  it('exports the id even when its own pool is locked', async () => {
    const ctx = makeCtx()
    const envFile = join(ctx.cwd, 'env')
    ctx.env.CLAUDE_ENV_FILE = envFile
    lockDir(ctx, 's-busy')
    const out = await hook(ctx, 'session-start', { session_id: 's-busy', cwd: '/r', source: 'startup' })
    expect(out.code).toBe(0)
    expect(readFileSync(envFile, 'utf8')).toBe('export CLAUDE_SESSION_ID=s-busy\n')
  })

  it('tells a child that already has tasks to pick up where it left off', async () => {
    const ctx = makeCtx()
    parentPool(ctx)
    writePool(ctx.orchHome, { ...plan(newPool('s-kid', '/r', 1), ['a'], 2), parent: { sessionId: 's-par', taskId: 't1' }, brief: '/r/brief.md' })
    const out = await hook(ctx, 'session-start', { session_id: 's-kid', cwd: '/r', source: 'resume' })
    expect(contextOf(out.stdout)).toMatch(/orch status.*where you left off/)
    expect(contextOf(out.stdout)).not.toMatch(/orch plan/)
  })

  it('never fails the session, and logs what went wrong', async () => {
    const ctx = makeCtx()
    ctx.stdin = '{broken'
    expect(await run(['hook', 'session-start'], ctx)).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/hook session-start/)
  })
})

describe('hook prompt-submit', () => {
  it('clears open questions and starts the turn clock', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, askTask(plan(newPool('s1', '/r', 1), ['a'], 2), 't1', 'q?', 3))
    await hook(ctx, 'prompt-submit', { session_id: 's1' })
    const p = readPool(ctx.orchHome, 's1')!
    expect(p.tasks[0].needsInput).toBeUndefined()
    expect(p.turnStartedAt).toBeGreaterThan(0)
  })

  it('nudges when the last turn worked but the pool was not touched', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Edit', at: 6000 }])
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(contextOf(out.stdout)).toMatch(/was not updated during your last turn/)
  })

  it('stays quiet when the pool was touched during the turn', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 7000), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Bash', at: 6000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('suggests a pool when the session worked without one', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...newPool('s1', '/r', 1), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Write', at: 6000 }])
    expect(contextOf((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout)).toMatch(/has no task pool/)
  })

  it('still clears the question when the transcript cannot be read', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...askTask(plan(newPool('s1', '/r', 1), ['a'], 2), 't1', 'q?', 3), turnStartedAt: 5000 })
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: '/nonexistent' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    const p = readPool(ctx.orchHome, 's1')!
    expect(p.tasks[0].needsInput).toBeUndefined()
    expect(p.turnStartedAt).toBeGreaterThan(5000)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/transcript/)
  })

  it('gives up quickly on a leftover lock', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s1', '/r', 1), ['a'], 2))
    mkdirSync(`${poolPath(ctx.orchHome, 's1')}.lock`)
    const t0 = Date.now()
    const out = await hook(ctx, 'prompt-submit', { session_id: 's1' })
    expect(out).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(readFileSync(join(ctx.orchHome, 'orch.log'), 'utf8')).toMatch(/locked/)
  })

  it('counts a subagent run as work', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    for (const name of ['Agent', 'Task']) {
      const path = transcript(ctx, [{ name, at: 6000 }])
      expect(contextOf((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout)).toMatch(/not updated/)
      writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    }
  })

  it('treats the pool as touched when touchedAt equals the turn start', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 5000), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Edit', at: 6000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('ignores transcript lines without a timestamp or of another type', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = join(ctx.cwd, 'u.jsonl')
    const use = { content: [{ type: 'tool_use', name: 'Edit' }] }
    writeFileSync(path, [{ type: 'api-request-blob', timestamp: new Date(6000).toISOString(), message: use }, { type: 'assistant', message: use }].map(o => JSON.stringify(o)).join('\n') + '\n')
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
  })

  it('stays quiet after a read-only turn or on the first prompt', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, { ...plan(newPool('s1', '/r', 1), ['a'], 2), turnStartedAt: 5000 })
    const path = transcript(ctx, [{ name: 'Read', at: 6000 }, { name: 'Edit', at: 4000 }])
    expect((await hook(ctx, 'prompt-submit', { session_id: 's1', transcript_path: path })).stdout).toBe('')
    expect((await hook(ctx, 'prompt-submit', { session_id: 's-first', transcript_path: path })).stdout).toBe('')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/hooks.test.ts`
Expected: FAIL, `orch: unknown command hook` makes the first assertions fail.

- [ ] **Step 3: Implement**

`src/hooks.ts`:

```ts
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { clearQuestions, linkChild, newPool, setParent, startTurn } from './model.js'
import { ok, type Out } from './out.js'
import { log, poolPath, readPool, update, updateIfExists } from './store.js'

type HookInput = { session_id?: string; cwd?: string; transcript_path?: string; source?: string }
type Input = HookInput & { session_id: string }

const WORK = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task']) // subagent edits never show up in this transcript
const NO_POOL =
  '[orch] Your last turn changed files or ran commands, and this session has no task pool. If this is multi-step work, run `orch plan "step" "step" …` (see the orch-pool skill).'
const STALE =
  '[orch] Your task pool was not updated during your last turn. Run `orch status`, then tick finished tasks with evidence or re-plan.'

const context = (event: string, text: string): Out =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`)

// A hook must never wait long on a lock: a stuck one would delay every prompt.
const LOCK_WAIT_MS = 1500

// A hook must never break the session: every error is logged and swallowed.
export async function runHook(ctx: Ctx, name: string | undefined): Promise<Out> {
  try {
    const input = JSON.parse((await ctx.readStdin()) || '{}') as HookInput
    if (!input.session_id) return ok()
    if (name === 'session-start') return await sessionStart(ctx, input as Input)
    if (name === 'prompt-submit') return await promptSubmit(ctx, input as Input)
    log(ctx.orchHome, `unknown hook ${name}`)
  } catch (e) {
    log(ctx.orchHome, `hook ${name}: ${e instanceof OrchError ? e.message : e instanceof Error ? e.stack : String(e)}`)
  }
  return ok()
}

async function sessionStart(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  // poolPath vets the id; the env file is sourced by a shell, so nothing is written before it passes.
  poolPath(ctx.orchHome, id)
  // ORCH_* are set only when the person started this child by hand (spawn-child outside herdr).
  const parentId = ctx.env.ORCH_PARENT
  const taskId = ctx.env.ORCH_PARENT_TASK
  const brief = ctx.env.ORCH_BRIEF
  if (ctx.env.CLAUDE_ENV_FILE) {
    const unset = parentId || taskId || brief ? 'unset ORCH_PARENT ORCH_PARENT_TASK ORCH_BRIEF\n' : ''
    appendFileSync(ctx.env.CLAUDE_ENV_FILE, `export CLAUDE_SESSION_ID=${id}\n${unset}`)
  }

  // /clear, resume and compact start a session again; only a fresh start may link, or a child would be added twice.
  const linking = input.source === 'startup' && !!(parentId && taskId)
  let linkable = false
  if (linking) {
    try {
      linkable = !!readPool(ctx.orchHome, parentId!)?.tasks.some(t => t.id === taskId)
      if (!linkable) log(ctx.orchHome, `hook session-start: parent ${parentId} has no task ${taskId}; keeping only the brief`)
    } catch (e) {
      log(ctx.orchHome, `hook session-start: cannot use parent ${parentId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const pool = await update(
    ctx.orchHome,
    id,
    p => {
      const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
      if (!linking || q.parent) return q
      if (linkable) return setParent(q, { sessionId: parentId!, taskId: taskId! }, brief, now)
      return brief ? { ...q, brief, updatedAt: now } : q
    },
    LOCK_WAIT_MS,
  )
  if (linkable && pool.parent?.sessionId === parentId && pool.parent?.taskId === taskId) {
    try {
      await updateIfExists(ctx.orchHome, parentId!, p => linkChild(p, taskId!, id, now), LOCK_WAIT_MS)
    } catch (e) {
      log(ctx.orchHome, `hook session-start: cannot link ${id} under ${parentId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!pool.brief) return ok()
  const next = pool.tasks.length ? 'run `orch status` to pick up where you left off' : 'then run `orch plan` for your part and tick each task with evidence'
  if (!pool.parent) return context('SessionStart', `[orch] Read ${pool.brief} first, ${next}.`)
  let parent
  try {
    parent = readPool(ctx.orchHome, pool.parent.sessionId)
  } catch {
    // an unreadable parent only costs the title
  }
  const task = parent?.tasks.find(t => t.id === pool.parent!.taskId)
  return context(
    'SessionStart',
    `[orch] This session is a child of "${parent?.title || pool.parent.sessionId}" for its task ${pool.parent.taskId}${task ? ` ("${task.text}")` : ''}. Read ${pool.brief} first, ${next}.`,
  )
}

async function promptSubmit(ctx: Ctx, input: Input): Promise<Out> {
  const id = input.session_id
  const now = ctx.now()
  const before = readPool(ctx.orchHome, id)
  const since = before?.turnStartedAt

  // The pool update comes first: an unreadable transcript must not keep the question flag or the turn clock stale.
  await update(
    ctx.orchHome,
    id,
    p => {
      const q = p ?? newPool(id, input.cwd ?? ctx.cwd, now)
      return startTurn(clearQuestions(q, now) ?? q, now)
    },
    LOCK_WAIT_MS,
  )

  let didWork = false
  if (since !== undefined && input.transcript_path) {
    try {
      didWork = workedSince(input.transcript_path, since)
    } catch (e) {
      log(ctx.orchHome, `hook prompt-submit: cannot read transcript: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!didWork || !before) return ok()
  if (!before.tasks.length) return context('UserPromptSubmit', NO_POOL)
  if ((before.touchedAt ?? 0) < since!) return context('UserPromptSubmit', STALE)
  return ok()
}

export function workedSince(path: string, since: number): boolean {
  for (const line of readTail(path, 4 << 20).split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let o: { type?: string; timestamp?: string; message?: { content?: { type?: string; name?: string }[] } }
    try {
      o = JSON.parse(line)
    } catch {
      continue // the first line of a tail read is usually cut
    }
    if (o.type !== 'assistant' || !(Date.parse(o.timestamp ?? '') >= since)) continue
    if (o.message?.content?.some(b => b?.type === 'tool_use' && WORK.has(b.name ?? ''))) return true
  }
  return false
}

function readTail(path: string, max: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, max)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
```

In `src/cli.ts`, import the hook runner at the top:

```ts
import { runHook } from './hooks.js'
```

and add this case to the `switch` in `run`, after `case 'status':`:

```ts
      case 'hook':
        return await runHook(ctx, rest[0])
```

`hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/orch\" hook session-start", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/orch\" hook prompt-submit", "timeout": 10 }] }
    ]
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test && npm run typecheck`
Expected: every suite passes; no type errors.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add plugins/orchestrator/src plugins/orchestrator/tests plugins/orchestrator/hooks plugins/orchestrator/bin
git commit -m "Register sessions and nudge stale pools from hooks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 10: Link and spawn-child

**Files:**
- Create: `plugins/orchestrator/src/targets.ts`
- Create: `plugins/orchestrator/src/link.ts`
- Create: `plugins/orchestrator/src/spawn.ts`
- Modify: `plugins/orchestrator/src/cli.ts` (add `link` and `spawn-child` cases)
- Test: `plugins/orchestrator/tests/link.test.ts`, `plugins/orchestrator/tests/spawn.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/link.test.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { newPool, plan } from '../src/model.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession } from './helpers.js'

describe('orch link', () => {
  it('still links when an ancestor pool is unreadable', async () => {
    const ctx = makeCtx()
    for (const id of ['s-x', 's-b', 's-c']) writePool(ctx.orchHome, plan(newPool(id, '/r', 1), ['a'], ctx.now()))
    expect((await run(['link', 's-b', 's-x', 't1'], ctx)).code).toBe(0)
    writeFileSync(join(ctx.orchHome, 's-x.json'), '{broken')
    expect((await run(['link', 's-c', 's-b', 't1'], ctx)).code).toBe(0)
  })

  it('refuses a link that would make a cycle', async () => {
    const ctx = makeCtx()
    writePool(ctx.orchHome, plan(newPool('s-a', '/r', 1), ['a'], ctx.now()))
    writePool(ctx.orchHome, plan(newPool('s-b', '/r', 1), ['b'], ctx.now()))
    expect((await run(['link', 's-b', 's-a', 't1'], ctx)).code).toBe(0)
    expect((await run(['link', 's-a', 's-b', 't1'], ctx)).stderr).toMatch(/cycle/)
  })

  it('attaches a session under a parent task by name and moves it off its old parent', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-par', name: 'courses' })
    writeSession(ctx, { pid: 2, sessionId: 's-old', name: 'old' })
    writeSession(ctx, { pid: 3, sessionId: 's-kid', name: 'course-go' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['fan out'], 2))
    writePool(ctx.orchHome, plan(newPool('s-old', '/r', 1), ['x'], 2))
    await run(['link', 'course-go', 'old', 't1'], ctx)
    const out = await run(['link', 'course-go', 'courses', 't1'], ctx)
    expect(out.code).toBe(0)
    expect(readPool(ctx.orchHome, 's-kid')!.parent).toEqual({ sessionId: 's-par', taskId: 't1' })
    expect(readPool(ctx.orchHome, 's-par')!.tasks[0].children).toEqual(['s-kid'])
    expect(readPool(ctx.orchHome, 's-old')!.tasks[0].children).toBeUndefined()
  })

  it('counts the parent linking a child under its own task as its own write', async () => {
    // no CLAUDE_SESSION_ID: orch (pid 4242) finds the parent Claude process (pid 11) by walking up
    const parents = new Map([[4242, 11]])
    const ctx = makeCtx({ env: {}, ppidOf: pid => parents.get(pid) })
    writeSession(ctx, { pid: 11, sessionId: 's-par', name: 'courses' })
    writeSession(ctx, { pid: 12, sessionId: 's-kid', name: 'kid' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['fan out'], 2))
    await run(['link', 'kid', 'courses', 't1'], ctx)
    expect(readPool(ctx.orchHome, 's-par')!.touchedAt).toBeGreaterThan(1000)
  })

  it('refuses unknown tasks, self-links and ambiguous names', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-par', name: 'dup' })
    writeSession(ctx, { pid: 2, sessionId: 's-two', name: 'dup' })
    writePool(ctx.orchHome, plan(newPool('s-par', '/r', 1), ['a'], 2))
    expect((await run(['link', 's-two', 's-par', 't9'], ctx)).stderr).toMatch(/no task t9/)
    expect((await run(['link', 's-par', 's-par', 't1'], ctx)).stderr).toMatch(/own parent/)
    expect((await run(['link', 'dup', 's-par', 't1'], ctx)).stderr).toMatch(/matches several/)
  })
})
```

`tests/spawn.test.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { OrchError } from '../src/errors.js'
import { newPool, plan } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, type TestCtx } from './helpers.js'

function parent(ctx: TestCtx) {
  writePool(ctx.orchHome, { ...plan(newPool('s-self', ctx.cwd, 1), ['Brief', 'Course per language'], 2), title: 'Courses' })
  writeFileSync(join(ctx.cwd, 'brief.md'), '# brief\n')
}

describe('orch spawn-child', () => {
  it('opens a herdr tab, links the child, then sends the intro', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    ctx.herdr.agents.push({ name: 'course-go', paneId: 'w1:p0', status: 'idle', sessionId: 's-other' })
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'course-go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.code).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ sessionId: 's-child', agent: 'course-go-2', paneId: 'w9:p1' })
    expect(ctx.herdr.calls[0]).toEqual(['createTab', 'w1', ctx.cwd, 'course-go-2'])
    expect(ctx.herdr.calls[1]).toEqual(['startClaude', 'course-go-2', 'w9:p1', '--remote-control', 'course-go-2'])
    const [, target, intro] = ctx.herdr.calls[2]
    expect(target).toBe('course-go-2')
    expect(intro).toMatch(/child session of "Courses".*t2: "Course per language".*Read .*brief\.md first/s)
    expect(readPool(ctx.orchHome, 's-child')).toMatchObject({ parent: { sessionId: 's-self', taskId: 't2' }, brief: join(ctx.cwd, 'brief.md') })
    expect(readPool(ctx.orchHome, 's-self')!.tasks[1]).toMatchObject({ children: ['s-child'], status: 'in_progress' })
    // spawning is the parent's own work: it must not look stale to the prompt-submit hook
    expect(readPool(ctx.orchHome, 's-self')!.touchedAt).toBeGreaterThan(1000)
  })

  it('prints a command to run by hand outside herdr', async () => {
    const ctx = makeCtx()
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.stdout).toMatch(/ORCH_PARENT=s-self ORCH_PARENT_TASK=t2 ORCH_BRIEF='.*brief\.md' claude --remote-control 'go'/)
    expect(ctx.herdr.calls).toEqual([])
  })

  it('explains a child stuck on the folder-trust prompt', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.env, { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' })
    ctx.herdr.startClaude = async () => {
      throw new HerdrError('herdr agent start failed: agent not ready (agent_not_ready)', 'agent_not_ready')
    }
    parent(ctx)
    const out = await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/agent_not_ready.*trust this folder.*orch link go s-self t2/s)

    // any other failure still says how to link the child, without the trust hint
    ctx.herdr.startClaude = async () => {
      throw new OrchError('herdr agent start failed: name taken')
    }
    const other = await run(['spawn-child', 't2', '--name', 'go2', '--cwd', '.', '--brief', 'brief.md'], ctx)
    expect(other.stderr).toMatch(/name taken.*orch link go2 s-self t2/s)
    expect(other.stderr).not.toMatch(/trust this folder/)
  })

  it('needs the brief to exist and the task to be real', async () => {
    const ctx = makeCtx()
    parent(ctx)
    expect((await run(['spawn-child', 't2', '--name', 'go', '--cwd', '.', '--brief', 'nope.md'], ctx)).stderr).toMatch(/write the brief first/)
    expect((await run(['spawn-child', 't9', '--name', 'go', '--cwd', '.', '--brief', 'brief.md'], ctx)).stderr).toMatch(/no task t9/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/link.test.ts tests/spawn.test.ts`
Expected: FAIL, `unknown command link` / `unknown command spawn-child`.

- [ ] **Step 3: Implement**

`src/targets.ts`:

```ts
import { OrchError } from './errors.js'
import { flatten } from './format.js'
import type { Row } from './overview.js'

export function resolveTarget(rows: Row[], query: string): Row {
  const all = flatten(rows).map(l => l.row)
  const exact = all.filter(r => r.sessionId === query || r.name === query)
  const matches = exact.length ? exact : all.filter(r => (query.length >= 6 && r.sessionId.startsWith(query)) || r.title === query)
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new OrchError(`no session matches "${query}"`)
  throw new OrchError(`"${query}" matches several sessions: ${matches.map(r => `${r.name} (${r.sessionId.slice(0, 8)})`).join(', ')}`)
}
```

`src/link.ts`:

```ts
import type { Ctx } from './ctx.js'
import { OrchError } from './errors.js'
import { linkChild, newPool, setParent, unlinkChild } from './model.js'
import { readPool, update, updateIfExists } from './store.js'
import { readLiveSessions } from './sources/sessions.js'

export type LinkOptions = {
  brief?: string
  byParent?: boolean // the parent session itself is linking (spawn-child, its own orch link): an own write
}

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
  const previous = readPool(ctx.orchHome, childId)?.parent
  const cwd = readLiveSessions(ctx.claudeHome, ctx.isAlive).find(s => s.sessionId === childId)?.cwd ?? ''
  await update(ctx.orchHome, childId, p => setParent(p ?? newPool(childId, cwd, now), { sessionId: parentId, taskId }, opts.brief, now))
  if (previous && (previous.sessionId !== parentId || previous.taskId !== taskId))
    await updateIfExists(ctx.orchHome, previous.sessionId, p => unlinkChild(p, previous.taskId, childId, now))
  await updateIfExists(ctx.orchHome, parentId, p => linkChild(p, taskId, childId, now, opts.byParent))
}
```

`src/spawn.ts`:

```ts
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
```

In `src/cli.ts`, add imports:

```ts
import { linkSessions } from './link.js'
import { spawnChild } from './spawn.js'
import { resolveTarget } from './targets.js'
```

and change the existing `import { resolveSelf } from './self.js'` line to `import { resolveSelf, trySelf } from './self.js'`.

add these two command functions above `run`:

```ts
async function cmdLink(ctx: Ctx, args: string[]): Promise<Out> {
  const [child, parent, taskId] = [need(args[0], 'child session'), need(args[1], 'parent session'), need(args[2], 'parent task id')]
  const rows = await collect(ctx)
  const c = resolveTarget(rows, child)
  const p = resolveTarget(rows, parent)
  await linkSessions(ctx, c.sessionId, p.sessionId, taskId, { byParent: trySelf(ctx) === p.sessionId })
  return ok(`${c.name} is now under ${p.name} ${taskId}\n`)
}

async function cmdSpawn(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, cwd: { type: 'string' }, brief: { type: 'string' }, prompt: { type: 'string' } },
    allowPositionals: true,
  })
  return spawnChild(ctx, {
    taskId: need(positionals[0], 'task id'),
    name: need(values.name, '--name'),
    cwd: need(values.cwd, '--cwd'),
    brief: need(values.brief, '--brief'),
    prompt: values.prompt,
  })
}
```

and add these cases to the `switch` in `run`, after `case 'hook':`:

```ts
      case 'link':
        return await cmdLink(ctx, rest)
      case 'spawn-child':
        return await cmdSpawn(ctx, rest)
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test && npm run typecheck`
Expected: every suite passes; no type errors.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add plugins/orchestrator/src plugins/orchestrator/tests plugins/orchestrator/bin
git commit -m "Spawn child sessions under a parent task" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 11: Reply

**Files:**
- Create: `plugins/orchestrator/src/reply.ts`
- Modify: `plugins/orchestrator/src/cli.ts` (add the `reply` case)
- Test: `plugins/orchestrator/tests/reply.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/reply.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { askTask, newPool, plan } from '../src/model.js'
import { HerdrError } from '../src/sources/herdr.js'
import { readPool, writePool } from '../src/store.js'
import { makeCtx, writeSession, type TestCtx } from './helpers.js'

function asking(ctx: TestCtx, id: string, name: string, inHerdr: boolean, status = 'idle') {
  writeSession(ctx, { pid: id.length + 10, sessionId: id, name })
  writePool(ctx.orchHome, askTask(plan(newPool(id, '/r', 1), ['pick curve'], 2), 't1', 'Strict or lenient?', 3))
  if (inHerdr) ctx.herdr.agents.push({ name, paneId: `p-${name}`, status, sessionId: id })
}

describe('orch reply', () => {
  it('waits for a herdr session to rest, sends the answer, clears the flag', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(0)
    expect(ctx.herdr.calls).toEqual([
      ['waitIdle', 'p-course-go'],
      ['prompt', 'p-course-go', '[orch reply to: "Strict or lenient?"] strict'],
    ])
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBeUndefined()
  })

  it('gives up on a busy session after the wait and keeps the question open', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: wait timed out (timeout)', 'timeout')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.stderr).toMatch(/still busy after 90 s/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')

    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: timed out after 100000ms')
    }
    expect((await run(['reply', 'course-go', 'strict'], ctx)).stderr).toMatch(/still busy after 90 s/)
  })

  it('reports a pane that closed during the wait with herdr\'s reason', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.waitIdle = async () => {
      throw new HerdrError('herdr agent wait failed: no such agent (agent_not_found)', 'agent_not_found')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/agent_not_found/)
    expect(out.stderr).not.toMatch(/still busy/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('keeps the question open when herdr refuses the prompt', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-go', 'course-go', true)
    ctx.herdr.prompt = async () => {
      throw new HerdrError('herdr agent prompt failed: agent is blocked (agent_blocked)', 'agent_blocked')
    }
    const out = await run(['reply', 'course-go', 'strict'], ctx)
    expect(out.code).toBe(1)
    expect(out.stderr).toMatch(/permission prompt/)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')

    ctx.herdr.prompt = async () => {
      throw new HerdrError('herdr agent prompt failed: timed out after 10000ms')
    }
    const lost = await run(['reply', 'course-go', 'strict'], ctx)
    expect(lost.stderr).toMatch(/may not have got the reply.*timed out.*orch reply course-go --mark-only/s)
    expect(readPool(ctx.orchHome, 's-go')!.tasks[0].needsInput).toBe('Strict or lenient?')
  })

  it('hands sessions outside herdr back to /orch with exit 3', async () => {
    const ctx = makeCtx()
    asking(ctx, 's-ext', 'api-fix', false)
    const out = await run(['reply', 'api-fix', 'lenient'], ctx)
    expect(out.code).toBe(3)
    expect(JSON.parse(out.stdout)).toEqual({ route: 'sendmessage', to: 'api-fix', text: '[orch reply to: "Strict or lenient?"] lenient' })
    expect(readPool(ctx.orchHome, 's-ext')!.tasks[0].needsInput).toBe('Strict or lenient?')
    expect((await run(['reply', 'api-fix', '--mark-only'], ctx)).code).toBe(0)
    expect(readPool(ctx.orchHome, 's-ext')!.tasks[0].needsInput).toBeUndefined()
  })

  it('refuses a session with no question, a blocked one, a waiting one and an ended one', async () => {
    const ctx = makeCtx()
    writeSession(ctx, { pid: 1, sessionId: 's-quiet', name: 'quiet' })
    writePool(ctx.orchHome, plan(newPool('s-quiet', '/r', 1), ['a'], 2))
    expect((await run(['reply', 'quiet', 'x'], ctx)).stderr).toMatch(/no open question/)

    asking(ctx, 's-blk', 'blocked-one', true, 'blocked')
    const blocked = await run(['reply', 'blocked-one', 'x'], ctx)
    expect(blocked.stderr).toMatch(/permission prompt/)
    expect(readPool(ctx.orchHome, 's-blk')!.tasks[0].needsInput).toBe('Strict or lenient?')

    writeSession(ctx, { pid: 40, sessionId: 's-dlg', name: 'dialog-one', status: 'waiting', waitingFor: 'dialog open' })
    writePool(ctx.orchHome, askTask(plan(newPool('s-dlg', '/r', 1), ['a'], 2), 't1', 'q', 3))
    expect((await run(['reply', 'dialog-one', 'x'], ctx)).stderr).toMatch(/waiting on a dialog \(dialog open\)/)
    expect(readPool(ctx.orchHome, 's-dlg')!.tasks[0].needsInput).toBe('q')

    writePool(ctx.orchHome, askTask(plan(newPool('s-gone', '/r', 1), ['a'], ctx.now()), 't1', 'q', ctx.now()))
    expect((await run(['reply', 's-gone', 'x'], ctx)).stderr).toMatch(/has ended/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/reply.test.ts`
Expected: FAIL, `unknown command reply`.

- [ ] **Step 3: Implement**

`src/reply.ts`:

```ts
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
```

In `src/cli.ts`, add the import:

```ts
import { reply } from './reply.js'
```

add this command function above `run`:

```ts
async function cmdReply(ctx: Ctx, args: string[]): Promise<Out> {
  const { values, positionals } = parseArgs({ args, options: { 'mark-only': { type: 'boolean' } }, allowPositionals: true })
  const session = need(positionals[0], 'session')
  return reply(ctx, session, positionals.slice(1).join(' ').trim() || undefined, !!values['mark-only'])
}
```

and this case to the `switch` in `run`, after `case 'spawn-child':`:

```ts
      case 'reply':
        return await cmdReply(ctx, rest)
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test && npm run typecheck`
Expected: every suite passes; no type errors.

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add plugins/orchestrator/src plugins/orchestrator/tests plugins/orchestrator/bin
git commit -m "Answer a waiting session's question with orch reply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 12: TUI

**Files:**
- Create: `plugins/orchestrator/src/tui/App.tsx`
- Create: `plugins/orchestrator/src/tui/main.tsx`
- Modify: `plugins/orchestrator/src/main.ts` (route `tui`)
- Modify: `plugins/orchestrator/build.mjs` (second bundle)
- Modify: `plugins/orchestrator/package.json` (`check:bundle` also requires the bundles to be tracked)
- Test: `plugins/orchestrator/tests/tui.test.tsx`

- [ ] **Step 1: Write the failing tests**

`tests/tui.test.tsx`:

```tsx
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { newPool, type Pool, type Task } from '../src/model.js'
import { buildOverview, type Row } from '../src/overview.js'
import { App, type Actions } from '../src/tui/App.js'

const tick = () => new Promise(r => setTimeout(r, 30))

function pool(id: string, title: string, tasks: Partial<Task>[], extra: Partial<Pool> = {}): Pool {
  return { ...newPool(id, `/src/${id}`, 0), title, tasks: tasks.map((t, i) => ({ id: `t${i + 1}`, text: `${title} step ${i + 1}`, status: 'pending', ...t })), ...extra }
}

function rows(): Row[] {
  return buildOverview({
    pools: [
      { id: 'P', pool: pool('P', 'Courses', [{ status: 'done', evidence: { kind: 'commit', ref: '9f3e2a1' } }, { children: ['C'], status: 'in_progress' }]) },
      { id: 'C', pool: pool('C', 'Python', [{ needsInput: 'Strict?' }], { parent: { sessionId: 'P', taskId: 't2' } }) },
      { id: 'O', pool: pool('O', 'Orchestrator', [{}]) },
    ],
    live: ['P', 'C', 'O'].map(id => ({ pid: 1, sessionId: id, cwd: `/src/${id}`, status: 'idle' as const })),
    agents: [
      { sessionId: 'P', name: 'beginner-courses', paneId: 'pP', status: 'idle' },
      { sessionId: 'C', name: 'course-python', paneId: 'pC', status: 'idle' },
    ],
    checks: new Map(),
    now: 1000,
  })
}

function setup() {
  const data = rows()
  const actions: Actions = {
    load: vi.fn(async () => data),
    focus: vi.fn(async (r: Row) => `focused ${r.name}`),
    link: vi.fn(async (c: Row, p: Row, t: string) => `${c.name} under ${p.name} ${t}`),
  }
  const app = render(<App initial={data} actions={actions} interval={0} />)
  return { app, actions }
}

describe('TUI', () => {
  it('runs one refresh at a time', async () => {
    let finish: (r: Row[]) => void = () => {}
    const load = vi.fn(() => new Promise<Row[]>(r => (finish = r)))
    const app = render(<App initial={rows()} actions={{ load, focus: vi.fn(), link: vi.fn() }} interval={20} />)
    await new Promise(r => setTimeout(r, 120))
    expect(load).toHaveBeenCalledTimes(1)
    finish(rows())
    await new Promise(r => setTimeout(r, 60))
    expect(load.mock.calls.length).toBeGreaterThan(1)
    app.unmount()
  })

  it('lists sessions as a tree with the header', () => {
    const frame = setup().app.lastFrame()!
    expect(frame).toContain('ORCHESTRATOR  3 live · 1 ⚑ · 0 ended')
    expect(frame).toMatch(/▸ beginner-courses .* 1\/2  ⚑1/)
    expect(frame).toMatch(/└ course-python/)
    expect(frame).toMatch(/Orchestrator .*external/)
  })

  it('opens a pool with enter and goes back with h', async () => {
    const { app } = setup()
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toMatch(/beginner-courses — Courses/)
    expect(app.lastFrame()).toMatch(/✓ t1\s+Courses step 1\s+commit 9f3e2a1/)
    expect(app.lastFrame()).toMatch(/◐ t2 .*1 children: 0 ✓ 1 running/)
    app.stdin.write('h')
    await tick()
    expect(app.lastFrame()).toContain('ORCHESTRATOR')
    expect(app.lastFrame()).toMatch(/▸ beginner-courses/)
  })

  it('moves with j and focuses with f', async () => {
    const { app, actions } = setup()
    app.stdin.write('j')
    await tick()
    app.stdin.write('f')
    await tick()
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ name: 'course-python' }))
    expect(app.lastFrame()).toContain('focused course-python')
  })

  it('attaches a session under a parent task with l', async () => {
    const { app, actions } = setup()
    app.stdin.write('j')
    await tick()
    app.stdin.write('j')
    await tick()
    app.stdin.write('l')
    await tick()
    expect(app.lastFrame()).toContain('Attach Orchestrator under which session?')
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toContain('Which task of beginner-courses?')
    app.stdin.write('j')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(actions.link).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'O' }), expect.objectContaining({ sessionId: 'P' }), 't2')
    expect(app.lastFrame()).toContain('Orchestrator under beginner-courses t2')
  })

  it('filters with /', async () => {
    const { app } = setup()
    app.stdin.write('/')
    await tick()
    for (const ch of 'orch') {
      app.stdin.write(ch)
      await tick()
    }
    app.stdin.write('\r')
    await tick()
    expect(app.lastFrame()).toContain('filter: orch')
    expect(app.lastFrame()).not.toContain('course-python')
    expect(app.lastFrame()).toMatch(/▸ Orchestrator/)
  })

  it('shows the claude.ai link with o', async () => {
    const { app } = setup()
    app.stdin.write('o')
    await tick()
    expect(app.lastFrame()).toContain('not on Remote Control')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- tests/tui.test.tsx`
Expected: FAIL, `Cannot find module '../src/tui/App.js'`.

- [ ] **Step 3: Implement**

`src/tui/App.tsx`:

```tsx
import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { flatten, header, listLine, poolLines, shortCwd } from '../format.js'
import type { Row } from '../overview.js'

export type Actions = {
  load: () => Promise<Row[]>
  focus: (row: Row) => Promise<string>
  link: (child: Row, parent: Row, taskId: string) => Promise<string>
}

type Mode =
  | { kind: 'list' }
  | { kind: 'pool'; id: string }
  | { kind: 'pick-parent'; child: Row }
  | { kind: 'pick-task'; child: Row; parent: Row }

const FOOT = {
  list: '↑↓/jk move · enter open · f focus · o link · l attach under parent · / filter · r refresh · q quit',
  pool: 'esc/h back · f focus · o link · q quit',
  pick: 'enter choose · esc/h cancel',
}

export function App({ initial, actions, interval = 3000 }: { initial: Row[]; actions: Actions; interval?: number }) {
  const { exit } = useApp()
  const [rows, setRows] = useState(initial)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [typing, setTyping] = useState(false)
  const [message, setMessage] = useState('')

  // One refresh at a time: a slow herdr or gh call must not stack up a new one every tick.
  const loading = useRef(false)
  const reload = () => {
    if (loading.current) return
    loading.current = true
    actions
      .load()
      .then(setRows, e => setMessage(`refresh failed: ${e}`))
      .finally(() => {
        loading.current = false
      })
  }
  useEffect(() => {
    if (!interval) return
    const t = setInterval(reload, interval)
    return () => clearInterval(t)
  }, [interval])

  const all = flatten(rows).map(l => l.row)
  const lines = flatten(rows).filter(l => !filter || `${l.row.name} ${l.row.title} ${l.row.cwd}`.toLowerCase().includes(filter.toLowerCase()))
  const parents = mode.kind === 'pick-parent' ? all.filter(r => r.sessionId !== mode.child.sessionId && r.hasPool) : []
  const tasks = mode.kind === 'pick-task' ? mode.parent.tasks : []
  const size = mode.kind === 'list' ? lines.length : mode.kind === 'pick-parent' ? parents.length : tasks.length
  const at = Math.min(cursor, Math.max(0, size - 1))
  const selected = mode.kind === 'list' ? lines[at]?.row : mode.kind === 'pool' ? all.find(r => r.sessionId === mode.id) : undefined

  const go = (m: Mode) => {
    setMode(m)
    setCursor(0)
    setMessage('')
  }

  useInput((input, key) => {
    if (typing) {
      if (key.return || key.escape) setTyping(false)
      else if (key.backspace || key.delete) setFilter(f => f.slice(0, -1))
      else if (input) setFilter(f => f + input)
      return
    }
    if (input === 'q') return exit()
    if (key.downArrow || input === 'j') return setCursor(Math.min(at + 1, Math.max(0, size - 1)))
    if (key.upArrow || input === 'k') return setCursor(Math.max(at - 1, 0))
    if (input === 'r') return void reload()

    if (mode.kind === 'list' || mode.kind === 'pool') {
      if (input === 'f' && selected) return void actions.focus(selected).then(setMessage, e => setMessage(String(e)))
      if (input === 'o' && selected) return setMessage(selected.link ?? 'no claude.ai link: this session is not on Remote Control')
    }
    if (mode.kind === 'list') {
      if (key.return && selected) return go({ kind: 'pool', id: selected.sessionId })
      if (input === '/') return setTyping(true)
      if (input === 'l' && selected) return go({ kind: 'pick-parent', child: selected })
      return
    }
    if (mode.kind === 'pick-parent' && key.return && parents[at]) return go({ kind: 'pick-task', child: mode.child, parent: parents[at] })
    if (mode.kind === 'pick-task' && key.return && tasks[at]) {
      const { child, parent } = mode
      setMode({ kind: 'list' })
      return void actions.link(child, parent, tasks[at].id).then(
        m => {
          setMessage(m)
          void reload()
        },
        e => setMessage(String(e)),
      )
    }
    if (key.escape || key.leftArrow || input === 'h') return go({ kind: 'list' })
  })

  const filterNote = filter || typing ? `   filter: ${filter}${typing ? '▏' : ''}` : ''
  const pointer = (i: number) => (i === at ? '▸' : ' ')

  return (
    <Box flexDirection="column">
      <Text bold>{header(rows) + filterNote}</Text>
      {mode.kind === 'list' &&
        (lines.length ? (
          lines.map((l, i) => (
            <Text key={l.row.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${listLine(l)}`}</Text>
          ))
        ) : (
          <Text dimColor>no sessions</Text>
        ))}
      {mode.kind === 'pool' &&
        (selected ? poolLines(selected).map((s, i) => <Text key={i} bold={i === 0}>{s}</Text>) : <Text dimColor>this session is gone</Text>)}
      {mode.kind === 'pick-parent' && (
        <>
          <Text>{`Attach ${mode.child.name} under which session?`}</Text>
          {parents.map((r, i) => (
            <Text key={r.sessionId} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${r.name}  ${shortCwd(r.cwd)}`}</Text>
          ))}
        </>
      )}
      {mode.kind === 'pick-task' && (
        <>
          <Text>{`Which task of ${mode.parent.name}?`}</Text>
          {tasks.map((t, i) => (
            <Text key={t.id} inverse={i === at} wrap="truncate-end">{`${pointer(i)} ${t.id} ${t.text}`}</Text>
          ))}
        </>
      )}
      {message ? <Text color="yellow">{message}</Text> : null}
      <Text dimColor>{mode.kind === 'list' ? FOOT.list : mode.kind === 'pool' ? FOOT.pool : FOOT.pick}</Text>
    </Box>
  )
}
```

`src/tui/main.tsx`:

```tsx
import { render } from 'ink'
import { collect } from '../collect.js'
import type { Ctx } from '../ctx.js'
import { linkSessions } from '../link.js'
import type { Row } from '../overview.js'
import { App, type Actions } from './App.js'

export async function startTui(ctx: Ctx): Promise<void> {
  const actions: Actions = {
    load: () => collect(ctx, { checks: 'live' }),
    async focus(row: Row) {
      if (!row.paneId) return `not in herdr: ${row.cwd}${row.pid ? ` (pid ${row.pid})` : ''}`
      await ctx.herdr.focus(row.paneId)
      return `focused ${row.name}`
    },
    async link(child: Row, parent: Row, taskId: string) {
      await linkSessions(ctx, child.sessionId, parent.sessionId, taskId)
      return `${child.name} is now under ${parent.name} ${taskId}`
    },
  }
  const app = render(<App initial={await collect(ctx, { checks: 'live' })} actions={actions} />)
  await app.waitUntilExit()
}
```

`src/main.ts` (route `tui` to the separate bundle so hooks never load Ink):

```ts
import { describeFailure, run } from './cli.js'
import { realCtx } from './ctx.js'

const argv = process.argv.slice(2)
try {
  if (argv[0] === 'tui') {
    const tui = new URL('../lib/orch-tui.mjs', import.meta.url).href
    const { startTui } = await import(tui)
    await startTui(realCtx())
  } else {
    const out = await run(argv, realCtx())
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.code
  }
} catch (e) {
  process.stderr.write(describeFailure(e))
  process.exitCode = 1
}
```

In `build.mjs`, add after the `chmodSync('bin/orch', 0o755)` line. The TUI bundle gets a Node version guard ahead of all bundled code: a dependency of Ink uses the RegExp `v` flag and dies on Node 18 with a cryptic `SyntaxError`, and `/usr/bin/node` on this machine is v18. `bin/orch` itself gets no guard, because the CLI and hooks run fine on Node 18.

```js
const nodeGuard =
  "\nif (+process.versions.node.split('.')[0] < 20) { process.stderr.write('orch tui: needs Node 20 or newer, got ' + process.version + ' at ' + process.execPath + '\\n'); process.exit(1); }"
mkdirSync('lib', { recursive: true })
await build({ ...common, banner: { js: banner.js + nodeGuard }, entryPoints: ['src/tui/main.tsx'], outfile: 'lib/orch-tui.mjs' })
```

In `package.json`, make `check:bundle` also fail when a bundle was built but never added to git (`git diff` alone only sees tracked files):

```json
    "check:bundle": "node build.mjs && git diff --exit-code -- bin lib && git ls-files --error-unmatch bin/orch lib/orch-tui.mjs",
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm test && npm run typecheck`
Expected: every suite passes; no type errors.

- [ ] **Step 5: Build and open the TUI against the real machine**

Run: `npm run build && ./bin/orch tui`
Expected: the header and one row per running Claude session (they show `no pool` until the plugin is installed), `j`/`k` move, `f` jumps to a herdr pane, `q` quits. Also run `/usr/bin/node lib/orch-tui.mjs` (Node 18): it must print `orch tui: needs Node 20 or newer, got v18…` and exit 1. If the bundle fails to load with `ERR_MODULE_NOT_FOUND` for some package, add it to the stub plugin in `build.mjs` the way `react-devtools-core` is; `Dynamic require` errors point at the `require` shim in `banner`.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/src plugins/orchestrator/tests plugins/orchestrator/build.mjs plugins/orchestrator/package.json plugins/orchestrator/bin plugins/orchestrator/lib
git commit -m "Add the orchestrator TUI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```

---

### Task 13: Skill, /orch command, README, marketplace, install

**Files:**
- Create: `plugins/orchestrator/skills/orch-pool/SKILL.md`
- Create: `plugins/orchestrator/commands/orch.md`
- Create: `plugins/orchestrator/README.md`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Write the skill**

`skills/orch-pool/SKILL.md`:

```markdown
---
name: orch-pool
description: Use at the start of any multi-step task, when a step is finished, when you need the person to decide something, and before fanning work out to other Claude sessions. Keeps this session's task pool in the orch orchestrator current, with evidence, so the person can see every session's progress in one place. Russian - план задач, отметь выполненное, спроси меня, запусти дочернюю сессию.
---

# orch: keep your task pool current

The person runs many Claude sessions at once and follows them through one overview (`orch tui`, `/orch`). Your pool is how they see you. `orch` is on your PATH.

## Three habits

1. **Plan first.** Before real work, write the steps: `orch plan "Create course" "Run audit" "Re-check CI"` and give the session a title once: `orch title "Beginner courses for all languages"`. Running `orch plan` again replaces only the pending steps and keeps finished, started, blocked and asking ones, so list only the steps still to do.
2. **Tick with evidence, as you go.** When a step is done, tick it right away, not in a batch at the end:
   - `orch task done t2 --evidence commit:<sha>`
   - `orch task done t3 --evidence pr:<number>` or `ci:<run-url>` (orch rechecks these live)
   - `orch task done t1 --evidence cmd:"npm test"` (orch runs it in your current directory and refuses a failing one; it stops a command after 110 s, so never use watch modes or servers here, and run longer suites yourself and tick with `commit:`, `ci:` or `note:`)
   - `note:<text>` or no evidence is shown as *claimed*, not done.
   Use `orch task start <id>` when you begin a step and `orch task block <id> "why"` when stuck.
3. **Fan out through orch.** To hand parts to other sessions, write a brief file first (spec, conventions, what to report back), then for each part: `orch spawn-child <taskId> --name <short-name> --cwd <dir> --brief <file>`. Never open child sessions by hand; they would not show under your task.

## When you need the person

Run `orch ask <taskId> "the question"`, then send a push notification naming this session and the question. The person may answer from their phone; the answer arrives as your next prompt, prefixed `[orch reply to: "…"]`.

## If you are a child

Your first context names your parent and brief. Read the brief before anything else, then `orch plan` your part.

`orch status` shows your pool; `orch status --all` shows every session.
```

- [ ] **Step 2: Write the `/orch` command**

`commands/orch.md`:

```markdown
---
description: Overview of every Claude session with tap-through choices - see pools, answer a waiting session, open it on claude.ai
allowed-tools: Bash(orch status:*), Bash(orch reply:*), AskUserQuestion, ListAgents, SendMessage
---

Show the person every local Claude session and let them act on one. This is used from a phone over Remote Control, so keep each message short and drive everything through AskUserQuestion.

1. Run `orch status --all --json`. It prints a compact tree of rows without their tasks: `sessionId`, `name`, `state` (busy, idle, waiting, ended), `tag`, `done`/`total`, `flags` (open questions in the subtree), `link` and `children`.
2. Ask *Which session?* with AskUserQuestion. Options, at most four: sessions with `flags > 0` first, then waiting, then busy ones; label each `name done/total` plus ` ⚑` when it has flags. The person can type any other session's name through *Other*. If there are no sessions, say so and stop.
3. Run `orch status <sessionId> --json` for the chosen row; it adds `tasks` (each with `mark`, `id`, `text`, `detail`). Print them as a short list (`mark id text — detail`) and the `link` if there is one. Then ask *What now?* with the options **Answer ⚑** (only when one of its tasks has `mark` ⚑; for a parent, offer the child that asks), **Open session** (only when it has a `link`), **Back**.
4. **Answer ⚑**: ask the person for the answer as free text, then run `orch reply <sessionId> "<answer>"` (always the id: two sessions can share a name).
   - exit 0: say it was delivered.
   - exit 3: it printed `{"route":"sendmessage","to":…,"text":…}`. Find that session with ListAgents (by name or cwd), send `text` with SendMessage, then run `orch reply <sessionId> --mark-only`.
   - any other exit: show the error line.
5. **Open session**: print the link alone on its line so it is tappable.
6. **Back**: return to step 2 with a fresh `orch status --all --json`. Stop when the person picks nothing or says done.
```

- [ ] **Step 3: Write the README**

`README.md`:

```markdown
# orchestrator

One view over every Claude Code session running on this machine.

- Each session keeps a **task pool** through the `orch` CLI and ticks tasks with **evidence** (commit, PR, CI run, a command orch runs itself). CI and PR evidence is rechecked live.
- Sessions spawned by a session (`orch spawn-child`) nest **under the task** that spawned them, read a shared **brief**, and roll their progress and open questions up to the parent.
- `orch tui` shows every session in a herdr pane; `/orch` does the same from your phone over Remote Control and lets you **answer a waiting session** from there.

Design: [DESIGN.md](DESIGN.md). Plan: [PLAN.md](PLAN.md).

## Install

```bash
claude plugin marketplace add ~/src/ClaudeSkills     # once
claude plugin install orchestrator@claude-skills
```

Then start (or restart) sessions; each registers itself. `orch` is on PATH only inside Claude's own shell, so for the overview pane add an alias once and run `orch tui` in a herdr pane of its own:

```bash
alias orch="$(ls -d ~/.claude/plugins/cache/claude-skills/orchestrator/*/ | tail -1)bin/orch"
```

If Claude Code's Bash sandbox is on, `orch` inside it cannot see other sessions or write its store: every session shows as ended and `orch plan` fails. Exclude it in your user settings (`~/.claude/settings.json`; project settings are ignored for this key):

```json
{ "sandbox": { "excludedCommands": ["orch *"] } }
```

## TUI keys

| Key | Does |
| --- | --- |
| `↑↓` / `jk` | move |
| `enter` | open the session's pool |
| `esc` / `h` | back |
| `f` | focus the session's herdr pane |
| `o` | show the session's claude.ai link |
| `l` | attach the session under a parent task |
| `/` | filter |
| `r` | refresh now (it refreshes every 3 s) |
| `q` | quit |

## Development

```bash
cd plugins/orchestrator
npm install
npm test && npm run typecheck
npm run build      # bin/orch and lib/orch-tui.mjs are committed: rebuild before committing
npm run check:bundle   # after committing: fails if the committed bundles are stale
```

Pools live in `~/.claude/orchestrator/<sessionId>.json` (`ORCH_HOME` overrides); hook errors go to `orch.log` there.
```

- [ ] **Step 4: Add the marketplace entry**

In `.claude-plugin/marketplace.json`, add to the `plugins` array after the `learning-skills` entry:

```json
    {
      "name": "orchestrator",
      "source": "./plugins/orchestrator",
      "description": "One view over every local Claude Code session: task pools with evidence, child sessions under their parent task, a TUI, and /orch for your phone."
    }
```

- [ ] **Step 5: Validate**

Run: `npm test && npm run typecheck && npm run build && cd ../.. && claude plugin validate plugins/orchestrator`
Expected: all suites pass; validation reports the manifest, the `orch-pool` skill, the `/orch` command and the two hooks with no errors. Then check the install path the README alias assumes: after Step 6's install, `ls ~/.claude/plugins/cache/claude-skills/orchestrator/` must list a version directory; if the layout differs, fix the alias line in `README.md`.

- [ ] **Step 6: Install and smoke-test end to end**

```bash
claude plugin marketplace list | grep -q claude-skills || claude plugin marketplace add ~/src/ClaudeSkills
claude plugin install orchestrator@claude-skills
bash ~/.claude/skills/herdr-spawn-rc/scripts/spawn-rc.sh tab --label orch-smoke
herdr agent prompt orch-smoke 'Run: orch title "smoke"; orch plan "write brief" "fan out"; echo "# brief" > /tmp/orch-brief.md; orch spawn-child t2 --name smoke-kid --cwd /tmp --brief /tmp/orch-brief.md' --wait --timeout 300000
orch status --all
```

Expected: `orch status --all` shows `orch-smoke 0/2` with `smoke-kid` nested under it; the `smoke-kid` pane received the intro naming the brief. Then in `smoke-kid` run `orch plan "check" && orch ask t1 "ok?"`, and from `orch-smoke` run `orch reply smoke-kid yes`. Expected: `smoke-kid` receives `[orch reply to: "ok?"] yes`, and `orch status --all` no longer shows ⚑. Finally open `/orch` on the phone and walk one session through the menu. Close the two smoke tabs with `herdr tab close <id>`.

- [ ] **Step 7: Commit**

```bash
git add plugins/orchestrator .claude-plugin/marketplace.json
git commit -m "Add the orch skill, /orch command and marketplace entry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rh6E8Ye2wL28onWR4hj3Ep"
```
