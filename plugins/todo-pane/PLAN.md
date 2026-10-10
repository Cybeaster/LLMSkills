# todo-pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `todo-pane` Claude Code mod described in `DESIGN.md`: a pane that mirrors Claude's TodoWrite and Task items live, lets the person add, tick, untick and delete their own items, feeds those edits to Claude on the next prompt, and draws the list in compact, detailed or grouped view.

**Architecture:** A plugin of function hooks (a "mod"). `hooks/model.ts` holds every data rule as pure functions over plain `Item` records and is unit-tested directly. `hooks/views.tsx` turns a model snapshot into an element tree for the pane. `hooks/register.tsx` wires the engine events (`session.start`, `tool.call`, `prompt.submit`, `command.run`, `ui.close`, `ui.render`) to the model, keeps live values in `$.state` atoms and persists the person's items in `$.store`.

**Tech Stack:** Claude Code 2.1.296 mods API (`claude-code` module, JSX against the global `h`), TypeScript 5.9, `claude plugin validate`, `claude plugin test` (the `claude-code/testing` kit), `tsc`.

**Analytics delta:** none. This is a Claude Code mod in the ClaudeSkills repo, not an ItAbyss webapp surface.

**Repo and paths.** Everything below is relative to `~/src/ClaudeSkills` (branch `main`). The mod lives at `plugins/todo-pane/`. Commands are run from the repo root. Commit messages follow the repo's style: a short sentence-case imperative, no ticket prefix, ending with the attribution trailers.

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB
```

---

## File structure

| File | Responsibility |
| --- | --- |
| `plugins/todo-pane/.claude-plugin/plugin.json` | manifest: name, version, description, `types` |
| `plugins/todo-pane/hooks/hooks.json` | names the hooks module |
| `plugins/todo-pane/hooks/register.tsx` | the hooks and the `$.state` atoms; no data rules, no drawing |
| `plugins/todo-pane/hooks/model.ts` | pure data rules: ids, merges, adoption, display order, the person's edits, the sync note, command parsing, transcript replay, text helpers |
| `plugins/todo-pane/hooks/views.tsx` | `renderPane(els, model, act)`: header, compact / detailed / grouped bodies, the add row |
| `plugins/todo-pane/types/index.d.ts` | the `Item` / `Change` / `View` types and the `PluginState['todo-pane']` contract |
| `plugins/todo-pane/tests/model.test.ts` | unit tests of `model.ts` |
| `plugins/todo-pane/tests/todo-pane.test.ts` | runtime scenarios through the `claude-code/testing` kit |
| `plugins/todo-pane/tsconfig.json` | extends the engine-written `.claude-plugin/types/tsconfig.json` |
| `plugins/todo-pane/.gitignore` | ignores the engine-written `.claude-plugin/types/` |
| `plugins/todo-pane/README.md` | what it does, install line, hotkeys |
| `.claude-plugin/marketplace.json` | gains the `todo-pane` entry (last task) |

**Three commands used throughout** (from `~/src/ClaudeSkills`):

```bash
claude plugin validate plugins/todo-pane          # manifest + module as the engine reads them
~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane   # type-check (TypeScript 5.9.3 already on disk)
claude plugin test plugins/todo-pane              # runs tests/*.test.ts against the real runtime
```

**Engine facts the code relies on** (verified in this build's `claude-code.d.ts`):
- `$.state` refs must be literal `{ plugin: 'todo-pane', key: '<key>' } as const` objects in source; `atom(ref, initial)`, `read($, atom)`, `update($, atom, fn)` come from `'claude-code'`. A `ui.render` hook may read state but never write it.
- `tool.call` hooks with a matcher `{ tool: 'TodoWrite' }` see `e.todos`; the result of `next(e)` is `{ result, text, ref }` or `{ deny }`; `e.agentId` is set for subagent calls.
- `prompt.submit`: attach hidden context with `next({ ...e, context: [...(e.context ?? []), note] })`; the result has `drop` when the prompt did not enter.
- `command.run` input: `{ command, args }`; answer `{ text }`.
- `$.ui.open({ id, title, focus })` → `{ isPlaced }`; `ui.close` input `{ id, origin: { kind: 'plugin' | 'person' | 'unload' } }`.
- Elements: `Button` (`key`, `hotkey` one digit or lowercase letter, `plain`, `dimColor`, `onPress`; children are strings and `Text` only), `Input` (`key`, `placeholder`, `value`, `submitLabel`, `onInput`, `onSubmit`), `Box`, `Text` (`color`, `dimColor`, `bold`). Theme colors used: `'claude'` (accent), `'warning'`, `'success'`.
- Test kit: `test(name, async ($, on) => …)`; hooks the test registers sit beneath the plugin and stand for the engine, so each `$` call the plugin makes needs an answer: a noun call answers `{ value }` (for example `on('session.root', () => ({ value: '/work' }))`); `mock.clock(on, { now })` and `mock.store(on, entries?)` answer `$.clock` and `$.store` from memory. The test's own `$` has no `store` noun, so persistence is asserted by starting a second session in the same test and reading the pane. `$.ui.mount({ plugin, surface, component: 'Pane', requestId, props })` returns a handle with `find`, `findAll`, `press({ key })`, `input({ key, text })`, `unmount()`.

---

### Task 0: Scaffold the plugin and draw an empty pane

**Files:**
- Create: `plugins/todo-pane/.claude-plugin/plugin.json`
- Create: `plugins/todo-pane/hooks/hooks.json`
- Create: `plugins/todo-pane/types/index.d.ts`
- Create: `plugins/todo-pane/hooks/register.tsx`
- Create: `plugins/todo-pane/.gitignore`
- Create: `plugins/todo-pane/tsconfig.json`

- [ ] **Step 0: Confirm the test runner works on this machine**

Run: `claude plugin test --help`
Expected: a usage text beginning `Usage: claude plugin test`.

If instead it prints `hooks modules are turned off in this process: the rollout switch was saved off by an earlier session and is not refreshed yet`, start `claude` once interactively with network access, quit it with `/exit`, and run the command again. If the message still appears, installed mods are turned off remotely for this account and this plan cannot be executed until they are on; stop and report that.

- [ ] **Step 1: Write the manifest**

`plugins/todo-pane/.claude-plugin/plugin.json`:

```json
{
  "name": "todo-pane",
  "version": "0.1.0",
  "description": "An interactive to-do pane: Claude's list mirrored live plus your own items, in compact, detailed or grouped view.",
  "author": { "name": "Cybeaster", "email": "cybeastermail@gmail.com" },
  "types": "./types/index.d.ts"
}
```

`plugins/todo-pane/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`plugins/todo-pane/.gitignore`:

```
.claude-plugin/types/
```

- [ ] **Step 2: Write the full type contract**

`plugins/todo-pane/types/index.d.ts` (the complete contract; later tasks do not change it):

```ts
export type Owner = 'claude' | 'you'
export type Status = 'pending' | 'in_progress' | 'completed'
export type View = 'compact' | 'detailed' | 'grouped'

export type Item = {
  /** 'tw:<hash>' for a TodoWrite row, 'task:<taskId>' for a Task tool row, 'u:<stamp>' for the person's. */
  id: string
  owner: Owner
  text: string
  activeForm?: string
  /** What the owner last said. */
  status: Status
  /** The person's tick/untick on a Claude row, until Claude has had its say. */
  userStatus?: Status
  /** When userStatus was set; compared with deliveredAt to decide when Claude has had its say. */
  overrideAt?: number
  /** On a 'you' row: the id of the Claude row with the same folded text. */
  adoptedBy?: string
  createdAt: number
  updatedAt: number
}

export type Change =
  | { kind: 'added'; text: string; at: number }
  | { kind: 'ticked'; text: string; owner: Owner; at: number }
  | { kind: 'unticked'; text: string; owner: Owner; at: number }
  | { kind: 'deleted'; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': {
      claude: Item[]
      yours: Item[]
      pendingSync: Change[]
      deliveredAt: number
      view: View
      doneCollapsed: boolean
      draft: string
      root: string
    }
  }
}
```

- [ ] **Step 3: Write a minimal hooks module that opens and draws the pane**

`plugins/todo-pane/hooks/register.tsx`:

```tsx
import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'
import type { Item } from '../types'

export const PANE = 'todo'

const claude = atom({ plugin: 'todo-pane', key: 'claude' } as const, [] as Item[])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'todo',
      description: 'Open the to-do pane; /todo add <text> | rm <n> | view compact|detailed|grouped | clear | close',
    })
    return result
  })

  on('command.run', { command: 'todo' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Todo', focus: true })
    return {
      text: opened.isPlaced
        ? 'Todo pane opened.'
        : 'Todo: widen the terminal to 110 columns or more, then run /todo again.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, claude)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{list.length === 0 ? 'No items yet.' : `${list.length} items`}</Text>
      </Box>
    )
  })
}
```

- [ ] **Step 4: Validate**

Run: `cd ~/src/ClaudeSkills && claude plugin validate plugins/todo-pane`
Expected: lines like `types ./types/index.d.ts declares state: todo-pane.claude, todo-pane.yours, …`, `./register.tsx hooks: session.start, command.run{command=todo}, ui.render{component=Pane,requestId=todo}`, `state reads: todo-pane.claude`, and `Validation passed`. If it reports an unresolved import later in the plan, switch the relative imports to explicit `.ts` / `.tsx` extensions and add `"allowImportingTsExtensions": true` to `tsconfig.json`.

- [ ] **Step 5: Lay the type declarations for the editor and tsc**

The engine writes `.claude-plugin/types/` only when an interactive session loads the mod (a `--plugin-dir` folder or the hot-reload folder); a headless `claude -p` run does not. Until then, lay this build's bundled declarations by hand in the same layout, so the same `tsconfig.json` works before and after:

```bash
cd ~/src/ClaudeSkills/plugins/todo-pane
D=$(ls /tmp/claude-1000/bundled-skills/2.1.296/*/plugin-authoring/types/claude-code.d.ts | head -1)
mkdir -p .claude-plugin/types/claude-code
cp "$D" .claude-plugin/types/claude-code/index.d.ts
cat > .claude-plugin/types/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment",
    "typeRoots": ["."]
  }
}
EOF
ls .claude-plugin/types/claude-code/index.d.ts
```

Expected: the file is listed (about 788 KB, first line `// Written by Claude Code 2.1.296.`). The bundled file exists on this machine once the `plugin-authoring` skill has loaded in a session; if the glob matches nothing, load that skill in a Claude Code session and rerun. The folder is gitignored, and an interactive `claude --plugin-dir plugins/todo-pane` later overwrites it with the engine's own copy, which also adds `claude-code-tools/`.

- [ ] **Step 6: Write the mod's tsconfig and type-check**

`plugins/todo-pane/tsconfig.json`:

```json
{
  "extends": "./.claude-plugin/types/tsconfig.json",
  "include": [".claude-plugin/types", "hooks", "types", "tests"]
}
```

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/.claude-plugin/plugin.json plugins/todo-pane/hooks/hooks.json plugins/todo-pane/hooks/register.tsx plugins/todo-pane/types/index.d.ts plugins/todo-pane/.gitignore plugins/todo-pane/tsconfig.json
git commit -m "Scaffold the todo-pane mod with an empty pane and /todo" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 1: model.ts — folding, ids and the TodoWrite merge

**Files:**
- Create: `plugins/todo-pane/hooks/model.ts`
- Create: `plugins/todo-pane/tests/model.test.ts`

- [ ] **Step 1: Write the failing tests**

`plugins/todo-pane/tests/model.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'
import * as M from '../hooks/model'
import type { Item } from '../types'

const NOW = 1_000_000

const row = (content: string, status: M.TodoRow['status'] = 'pending', activeForm = ''): M.TodoRow => ({
  content,
  status,
  activeForm,
})

describe('fold and ids', () => {
  test('fold lowercases, collapses whitespace and strips one trailing mark', async () => {
    expect(M.fold('  Write  Tests. ')).toBe('write tests')
    expect(M.fold('Ship it!')).toBe('ship it')
    expect(M.fold('a.b.')).toBe('a.b')
  })

  test('todoIds are stable across reorders and distinct for duplicates', async () => {
    const a = M.todoIds([row('One'), row('Two')])
    const b = M.todoIds([row('Two'), row('One')])
    expect(a[0]).toBe(b[1])
    expect(a[1]).toBe(b[0])
    expect(a[0]!.startsWith('tw:')).toBe(true)
    const dup = M.todoIds([row('Same'), row('same')])
    expect(dup[0]).not.toBe(dup[1])
    expect(dup[1]!.endsWith('#2')).toBe(true)
  })
})

describe('mergeTodoWrite', () => {
  test('replaces the TodoWrite rows and keeps createdAt for rows that stay', async () => {
    const first = M.mergeTodoWrite([], [row('A'), row('B', 'in_progress', 'Doing B')], NOW, 0)
    expect(first.map(i => i.text)).toEqual(['A', 'B'])
    expect(first[1]!.status).toBe('in_progress')
    expect(first[1]!.activeForm).toBe('Doing B')
    expect(first.every(i => i.owner === 'claude')).toBe(true)

    const second = M.mergeTodoWrite(first, [row('B', 'completed'), row('C')], NOW + 5_000, 0)
    expect(second.map(i => i.text)).toEqual(['B', 'C'])
    expect(second[0]!.createdAt).toBe(NOW)
    expect(second[0]!.updatedAt).toBe(NOW + 5_000)
    expect(second[1]!.createdAt).toBe(NOW + 5_000)
  })

  test('keeps Task rows when TodoWrite rows are replaced', async () => {
    const task: Item = {
      id: 'task:7', owner: 'claude', text: 'T', status: 'pending', createdAt: NOW, updatedAt: NOW,
    }
    const out = M.mergeTodoWrite([task], [row('A')], NOW, 0)
    expect(out.map(i => i.id)).toEqual([M.todoIds([row('A')])[0], 'task:7'])
  })

  test('an override is cleared when Claude agrees, kept before delivery, cleared after delivery', async () => {
    const base = M.mergeTodoWrite([], [row('A')], NOW, 0)
    const ticked: Item[] = [{ ...base[0]!, userStatus: 'completed', overrideAt: NOW + 1 }]

    const agreed = M.mergeTodoWrite(ticked, [row('A', 'completed')], NOW + 2, 0)
    expect(agreed[0]!.userStatus).toBeUndefined()

    const beforeDelivery = M.mergeTodoWrite(ticked, [row('A', 'in_progress')], NOW + 2, 0)
    expect(beforeDelivery[0]!.userStatus).toBe('completed')

    const afterDelivery = M.mergeTodoWrite(ticked, [row('A', 'in_progress')], NOW + 10, NOW + 5)
    expect(afterDelivery[0]!.userStatus).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: FAIL, the module `../hooks/model` cannot be found.

- [ ] **Step 3: Write the first slice of model.ts**

`plugins/todo-pane/hooks/model.ts`:

```ts
import type { Change, Item, Owner, Status, View } from '../types'

export type { Change, Item, Owner, Status, View }

/** One TodoWrite row as the tool carries it. */
export type TodoRow = { content: string; status: Status; activeForm: string }

export const VIEWS: readonly View[] = ['compact', 'detailed', 'grouped']
export const MAX_TEXT = 500

/** Lowercase, collapse whitespace, trim, strip one trailing `.` or `!`. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]$/, '')
}

/** FNV-1a 32-bit over the string, base-36. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** `tw:<hash of folded content>`, with `#2`, `#3` suffixes for repeated folded content in list order. */
export function todoIds(rows: readonly TodoRow[]): string[] {
  const seen = new Map<string, number>()
  return rows.map(r => {
    const base = `tw:${hash(fold(r.content))}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
}

/**
 * Carries the person's override from `old` onto `item`, or drops it:
 * dropped when Claude's new status equals it (Claude agreed), or when the
 * change was delivered to Claude after the override was made (Claude had its say).
 */
export function settleOverride(item: Item, old: Item | undefined, deliveredAt: number): Item {
  if (!old?.userStatus) return item
  if (old.userStatus === item.status) return item
  if (old.overrideAt !== undefined && deliveredAt > old.overrideAt) return item
  return { ...item, userStatus: old.userStatus, overrideAt: old.overrideAt }
}

/** Replaces every `tw:` row with the TodoWrite list; Task rows are kept after them. */
export function mergeTodoWrite(prev: readonly Item[], rows: readonly TodoRow[], now: number, deliveredAt: number): Item[] {
  const ids = todoIds(rows)
  const byId = new Map(prev.map(i => [i.id, i] as const))
  const tasks = prev.filter(i => !i.id.startsWith('tw:'))
  const next = rows.map((r, n) => {
    const id = ids[n]!
    const old = byId.get(id)
    const unchanged = old !== undefined && old.status === r.status && old.text === r.content
    const item: Item = {
      id,
      owner: 'claude',
      text: r.content,
      status: r.status,
      createdAt: old?.createdAt ?? now,
      updatedAt: unchanged ? old.updatedAt : now,
      ...(r.activeForm ? { activeForm: r.activeForm } : {}),
    }
    return settleOverride(item, old, deliveredAt)
  })
  return [...next, ...tasks]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: `5 pass`, `0 fail`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/model.ts plugins/todo-pane/tests/model.test.ts
git commit -m "Add todo-pane model: folding, stable ids and the TodoWrite merge" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 2: model.ts — the Task tool family

**Files:**
- Modify: `plugins/todo-pane/hooks/model.ts` (append)
- Modify: `plugins/todo-pane/tests/model.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/model.test.ts`:

```ts
describe('Task tool family', () => {
  test('TaskCreate adds a pending row; a repeat patches the subject', async () => {
    const one = M.applyTaskCreate([], { id: '1', subject: 'Do X', activeForm: 'Doing X' }, NOW)
    expect(one).toEqual([
      { id: 'task:1', owner: 'claude', text: 'Do X', activeForm: 'Doing X', status: 'pending', createdAt: NOW, updatedAt: NOW },
    ])
    const again = M.applyTaskCreate(one, { id: '1', subject: 'Do X better' }, NOW + 1)
    expect(again).toHaveLength(1)
    expect(again[0]!.text).toBe('Do X better')
    expect(again[0]!.createdAt).toBe(NOW)
  })

  test('TaskUpdate patches status and fields, removes on deleted, ignores unknown ids', async () => {
    const one = M.applyTaskCreate([], { id: '1', subject: 'Do X' }, NOW)
    const running = M.applyTaskUpdate(one, { taskId: '1', status: 'in_progress', activeForm: 'Working' }, NOW + 1, 0)
    expect(running[0]!.status).toBe('in_progress')
    expect(running[0]!.activeForm).toBe('Working')
    expect(running[0]!.updatedAt).toBe(NOW + 1)
    const gone = M.applyTaskUpdate(running, { taskId: '1', status: 'deleted' }, NOW + 2, 0)
    expect(gone).toEqual([])
    expect(M.applyTaskUpdate(one, { taskId: '9', status: 'completed' }, NOW, 0)).toEqual(one)
  })

  test('TaskUpdate settles an override like TodoWrite does', async () => {
    const one = M.applyTaskCreate([], { id: '1', subject: 'Do X' }, NOW)
    const ticked: Item[] = [{ ...one[0]!, userStatus: 'completed', overrideAt: NOW + 1 }]
    expect(M.applyTaskUpdate(ticked, { taskId: '1', status: 'completed' }, NOW + 2, 0)[0]!.userStatus).toBeUndefined()
    expect(M.applyTaskUpdate(ticked, { taskId: '1', subject: 'Renamed' }, NOW + 2, 0)[0]!.userStatus).toBe('completed')
    expect(M.applyTaskUpdate(ticked, { taskId: '1', subject: 'Renamed' }, NOW + 9, NOW + 5)[0]!.userStatus).toBeUndefined()
  })

  test('TaskList reconciles task rows and leaves TodoWrite rows alone', async () => {
    const tw = M.mergeTodoWrite([], [row('A')], NOW, 0)
    const withTasks = M.applyTaskCreate(M.applyTaskCreate(tw, { id: '1', subject: 'One' }, NOW), { id: '2', subject: 'Two' }, NOW)
    const listed = M.applyTaskList(
      withTasks,
      [{ id: '2', subject: 'Two renamed', status: 'completed' }, { id: '3', subject: 'Three', status: 'pending' }],
      NOW + 1,
      0,
    )
    expect(listed.map(i => i.id)).toEqual([tw[0]!.id, 'task:2', 'task:3'])
    expect(listed[1]!.text).toBe('Two renamed')
    expect(listed[1]!.status).toBe('completed')
    expect(listed[1]!.createdAt).toBe(NOW)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: FAIL, `M.applyTaskCreate is not a function`.

- [ ] **Step 3: Implement the Task functions**

Append to `plugins/todo-pane/hooks/model.ts`:

```ts
export type TaskCreated = { id: string; subject: string; activeForm?: string }
export type TaskPatch = { taskId: string; subject?: string; activeForm?: string; status?: Status | 'deleted' }
export type TaskListed = { id: string; subject: string; status: Status }

const taskId = (id: string) => `task:${id}`

/** Adds the Task row as pending, or patches the subject/activeForm of one that already exists. */
export function applyTaskCreate(prev: readonly Item[], t: TaskCreated, now: number): Item[] {
  const id = taskId(t.id)
  const old = prev.find(i => i.id === id)
  if (old) {
    return prev.map(i => (i.id === id ? { ...i, text: t.subject, ...(t.activeForm ? { activeForm: t.activeForm } : {}), updatedAt: now } : i))
  }
  const item: Item = {
    id, owner: 'claude', text: t.subject, status: 'pending', createdAt: now, updatedAt: now,
    ...(t.activeForm ? { activeForm: t.activeForm } : {}),
  }
  return [...prev, item]
}

/** Patches one Task row; `status: 'deleted'` removes it; an unknown id is ignored. */
export function applyTaskUpdate(prev: readonly Item[], u: TaskPatch, now: number, deliveredAt: number): Item[] {
  const id = taskId(u.taskId)
  const old = prev.find(i => i.id === id)
  if (!old) return [...prev]
  if (u.status === 'deleted') return prev.filter(i => i.id !== id)
  const { userStatus: _u, overrideAt: _o, ...bare } = old
  const patched: Item = {
    ...bare,
    text: u.subject ?? old.text,
    status: u.status ?? old.status,
    updatedAt: now,
    ...(u.activeForm !== undefined ? { activeForm: u.activeForm } : {}),
  }
  const settled = settleOverride(patched, old, deliveredAt)
  return prev.map(i => (i.id === id ? settled : i))
}

/** Upserts every listed task and drops Task rows the list no longer has; TodoWrite rows untouched. */
export function applyTaskList(prev: readonly Item[], tasks: readonly TaskListed[], now: number, deliveredAt: number): Item[] {
  const listed = new Set(tasks.map(t => taskId(t.id)))
  const kept = prev.filter(i => !i.id.startsWith('task:') || listed.has(i.id))
  let out: Item[] = [...kept]
  for (const t of tasks) {
    const id = taskId(t.id)
    const old = out.find(i => i.id === id)
    if (!old) {
      out.push({ id, owner: 'claude', text: t.subject, status: t.status, createdAt: now, updatedAt: now })
      continue
    }
    const { userStatus: _u, overrideAt: _o, ...bare } = old
    const changed = old.text !== t.subject || old.status !== t.status
    const patched: Item = { ...bare, text: t.subject, status: t.status, updatedAt: changed ? now : old.updatedAt }
    out = out.map(i => (i.id === id ? settleOverride(patched, old, deliveredAt) : i))
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: `9 pass`, `0 fail`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/model.ts plugins/todo-pane/tests/model.test.ts
git commit -m "Mirror the Task tool family in the todo-pane model" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 3: model.ts — adoption, display order, counts and the person's edits

**Files:**
- Modify: `plugins/todo-pane/hooks/model.ts` (append)
- Modify: `plugins/todo-pane/tests/model.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/model.test.ts`:

```ts
const mine = (id: string, text: string, status: M.Status = 'pending', extra: Partial<Item> = {}): Item => ({
  id: `u:${id}`, owner: 'you', text, status, createdAt: NOW, updatedAt: NOW, ...extra,
})

describe('adoption and display', () => {
  test('adopt links a your-row to the Claude row with the same folded text, once', async () => {
    const claude = M.mergeTodoWrite([], [row('Write tests.')], NOW, 0)
    const yours = [mine('1', 'write  tests'), mine('2', 'Write tests'), mine('3', 'Other')]
    const out = M.adopt(yours, claude)
    expect(out[0]!.adoptedBy).toBe(claude[0]!.id)
    expect(out[1]!.adoptedBy).toBeUndefined()
    expect(out[2]!.adoptedBy).toBeUndefined()
    const released = M.adopt(out, [])
    expect(released[0]!.adoptedBy).toBeUndefined()
  })

  test('display lists Claude rows then un-adopted your-rows; badges name adopted Claude rows', async () => {
    const claude = M.mergeTodoWrite([], [row('A'), row('B')], NOW, 0)
    const yours = M.adopt([mine('1', 'b'), mine('2', 'C')], claude)
    const rows = M.display(claude, yours)
    expect(rows.map(i => i.text)).toEqual(['A', 'B', 'C'])
    expect([...M.badges(yours)]).toEqual([claude[1]!.id])
  })

  test('effectiveStatus prefers the override; counts use it', async () => {
    const claude = M.mergeTodoWrite([], [row('A'), row('B', 'in_progress'), row('C', 'completed')], NOW, 0)
    const ticked = [{ ...claude[0]!, userStatus: 'completed' as const, overrideAt: NOW }, claude[1]!, claude[2]!]
    expect(M.effectiveStatus(ticked[0]!)).toBe('completed')
    expect(M.counts(ticked)).toEqual({ done: 2, total: 3, running: 1 })
  })
})

describe("the person's edits", () => {
  test('addYours trims, clips and refuses empty text', async () => {
    expect(M.addYours([], '   ', NOW, 'u:1')).toBeNull()
    const long = 'x'.repeat(600)
    const added = M.addYours([], `  ${long}  `, NOW, 'u:1')!
    expect(added.yours[0]!.text).toHaveLength(M.MAX_TEXT)
    expect(added.change).toEqual({ kind: 'added', text: 'x'.repeat(M.MAX_TEXT), at: NOW })
  })

  test('toggleYours flips pending and completed', async () => {
    const yours = [mine('1', 'A')]
    const done = M.toggleYours(yours, 'u:1', NOW + 1)!
    expect(done.yours[0]!.status).toBe('completed')
    expect(done.change).toEqual({ kind: 'ticked', text: 'A', owner: 'you', at: NOW + 1 })
    const back = M.toggleYours(done.yours, 'u:1', NOW + 2)!
    expect(back.yours[0]!.status).toBe('pending')
    expect(back.change.kind).toBe('unticked')
    expect(M.toggleYours(yours, 'u:9', NOW)).toBeNull()
  })

  test('toggleClaude sets the override and stamps overrideAt', async () => {
    const claude = M.mergeTodoWrite([], [row('A', 'in_progress')], NOW, 0)
    const t = M.toggleClaude(claude, claude[0]!.id, NOW + 1)!
    expect(t.claude[0]!.userStatus).toBe('completed')
    expect(t.claude[0]!.overrideAt).toBe(NOW + 1)
    expect(t.change).toEqual({ kind: 'ticked', text: 'A', owner: 'claude', at: NOW + 1 })
    const u = M.toggleClaude(t.claude, claude[0]!.id, NOW + 2)!
    expect(u.claude[0]!.userStatus).toBe('pending')
    expect(u.change.kind).toBe('unticked')
  })

  test('removeYours and clearDone report deletions', async () => {
    const yours = [mine('1', 'A'), mine('2', 'B', 'completed'), mine('3', 'C', 'completed')]
    const removed = M.removeYours(yours, 'u:1', NOW)!
    expect(removed.yours.map(i => i.id)).toEqual(['u:2', 'u:3'])
    expect(removed.change).toEqual({ kind: 'deleted', text: 'A', at: NOW })
    const cleared = M.clearDone(removed.yours, NOW)
    expect(cleared.yours).toEqual([])
    expect(cleared.changes.map(c => c.text)).toEqual(['B', 'C'])
  })

  test('syncNote reads as the spec shows', async () => {
    const note = M.syncNote([
      { kind: 'ticked', text: 'Write tests for X', owner: 'claude', at: NOW },
      { kind: 'added', text: 'Update CHANGELOG', at: NOW },
      { kind: 'deleted', text: 'Old idea', at: NOW },
      { kind: 'unticked', text: 'Ping Addy', owner: 'you', at: NOW },
    ])
    expect(note).toBe(
      [
        '[todo pane] The user edited the shared to-do pane since your last turn:',
        '- ticked as completed: "Write tests for X" (your item)',
        '- added: "Update CHANGELOG" (user item, pending)',
        '- deleted: "Old idea" (user item)',
        '- unticked back to pending: "Ping Addy" (user item)',
        'Reflect ticks in your own list. Treat added user items as requested work unless the user says otherwise.',
      ].join('\n'),
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: FAIL, `M.adopt is not a function`.

- [ ] **Step 3: Implement adoption, display and the edits**

Append to `plugins/todo-pane/hooks/model.ts`:

```ts
/** Marks each your-row adopted by the first unclaimed Claude row with the same folded text. */
export function adopt(yours: readonly Item[], claude: readonly Item[]): Item[] {
  const claimed = new Set<string>()
  return yours.map(y => {
    const match = claude.find(c => !claimed.has(c.id) && fold(c.text) === fold(y.text))
    if (match) {
      claimed.add(match.id)
      return y.adoptedBy === match.id ? y : { ...y, adoptedBy: match.id }
    }
    if (y.adoptedBy === undefined) return y
    const { adoptedBy: _a, ...rest } = y
    return rest
  })
}

/** Claude's rows in Claude's order, then the person's un-adopted rows in creation order. */
export function display(claude: readonly Item[], yours: readonly Item[]): Item[] {
  return [...claude, ...yours.filter(y => y.adoptedBy === undefined)]
}

/** The Claude row ids that carry a `·you` badge: those a your-row was adopted by. */
export function badges(yours: readonly Item[]): Set<string> {
  return new Set(yours.flatMap(y => (y.adoptedBy ? [y.adoptedBy] : [])))
}

export function effectiveStatus(item: Item): Status {
  return item.userStatus ?? item.status
}

export function counts(rows: readonly Item[]): { done: number; total: number; running: number } {
  let done = 0
  let running = 0
  for (const r of rows) {
    const s = effectiveStatus(r)
    if (s === 'completed') done++
    else if (s === 'in_progress') running++
  }
  return { done, total: rows.length, running }
}

export type YoursEdit = { yours: Item[]; change: Change }
export type ClaudeEdit = { claude: Item[]; change: Change }

export function addYours(yours: readonly Item[], text: string, now: number, id: string): YoursEdit | null {
  const clean = text.trim().slice(0, MAX_TEXT)
  if (clean === '') return null
  const item: Item = { id, owner: 'you', text: clean, status: 'pending', createdAt: now, updatedAt: now }
  return { yours: [...yours, item], change: { kind: 'added', text: clean, at: now } }
}

export function toggleYours(yours: readonly Item[], id: string, now: number): YoursEdit | null {
  const old = yours.find(i => i.id === id)
  if (!old) return null
  const status: Status = old.status === 'completed' ? 'pending' : 'completed'
  return {
    yours: yours.map(i => (i.id === id ? { ...i, status, updatedAt: now } : i)),
    change: { kind: status === 'completed' ? 'ticked' : 'unticked', text: old.text, owner: 'you', at: now },
  }
}

export function toggleClaude(claude: readonly Item[], id: string, now: number): ClaudeEdit | null {
  const old = claude.find(i => i.id === id)
  if (!old) return null
  const target: Status = effectiveStatus(old) === 'completed' ? 'pending' : 'completed'
  return {
    claude: claude.map(i => (i.id === id ? { ...i, userStatus: target, overrideAt: now } : i)),
    change: { kind: target === 'completed' ? 'ticked' : 'unticked', text: old.text, owner: 'claude', at: now },
  }
}

export function removeYours(yours: readonly Item[], id: string, now: number): YoursEdit | null {
  const old = yours.find(i => i.id === id)
  if (!old) return null
  return { yours: yours.filter(i => i.id !== id), change: { kind: 'deleted', text: old.text, at: now } }
}

export function clearDone(yours: readonly Item[], now: number): { yours: Item[]; changes: Change[] } {
  const gone = yours.filter(i => effectiveStatus(i) === 'completed')
  return {
    yours: yours.filter(i => effectiveStatus(i) !== 'completed'),
    changes: gone.map(i => ({ kind: 'deleted', text: i.text, at: now })),
  }
}

const whose = (owner: Owner) => (owner === 'claude' ? 'your item' : 'user item')

/** The hidden context block attached to the person's next prompt. */
export function syncNote(changes: readonly Change[]): string {
  const lines = changes.map(c => {
    switch (c.kind) {
      case 'added': return `- added: "${c.text}" (user item, pending)`
      case 'ticked': return `- ticked as completed: "${c.text}" (${whose(c.owner)})`
      case 'unticked': return `- unticked back to pending: "${c.text}" (${whose(c.owner)})`
      case 'deleted': return `- deleted: "${c.text}" (user item)`
    }
  })
  return [
    '[todo pane] The user edited the shared to-do pane since your last turn:',
    ...lines,
    'Reflect ticks in your own list. Treat added user items as requested work unless the user says otherwise.',
  ].join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: `17 pass`, `0 fail`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/model.ts plugins/todo-pane/tests/model.test.ts
git commit -m "Add adoption, display order and the person's edits to the todo-pane model" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---
### Task 4: model.ts — commands, views, ages, truncation and transcript replay

**Files:**
- Modify: `plugins/todo-pane/hooks/model.ts` (append)
- Modify: `plugins/todo-pane/tests/model.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/model.test.ts`:

```ts
describe('commands, views and text helpers', () => {
  test('parseCommand covers every form', async () => {
    expect(M.parseCommand('')).toEqual({ kind: 'open' })
    expect(M.parseCommand('   ')).toEqual({ kind: 'open' })
    expect(M.parseCommand('view grouped')).toEqual({ kind: 'view', view: 'grouped' })
    expect(M.parseCommand('view sideways')).toEqual({ kind: 'usage' })
    expect(M.parseCommand('add  Update CHANGELOG ')).toEqual({ kind: 'add', text: 'Update CHANGELOG' })
    expect(M.parseCommand('add   ')).toEqual({ kind: 'usage' })
    expect(M.parseCommand('rm 3')).toEqual({ kind: 'rm', n: 3 })
    expect(M.parseCommand('rm x')).toEqual({ kind: 'usage' })
    expect(M.parseCommand('clear')).toEqual({ kind: 'clear' })
    expect(M.parseCommand('close')).toEqual({ kind: 'close' })
    expect(M.parseCommand('dance')).toEqual({ kind: 'usage' })
  })

  test('nextView cycles and isView guards', async () => {
    expect(M.nextView('compact')).toBe('detailed')
    expect(M.nextView('detailed')).toBe('grouped')
    expect(M.nextView('grouped')).toBe('compact')
    expect(M.isView('grouped')).toBe(true)
    expect(M.isView('wide')).toBe(false)
    expect(M.isView(42)).toBe(false)
  })

  test('age and truncate', async () => {
    expect(M.age(NOW, NOW - 10_000)).toBe('just now')
    expect(M.age(NOW, NOW - 12 * 60_000)).toBe('12m ago')
    expect(M.age(NOW, NOW - 3 * 3_600_000)).toBe('3h ago')
    expect(M.age(NOW, NOW - 2 * 86_400_000)).toBe('2d ago')
    expect(M.truncate('short', 10)).toBe('short')
    expect(M.truncate('a long line of text', 8)).toBe('a long …')
    expect(M.truncate('abc', 0)).toBe('…')
  })

  test('glyph per status', async () => {
    expect(M.glyph('pending')).toBe('○')
    expect(M.glyph('in_progress')).toBe('▶')
    expect(M.glyph('completed')).toBe('✓')
  })
})

describe('replayTranscript', () => {
  test('replays the last TodoWrite and every Task tool use in order', async () => {
    const messages = [
      { toolUses: [{ tool: 'TodoWrite', input: { todos: [row('Old')] }, result: { oldTodos: [], newTodos: [row('Old')] } }] },
      { toolUses: [{ tool: 'TaskCreate', input: { subject: 'T1', description: '' }, result: { task: { id: '1', subject: 'T1' } } }] },
      { toolUses: [{ tool: 'TodoWrite', input: { todos: [row('New', 'in_progress')] } }] },
      { toolUses: [{ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: { success: true } }] },
      { toolUses: [{ tool: 'Read', input: { file_path: 'x' } }] },
    ]
    const out = M.replayTranscript(messages, NOW)
    expect(out.map(i => [i.text, i.status])).toEqual([['New', 'in_progress'], ['T1', 'completed']])
  })

  test('tolerates malformed tool uses', async () => {
    const messages = [
      { toolUses: [{ tool: 'TodoWrite', input: {} }] },
      { toolUses: [{ tool: 'TaskCreate', input: { subject: 'T' }, result: {} }] },
      { toolUses: [] },
    ]
    expect(M.replayTranscript(messages, NOW)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: FAIL, `M.parseCommand is not a function`.

- [ ] **Step 3: Implement**

Append to `plugins/todo-pane/hooks/model.ts`:

```ts
export type Command =
  | { kind: 'open' }
  | { kind: 'view'; view: View }
  | { kind: 'add'; text: string }
  | { kind: 'rm'; n: number }
  | { kind: 'clear' }
  | { kind: 'close' }
  | { kind: 'usage' }

export const USAGE = 'Usage: /todo | /todo view compact|detailed|grouped | /todo add <text> | /todo rm <n> | /todo clear | /todo close'

export function isView(x: unknown): x is View {
  return typeof x === 'string' && (VIEWS as readonly string[]).includes(x)
}

export function nextView(v: View): View {
  return VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]!
}

export function parseCommand(args: string): Command {
  const a = args.trim()
  if (a === '') return { kind: 'open' }
  if (a === 'clear') return { kind: 'clear' }
  if (a === 'close') return { kind: 'close' }
  const view = /^view\s+(\S+)$/.exec(a)
  if (view) return isView(view[1]) ? { kind: 'view', view: view[1] } : { kind: 'usage' }
  const add = /^add\s+(\S[\s\S]*)$/.exec(a)
  if (add) return { kind: 'add', text: add[1]!.trim() }
  const rm = /^rm\s+(\d+)$/.exec(a)
  if (rm) return { kind: 'rm', n: Number(rm[1]) }
  return { kind: 'usage' }
}

export function glyph(status: Status): string {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '▶' : '○'
}

export function age(now: number, then: number): string {
  const m = Math.floor((now - then) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Cuts to `width` cells, ending with an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  return `${text.slice(0, Math.max(0, width - 1))}…`
}

/** The subset of a transcript row this module reads. */
export type TranscriptMessage = { toolUses: readonly { tool: string; input: Record<string, unknown>; result?: unknown }[] }

const isRows = (x: unknown): x is TodoRow[] =>
  Array.isArray(x) && x.every(r => r && typeof r === 'object' && typeof (r as TodoRow).content === 'string' && typeof (r as TodoRow).status === 'string')

/** Rebuilds the Claude mirror from a transcript: the TodoWrite and Task tool uses, in order. */
export function replayTranscript(messages: readonly TranscriptMessage[], now: number): Item[] {
  let claude: Item[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      const res = (use.result && typeof use.result === 'object' ? use.result : {}) as Record<string, unknown>
      try {
        if (use.tool === 'TodoWrite') {
          const rows = isRows(res.newTodos) ? res.newTodos : isRows(use.input.todos) ? use.input.todos : null
          if (rows) claude = mergeTodoWrite(claude, rows.map(r => ({ ...r, activeForm: r.activeForm ?? '' })), now, 0)
        } else if (use.tool === 'TaskCreate') {
          const task = res.task as { id?: unknown; subject?: unknown } | undefined
          if (task && typeof task.id === 'string' && typeof task.subject === 'string') {
            const activeForm = typeof use.input.activeForm === 'string' ? use.input.activeForm : undefined
            claude = applyTaskCreate(claude, { id: task.id, subject: task.subject, ...(activeForm ? { activeForm } : {}) }, now)
          }
        } else if (use.tool === 'TaskUpdate') {
          const { taskId, subject, activeForm, status } = use.input
          if (typeof taskId === 'string') {
            claude = applyTaskUpdate(claude, {
              taskId,
              ...(typeof subject === 'string' ? { subject } : {}),
              ...(typeof activeForm === 'string' ? { activeForm } : {}),
              ...(typeof status === 'string' ? { status: status as TaskPatch['status'] } : {}),
            }, now, 0)
          }
        } else if (use.tool === 'TaskList') {
          const tasks = res.tasks
          if (Array.isArray(tasks)) {
            claude = applyTaskList(
              claude,
              tasks.filter((t): t is TaskListed => !!t && typeof t.id === 'string' && typeof t.subject === 'string' && typeof t.status === 'string'),
              now,
              0,
            )
          }
        }
      } catch {
        // a malformed tool use is skipped; the rest of the transcript still replays
      }
    }
  }
  return claude
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: `23 pass`, `0 fail`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/model.ts plugins/todo-pane/tests/model.test.ts
git commit -m "Add command parsing, text helpers and transcript replay to the todo-pane model" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 5: Live mirror — tool.call hooks, session.start replay, compact view

**Files:**
- Create: `plugins/todo-pane/hooks/views.tsx`
- Modify: `plugins/todo-pane/hooks/register.tsx` (replace whole file)
- Create: `plugins/todo-pane/tests/todo-pane.test.ts`

**How the runtime tests read the pane.** The kit's `find` matches an element's own string children, so every assertion about a row reads the row's `Text` leaf (`{ type: 'Text', text: /✓ Explore/ }`), never the `Button` around it. Presses go by key: a Claude row's key is `item:` + the id `M.todoIds` computes from the same content, and one of the person's rows is found as the first `Button` whose key starts with `item:u:`.

- [ ] **Step 1: Write the failing runtime test**

`plugins/todo-pane/tests/todo-pane.test.ts`:

```ts
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import * as M from '../hooks/model'

const NOW = 1_000_000
const ROOT = '/work'

export const PANE_PROPS = {
  title: 'Todo',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as any

export const todo = (content: string, status: 'pending' | 'in_progress' | 'completed' = 'pending', activeForm = '') => ({ content, status, activeForm })

/** The pane key of the Claude row TodoWrite would make for this content. */
export const rowKey = (content: string) => `item:${M.todoIds([todo(content)])[0]}`

export type World = { messages?: unknown[]; store?: Record<string, unknown>; opened?: { count: number }; captured?: { context?: readonly string[] } }

/** The engine beneath the plugin: every `$` call the mod makes gets an answer. */
export function world(on: On, opts: World = {}) {
  mock.clock(on, { now: NOW })
  mock.store(on, opts.store ?? {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    if (opts.opened) opts.opened.count++
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, ($, e) => ({ result: { oldTodos: [], newTodos: e.todos }, text: 'Todos have been modified successfully' }))
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: '1', subject: e.subject } }, text: 'created' }))
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] }, text: 'updated' }))
  on('prompt.submit', ($, e) => {
    if (opts.captured) opts.captured.context = e.context
    return { text: e.text, context: e.context, origin: e.origin }
  })
}

export async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
}

export async function mountPane($: any) {
  return $.ui.mount({ plugin: 'todo-pane', surface: 'terminal', component: 'Pane', requestId: 'todo', props: PANE_PROPS })
}

export async function yourRowKey(ui: any): Promise<string> {
  const buttons = await ui.findAll({ type: 'Button' })
  const mine = buttons.find((b: any) => typeof b.key === 'string' && b.key.startsWith('item:u:'))
  if (!mine) throw new Error('no your-row drawn')
  return mine.key
}

describe('mirror', () => {
  test('a TodoWrite call fills the pane and the header counts', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /No items yet/ })).toBeDefined()

    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('Explore', 'completed'), todo('Propose', 'in_progress', 'Proposing'), todo('Write doc')] } as any)

    expect(await ui.find({ type: 'Text', text: /1\/3 done · 1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✓ Explore$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ Propose$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^○ Write doc$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: rowKey('Explore') })).toBeDefined()
    await ui.unmount()
  })

  test('Task tool calls are mirrored too, and subagent calls are ignored', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($)
    await $.tool.call({ tool: 'TaskCreate', tool_use_id: 't1', subject: 'Run tests', description: '' } as any)
    expect(await ui.find({ type: 'Text', text: /^○ Run tests$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'item:task:1' })).toBeDefined()
    await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 't2', taskId: '1', status: 'completed' } as any)
    expect(await ui.find({ type: 'Text', text: /^✓ Run tests$/ })).toBeDefined()
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't3', agentId: 'agent-9', todos: [todo('Subagent thing')] } as any)
    expect(await ui.find({ type: 'Text', text: /Subagent thing/ })).toBeUndefined()
    await ui.unmount()
  })

  test('session.start replays the transcript', async ($, on) => {
    world(on, {
      messages: [
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'TodoWrite', input: { todos: [todo('From before', 'in_progress')] }, result: { oldTodos: [], newTodos: [todo('From before', 'in_progress')] } }] },
      ],
    })
    await start($)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^▶ From before$/ })).toBeDefined()
    await ui.unmount()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: the three `mirror` tests FAIL (no `1/3 done` text; the Task 0 pane draws `No items yet.` or a bare count), the 23 model tests pass.

- [ ] **Step 3: Write the compact view**

`plugins/todo-pane/hooks/views.tsx`:

```tsx
import type { Elements } from 'claude-code'
import type { Item, View } from '../types'
import * as M from './model'

/** The elements every surface that draws a pane has. */
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input'>

export type PaneModel = {
  claude: readonly Item[]
  yours: readonly Item[]
  view: View
  doneCollapsed: boolean
  draft: string
  now: number
  columns: number
}

export type Actions = {
  onToggle: (id: string) => void
  onView: () => void
  onAddFocus: () => void
  onDraft: (text: string) => void
  onAdd: (text: string) => void
  onRemove: (id: string) => void
  onToggleDone: () => void
}

export const BADGE = ' ·you'

function rowColor(status: M.Status, overridden: boolean) {
  if (overridden) return { color: 'warning' as const }
  if (status === 'in_progress') return { color: 'claude' as const }
  if (status === 'completed') return { dimColor: true }
  return {}
}

export function header(els: Els, m: PaneModel, act: Actions) {
  const { Box, Text, Button } = els
  const rows = M.display(m.claude, m.yours)
  const c = M.counts(rows)
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>{`${c.done}/${c.total} done · ${c.running} running`}</Text>
      <Button key="view" hotkey="v" plain dimColor onPress={act.onView}>{m.view}</Button>
    </Box>
  )
}

export function addRow(els: Els, m: PaneModel, act: Actions) {
  const { Box, Input, Button } = els
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Input key="add" placeholder="add item…" value={m.draft} submitLabel="add" onInput={act.onDraft} onSubmit={act.onAdd} />
      <Button key="add-focus" hotkey="a" plain dimColor onPress={act.onAddFocus}>add</Button>
    </Box>
  )
}

/** One pressable row: glyph, text and the `·you` badge on the person's rows and adopted Claude rows. */
export function itemButton(els: Els, item: Item, badged: boolean, width: number, act: Actions, prefix = '') {
  const { Button, Text } = els
  const status = M.effectiveStatus(item)
  const overridden = item.userStatus !== undefined
  const mark = `${M.glyph(status)}${overridden ? '*' : ''}`
  const you = item.owner === 'you' || badged
  const room = width - prefix.length - mark.length - 1 - (you ? BADGE.length : 0)
  const text = M.truncate(item.text, Math.max(4, room))
  return (
    <Button key={`item:${item.id}`} plain onPress={() => act.onToggle(item.id)}>
      <Text {...rowColor(status, overridden)}>{`${prefix}${mark} ${text}`}</Text>
      {you ? <Text dimColor>{BADGE}</Text> : ''}
    </Button>
  )
}

export function compactBody(els: Els, m: PaneModel, act: Actions) {
  const { Box, Text } = els
  const rows = M.display(m.claude, m.yours)
  const badged = M.badges(m.yours)
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? <Text dimColor>No items yet.</Text> : ''}
      {rows.map(item => itemButton(els, item, badged.has(item.id), m.columns, act))}
    </Box>
  )
}

export function renderPane(els: Els, m: PaneModel, act: Actions) {
  const { Box } = els
  return (
    <Box flexDirection="column" paddingX={1}>
      {header(els, m, act)}
      {compactBody(els, m, act)}
      {addRow(els, m, act)}
    </Box>
  )
}
```

- [ ] **Step 4: Rewrite register.tsx with the atoms, the mirror hooks and the pane**

`plugins/todo-pane/hooks/register.tsx` (whole file):

```tsx
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { Change, Item, View } from '../types'
import * as M from './model'
import { renderPane } from './views'

export const PANE = 'todo'

// Session values, held by the host so a hot reload loses nothing.
const claude = atom({ plugin: 'todo-pane', key: 'claude' } as const, [] as Item[])
const yours = atom({ plugin: 'todo-pane', key: 'yours' } as const, [] as Item[])
const pendingSync = atom({ plugin: 'todo-pane', key: 'pendingSync' } as const, [] as Change[])
const deliveredAt = atom({ plugin: 'todo-pane', key: 'deliveredAt' } as const, 0)
const view = atom({ plugin: 'todo-pane', key: 'view' } as const, 'compact' as View)
const doneCollapsed = atom({ plugin: 'todo-pane', key: 'doneCollapsed' } as const, true)
const draft = atom({ plugin: 'todo-pane', key: 'draft' } as const, '')
const root = atom({ plugin: 'todo-pane', key: 'root' } as const, '')

type Dollar = EngineInterface

const projectKey = (r: string) => `project:${r}`
const openKey = (r: string) => `open:${r}`

const isItems = (x: unknown): x is Item[] =>
  Array.isArray(x) && x.every(i => i && typeof i === 'object' && typeof (i as Item).id === 'string' && typeof (i as Item).text === 'string')

async function loadYours($: Dollar, r: string): Promise<Item[]> {
  const stored = (await $.store.get(projectKey(r))) as { items?: unknown } | undefined
  return isItems(stored?.items) ? stored.items : []
}

async function saveYours($: Dollar, items: readonly Item[]) {
  await $.store.set(projectKey(await read($, root)), { items })
}

/** Writes the Claude mirror and re-runs adoption over the person's rows. */
async function setClaude($: Dollar, change: (prev: Item[]) => Item[]) {
  const next = await update($, claude, change)
  await update($, yours, y => M.adopt(y, next))
}

function logError($: Dollar, where: string, err: unknown) {
  $.ui.log(`todo-pane: ${where}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: 'todo',
        description: 'Open the to-do pane; /todo add <text> | rm <n> | view compact|detailed|grouped | clear | close',
      })
      const r = await $.session.root()
      await update($, root, () => r)
      const stored = await loadYours($, r)
      const storedView = await $.store.get('view')
      if (M.isView(storedView)) await update($, view, () => storedView)
      const now = await $.clock.now()
      const replayed = M.replayTranscript(await $.session.messages(), now)
      await update($, claude, () => replayed)
      await update($, yours, () => M.adopt(stored, replayed))
      if (await $.store.get(openKey(r))) {
        const panes = await $.ui.panes()
        if (!panes.some(p => p.id === PANE)) void $.ui.open({ id: PANE, title: 'Todo' })
      }
    } catch (err) {
      logError($, 'session.start', err)
    }
    return result
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const delivered = await read($, deliveredAt)
      const res = ran.result as { newTodos?: M.TodoRow[] } | undefined
      const rows = res?.newTodos ?? e.todos
      await setClaude($, prev => M.mergeTodoWrite(prev, rows, now, delivered))
    } catch (err) {
      logError($, 'TodoWrite', err)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const res = ran.result as { task?: { id: string; subject: string } } | undefined
      if (res?.task) {
        const task = res.task
        await setClaude($, prev => M.applyTaskCreate(prev, { id: task.id, subject: task.subject, ...(e.activeForm ? { activeForm: e.activeForm } : {}) }, now))
      }
    } catch (err) {
      logError($, 'TaskCreate', err)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const delivered = await read($, deliveredAt)
      await setClaude($, prev => M.applyTaskUpdate(prev, {
        taskId: e.taskId,
        ...(e.subject !== undefined ? { subject: e.subject } : {}),
        ...(e.activeForm !== undefined ? { activeForm: e.activeForm } : {}),
        ...(e.status !== undefined ? { status: e.status } : {}),
      }, now, delivered))
    } catch (err) {
      logError($, 'TaskUpdate', err)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const delivered = await read($, deliveredAt)
      const res = ran.result as { tasks?: M.TaskListed[] } | undefined
      if (res?.tasks) {
        const tasks = res.tasks
        await setClaude($, prev => M.applyTaskList(prev, tasks, now, delivered))
      }
    } catch (err) {
      logError($, 'TaskList', err)
    }
    return ran
  })

  on('command.run', { command: 'todo' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Todo', focus: true })
    await $.store.set(openKey(await read($, root)), true)
    return {
      text: opened.isPlaced
        ? 'Todo pane opened.'
        : 'Todo: widen the terminal to 110 columns or more, then run /todo again.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    if (!('Input' in table)) {
      const { Text } = table
      return <Text dimColor>The Todo pane needs a surface with a text field.</Text>
    }
    const [c, y, v, collapsed, d] = await Promise.all([
      read($, claude), read($, yours), read($, view), read($, doneCollapsed), read($, draft),
    ])
    const now = await $.clock.now()
    return renderPane(table, { claude: c, yours: y, view: v, doneCollapsed: collapsed, draft: d, now, columns: e.props.bodyColumns }, {
      onToggle: () => {},
      onView: () => {},
      onAddFocus: () => {},
      onDraft: () => {},
      onAdd: () => {},
      onRemove: () => {},
      onToggleDone: () => {},
    })
  })
}
```

The seven no-op handlers are filled in by Task 6; this task only mirrors and draws.

- [ ] **Step 5: Validate, type-check, run the tests**

Run: `cd ~/src/ClaudeSkills && claude plugin validate plugins/todo-pane`
Expected: `Validation passed`; the `hooks:` line lists `session.start, tool.call{tool=TodoWrite}, tool.call{tool=TaskCreate}, tool.call{tool=TaskUpdate}, tool.call{tool=TaskList}, command.run{command=todo}, ui.render{component=Pane,requestId=todo}`; `state reads/writes` list the eight `todo-pane.*` keys.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output. If `ran.deny` or `ran.isError` is reported as not existing on the union, read the `ToolCallResult` type in `.claude-plugin/types/claude-code/index.d.ts` and use `'deny' in ran` instead.

Run: `claude plugin test plugins/todo-pane`
Expected: `26 pass`, `0 fail`. If a `Text` assertion fails while the Button with the expected key is found, print `JSON.stringify(await ui.drawn(), null, 1)` once to see how the kit reports the row's text and adjust that one regex.

- [ ] **Step 6: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/register.tsx plugins/todo-pane/hooks/views.tsx plugins/todo-pane/tests/todo-pane.test.ts
git commit -m "Mirror TodoWrite and Task calls into the todo-pane and draw the compact view" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 6: Interaction — toggle, add, draft, and the sync note on prompt.submit

**Files:**
- Modify: `plugins/todo-pane/hooks/register.tsx`
- Modify: `plugins/todo-pane/tests/todo-pane.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/todo-pane.test.ts`:

```ts
const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)

describe('interaction and sync', () => {
  test('pressing a Claude row sets an override that the next prompt carries, then clears', async ($, on) => {
    const captured: { context?: readonly string[] } = {}
    world(on, { captured })
    await start($)
    const ui = await mountPane($)
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('Write tests for X', 'in_progress')] } as any)

    await ui.press({ key: rowKey('Write tests for X') })
    expect(await ui.find({ type: 'Text', text: /^✓\* Write tests for X$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/1 done · 0 running/ })).toBeDefined()

    await submit($, 'go on')
    expect(captured.context).toHaveLength(1)
    expect(captured.context![0]).toContain('[todo pane] The user edited the shared to-do pane since your last turn:')
    expect(captured.context![0]).toContain('- ticked as completed: "Write tests for X" (your item)')

    captured.context = undefined
    await submit($, 'and again')
    expect(captured.context).toBeUndefined()

    // Claude writes the row after delivery: the override clears whatever it chose.
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't2', todos: [todo('Write tests for X', 'in_progress')] } as any)
    expect(await ui.find({ type: 'Text', text: /^▶ Write tests for X$/ })).toBeDefined()
    await ui.unmount()
  })

  test('typing into the add field adds a your-row, clears the draft, and ticking it is reported', async ($, on) => {
    const captured: { context?: readonly string[] } = {}
    world(on, { captured })
    await start($)
    const ui = await mountPane($)

    await ui.input({ key: 'add', text: 'Update CHANGELOG', kind: 'change' })
    expect((await ui.find({ type: 'Input', key: 'add' }))?.props.value).toBe('Update CHANGELOG')
    await ui.input({ key: 'add', text: 'Update CHANGELOG' })
    expect((await ui.find({ type: 'Input', key: 'add' }))?.props.value).toBe('')
    expect(await ui.find({ type: 'Text', text: /^○ Update CHANGELOG$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /·you/ })).toBeDefined()

    await ui.press({ key: await yourRowKey(ui) })
    expect(await ui.find({ type: 'Text', text: /^✓ Update CHANGELOG$/ })).toBeDefined()

    await submit($, 'next')
    expect(captured.context![0]).toContain('- added: "Update CHANGELOG" (user item, pending)')
    expect(captured.context![0]).toContain('- ticked as completed: "Update CHANGELOG" (user item)')

    await ui.unmount()

    // Persisted under the project key: a new session in the same project restores it, ticked.
    await start($)
    const again = await mountPane($)
    expect(await again.find({ type: 'Text', text: /^✓ Update CHANGELOG$/ })).toBeDefined()
    await again.unmount()
  })

  test('a Claude row with the same text adopts the your-row and draws once with a badge', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($)
    await ui.input({ key: 'add', text: 'Ship it' })
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('Ship it!', 'in_progress')] } as any)
    expect(await ui.findAll({ type: 'Text', text: /Ship it/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Button', key: rowKey('Ship it!') })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /·you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0\/1 done · 1 running/ })).toBeDefined()
    await ui.unmount()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: the three `interaction and sync` tests FAIL (presses and inputs do nothing yet).

- [ ] **Step 3: Add the edit helpers and the prompt.submit hook, wire the handlers**

In `plugins/todo-pane/hooks/register.tsx`, add these helpers after `logError`:

```tsx
function mintId(now: number): string {
  return `u:${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`
}

async function record($: Dollar, change: Change) {
  await update($, pendingSync, list => [...list, change])
}

async function toggle($: Dollar, id: string) {
  try {
    const now = await $.clock.now()
    if (id.startsWith('u:')) {
      const edit = M.toggleYours(await read($, yours), id, now)
      if (!edit) return
      await update($, yours, () => edit.yours)
      await saveYours($, edit.yours)
      await record($, edit.change)
      return
    }
    const edit = M.toggleClaude(await read($, claude), id, now)
    if (!edit) return
    await update($, claude, () => edit.claude)
    await record($, edit.change)
  } catch (err) {
    logError($, 'toggle', err)
  }
}

/** Adds one of the person's rows; returns the stored text, or null when nothing was added. */
async function addItem($: Dollar, text: string): Promise<string | null> {
  try {
    const now = await $.clock.now()
    const edit = M.addYours(await read($, yours), text, now, mintId(now))
    await update($, draft, () => '')
    if (!edit) return null
    const adopted = M.adopt(edit.yours, await read($, claude))
    await update($, yours, () => adopted)
    await saveYours($, adopted)
    await record($, edit.change)
    return edit.change.text
  } catch (err) {
    logError($, 'add', err)
    return null
  }
}

async function removeItem($: Dollar, id: string): Promise<string | null> {
  try {
    const now = await $.clock.now()
    const edit = M.removeYours(await read($, yours), id, now)
    if (!edit) return null
    await update($, yours, () => edit.yours)
    await saveYours($, edit.yours)
    await record($, edit.change)
    return edit.change.text
  } catch (err) {
    logError($, 'remove', err)
    return null
  }
}

async function setView($: Dollar, v: View) {
  await update($, view, () => v)
  await $.store.set('view', v)
}
```

Add the `prompt.submit` hook inside `register`, after the `tool.call` hooks:

```tsx
  on('prompt.submit', async ($, e, next) => {
    const pending = await read($, pendingSync)
    if (pending.length === 0) return next(e)
    const at = await $.clock.now()
    const note = M.syncNote(pending)
    const result = await next({ ...e, context: [...(e.context ?? []), note] })
    if (result.drop === undefined) {
      await update($, pendingSync, list => list.filter(c => c.at > at))
      await update($, deliveredAt, () => at)
    }
    return result
  })
```

Replace the seven no-op handlers in the `ui.render` hook with:

```tsx
    return renderPane(table, { claude: c, yours: y, view: v, doneCollapsed: collapsed, draft: d, now, columns: e.props.bodyColumns }, {
      onToggle: id => void toggle($, id),
      onView: () => void read($, view).then(cur => setView($, M.nextView(cur))),
      onAddFocus: () => void $.ui.focus({ requestId: PANE, key: 'add' }),
      onDraft: text => void update($, draft, () => text),
      onAdd: text => void addItem($, text),
      onRemove: id => void removeItem($, id),
      onToggleDone: () => void update($, doneCollapsed, b => !b),
    })
```

- [ ] **Step 4: Validate, type-check, run the tests**

Run: `cd ~/src/ClaudeSkills && claude plugin validate plugins/todo-pane`
Expected: `Validation passed`, `hooks:` now also lists `prompt.submit`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

Run: `claude plugin test plugins/todo-pane`
Expected: `29 pass`, `0 fail`. The mocked clock does not move between the press and the submit, so `c.at > at` is false for the recorded change and the pending list empties; the test's second submit confirms it.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/register.tsx plugins/todo-pane/tests/todo-pane.test.ts
git commit -m "Make the todo-pane interactive and hand the person's edits to Claude on the next prompt" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---
### Task 7: The `/todo` command in full, and the close hook

**Files:**
- Modify: `plugins/todo-pane/hooks/register.tsx` (replace the `command.run` hook; add `ui.close`)
- Modify: `plugins/todo-pane/tests/todo-pane.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/todo-pane.test.ts`:

```ts
const run = ($: any, args: string) =>
  $.command.run({ command: 'todo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)

describe('/todo command', () => {
  test('open, add, rm, clear, close and usage', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($)
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('Claude row')] } as any)

    expect((await run($, '')).text).toBe('Todo pane opened.')
    expect((await run($, 'add Mine A')).text).toBe('Added: Mine A')
    expect((await run($, 'add   ')).text).toBe(M.USAGE)
    expect((await run($, 'add Mine B')).text).toBe('Added: Mine B')
    expect(await ui.find({ type: 'Text', text: /^○ Mine B$/ })).toBeDefined()

    expect((await run($, 'rm 1')).text).toBe("That is Claude's item — tick it in the pane instead.")
    expect((await run($, 'rm 9')).text).toBe('No item 9.')
    expect((await run($, 'rm 2')).text).toBe('Removed: Mine A')
    expect(await ui.find({ type: 'Text', text: /Mine A/ })).toBeUndefined()

    await ui.press({ key: await yourRowKey(ui) })
    expect(await ui.find({ type: 'Text', text: /^✓ Mine B$/ })).toBeDefined()
    expect((await run($, 'clear')).text).toBe('Cleared 1 done items.')
    expect(await ui.find({ type: 'Text', text: /Mine B/ })).toBeUndefined()

    expect((await run($, 'close')).text).toBe('Todo pane closed.')
    expect((await run($, 'dance')).text).toBe(M.USAGE)
    await ui.unmount()
  })

  test('view switches by command and persists; the pane reopens next session when left open', async ($, on) => {
    const opened = { count: 0 }
    world(on, { opened })
    await start($)
    expect((await run($, 'view grouped')).text).toBe('View: grouped')
    expect((await run($, 'view sideways')).text).toBe(M.USAGE)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', key: 'view', text: /grouped/ })).toBeDefined()
    await ui.unmount()

    await run($, '')             // sets open:/work in the store
    expect(opened.count).toBe(1)
    await start($)               // a new session start in the same project reopens the pane
    expect(opened.count).toBe(2)
    await run($, 'close')        // clears the flag
    await start($)
    expect(opened.count).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: the two `/todo command` tests FAIL (`add Mine A` is answered with `Todo pane opened.`).

- [ ] **Step 3: Replace the command hook and add the close hook**

In `plugins/todo-pane/hooks/register.tsx`, replace the `command.run` hook with:

```tsx
  on('command.run', { command: 'todo' }, async ($, e) => {
    const cmd = M.parseCommand(e.args)
    const r = await read($, root)
    switch (cmd.kind) {
      case 'open': {
        const opened = await $.ui.open({ id: PANE, title: 'Todo', focus: true })
        await $.store.set(openKey(r), true)
        return {
          text: opened.isPlaced
            ? 'Todo pane opened.'
            : 'Todo: widen the terminal to 110 columns or more, then run /todo again.',
        }
      }
      case 'view': {
        await setView($, cmd.view)
        return { text: `View: ${cmd.view}` }
      }
      case 'add': {
        const added = await addItem($, cmd.text)
        return { text: added === null ? M.USAGE : `Added: ${added}` }
      }
      case 'rm': {
        const rows = M.display(await read($, claude), await read($, yours))
        const row = rows[cmd.n - 1]
        if (!row) return { text: `No item ${cmd.n}.` }
        if (row.owner === 'claude') return { text: "That is Claude's item — tick it in the pane instead." }
        const removed = await removeItem($, row.id)
        return { text: removed === null ? `No item ${cmd.n}.` : `Removed: ${removed}` }
      }
      case 'clear': {
        const now = await $.clock.now()
        const cleared = M.clearDone(await read($, yours), now)
        await update($, yours, () => cleared.yours)
        await saveYours($, cleared.yours)
        for (const c of cleared.changes) await record($, c)
        return { text: `Cleared ${cleared.changes.length} done items.` }
      }
      case 'close': {
        await $.ui.close({ id: PANE })
        await $.store.delete(openKey(r))
        return { text: 'Todo pane closed.' }
      }
      default:
        return { text: M.USAGE }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      try {
        await $.store.delete(openKey(await read($, root)))
      } catch (err) {
        logError($, 'ui.close', err)
      }
    }
    return next(e)
  })
```

`parseCommand` already answers `usage` for `add` followed by nothing but spaces, so `addItem` returning null (whitespace-only text) is a second guard that reads the same way.

- [ ] **Step 4: Validate, type-check, run the tests**

Run: `cd ~/src/ClaudeSkills && claude plugin validate plugins/todo-pane`
Expected: `Validation passed`; `hooks:` lists `ui.close{id=todo}` too.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output.

Run: `claude plugin test plugins/todo-pane`
Expected: `31 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/register.tsx plugins/todo-pane/tests/todo-pane.test.ts
git commit -m "Give /todo its add, rm, view, clear and close forms" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 8: Detailed and grouped views, the view hotkey, the Done collapse

**Files:**
- Modify: `plugins/todo-pane/hooks/views.tsx`
- Modify: `plugins/todo-pane/tests/todo-pane.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `plugins/todo-pane/tests/todo-pane.test.ts`:

```ts
describe('views', () => {
  test('the view button cycles compact → detailed → grouped and persists', async ($, on) => {
    world(on)
    await start($)
    const ui = await mountPane($)
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('Explore', 'completed'), todo('Propose', 'in_progress', 'Proposing approaches'), todo('Write doc')] } as any)
    await ui.input({ key: 'add', text: 'Ping Addy' })

    expect(await ui.find({ type: 'Button', key: 'view', text: /compact/ })).toBeDefined()

    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Button', key: 'view', text: /detailed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 ✓ Explore$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /claude · Proposing approaches/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /claude · done just now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /you · added just now/ })).toBeDefined()
    const rm = await ui.findAll({ type: 'Button', text: /^×$/ })
    expect(rm).toHaveLength(1)
    expect(rm[0]!.key!.startsWith('rm:u:')).toBe(true)

    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Button', key: 'view', text: /grouped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /IN PROGRESS \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PENDING \(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DONE \(1\)/ })).toBeDefined()

    await ui.unmount()

    // The view persists across sessions.
    await start($)
    const again = await mountPane($)
    expect(await again.find({ type: 'Button', key: 'view', text: /grouped/ })).toBeDefined()
    await again.press({ key: 'view' })
    expect(await again.find({ type: 'Button', key: 'view', text: /compact/ })).toBeDefined()
    await again.unmount()
  })

  test('the × button removes a your-row in detailed view', async ($, on) => {
    world(on, { store: { view: 'detailed' } })
    await start($)
    const ui = await mountPane($)
    await ui.input({ key: 'add', text: 'Temporary' })
    const rm = await ui.find({ type: 'Button', text: /^×$/ })
    await ui.press({ key: rm!.key! })
    expect(await ui.find({ type: 'Text', text: /Temporary/ })).toBeUndefined()
    await ui.unmount()
  })

  test('grouped view collapses Done past three items and the d button expands it', async ($, on) => {
    world(on, { store: { view: 'grouped' } })
    await start($)
    const ui = await mountPane($)
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: [todo('A', 'completed'), todo('B', 'completed'), todo('C', 'completed'), todo('D', 'completed'), todo('E')] } as any)
    expect(await ui.find({ type: 'Text', text: /DONE \(4\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^collapsed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  ✓ A$/ })).toBeUndefined()
    await ui.press({ key: 'done-toggle' })
    expect(await ui.find({ type: 'Text', text: /^  ✓ A$/ })).toBeDefined()
    await ui.press({ key: 'done-toggle' })
    expect(await ui.find({ type: 'Text', text: /^  ✓ A$/ })).toBeUndefined()
    await ui.unmount()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/src/ClaudeSkills && claude plugin test plugins/todo-pane`
Expected: the three `views` tests FAIL (the pane always draws the compact body).

- [ ] **Step 3: Add the detailed and grouped bodies and switch on the view**

In `plugins/todo-pane/hooks/views.tsx`, add after `compactBody`:

```tsx
function detailLine(item: Item, badged: boolean, now: number): string {
  const owner = item.owner === 'you' || badged ? 'you' : 'claude'
  const status = M.effectiveStatus(item)
  if (item.userStatus !== undefined) return `${owner} · ticked ${M.age(now, item.overrideAt ?? item.updatedAt)}, not yet seen`
  if (status === 'in_progress' && item.activeForm) return `${owner} · ${item.activeForm}`
  if (status === 'completed') return `${owner} · done ${M.age(now, item.updatedAt)}`
  return `${owner} · added ${M.age(now, item.createdAt)}`
}

export function detailedBody(els: Els, m: PaneModel, act: Actions) {
  const { Box, Text, Button } = els
  const rows = M.display(m.claude, m.yours)
  const badged = M.badges(m.yours)
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? <Text dimColor>No items yet.</Text> : ''}
      {rows.map((item, n) => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            {itemButton(els, item, badged.has(item.id), m.columns - 4, act, `${n + 1} `)}
            {item.owner === 'you' ? <Button key={`rm:${item.id}`} plain dimColor onPress={() => act.onRemove(item.id)}>×</Button> : ''}
          </Box>
          <Text dimColor>{`    ${detailLine(item, badged.has(item.id), m.now)}`}</Text>
        </Box>
      ))}
    </Box>
  )
}

const DONE_COLLAPSE_OVER = 3

export function groupedBody(els: Els, m: PaneModel, act: Actions) {
  const { Box, Text, Button } = els
  const rows = M.display(m.claude, m.yours)
  const badged = M.badges(m.yours)
  const by = (s: M.Status) => rows.filter(r => M.effectiveStatus(r) === s)
  const running = by('in_progress')
  const pending = by('pending')
  const done = by('completed')
  const collapsed = m.doneCollapsed && done.length > DONE_COLLAPSE_OVER
  const section = (status: M.Status, title: string, items: Item[], color: string) => (
    <Box flexDirection="column">
      <Text bold color={color}>{`${M.glyph(status)} ${title} (${items.length})`}</Text>
      {items.map(item => itemButton(els, item, badged.has(item.id), m.columns - 2, act, '  '))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? <Text dimColor>No items yet.</Text> : ''}
      {section('in_progress', 'IN PROGRESS', running, 'claude')}
      {section('pending', 'PENDING', pending, 'text')}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="success">{`✓ DONE (${done.length})`}</Text>
        {done.length > DONE_COLLAPSE_OVER
          ? <Button key="done-toggle" hotkey="d" plain dimColor onPress={act.onToggleDone}>{collapsed ? 'expand' : 'collapse'}</Button>
          : ''}
      </Box>
      {collapsed
        ? <Text dimColor>collapsed</Text>
        : done.map(item => itemButton(els, item, badged.has(item.id), m.columns - 2, act, '  '))}
    </Box>
  )
}
```

Replace `renderPane` with:

```tsx
export function renderPane(els: Els, m: PaneModel, act: Actions) {
  const { Box } = els
  const body = m.view === 'detailed' ? detailedBody(els, m, act) : m.view === 'grouped' ? groupedBody(els, m, act) : compactBody(els, m, act)
  return (
    <Box flexDirection="column" paddingX={1}>
      {header(els, m, act)}
      {body}
      {addRow(els, m, act)}
    </Box>
  )
}
```

`itemButton` from Task 5 already takes a `prefix`, so the detailed view's row number and the grouped view's two-space indent need no new element code.

- [ ] **Step 4: Validate, type-check, run the tests**

Run: `cd ~/src/ClaudeSkills && claude plugin validate plugins/todo-pane`
Expected: `Validation passed`.

Run: `~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane`
Expected: no output. (`color` is typed `Color`, which admits any string, so `'text'` passes.)

Run: `claude plugin test plugins/todo-pane`
Expected: `34 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/hooks/views.tsx plugins/todo-pane/tests/todo-pane.test.ts
git commit -m "Add the detailed and grouped views to the todo-pane" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

---

### Task 9: README, marketplace entry, spec sync, manual smoke test

**Files:**
- Create: `plugins/todo-pane/README.md`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/todo-pane/DESIGN.md` (one line in §3)

- [ ] **Step 1: Write the README**

`plugins/todo-pane/README.md`:

````markdown
# todo-pane

An interactive to-do pane for Claude Code. It mirrors the list Claude keeps with its
TodoWrite and Task tools, lets you add, tick, untick and delete your own items, and
tells Claude about your edits on your next prompt. One list, three views.

## Install

```
/plugin marketplace add Cybeaster/ClaudeSkills
/plugin install todo-pane@claude-skills
/reload-plugins
```

Requires Claude Code 2.1.287 or later. The pane docks beside the transcript in the
fullscreen layout from 110 columns; narrower terminals get a hint instead.

## Use

| Do | How |
| --- | --- |
| Open or focus the pane | `/todo` |
| Switch view | `v` while the pane has focus, or `/todo view compact\|detailed\|grouped` |
| Tick or untick a row | Tab or arrows to the row, Enter; or click it |
| Add an item | `a` to jump to the field, type, Enter; or `/todo add <text>` |
| Delete one of your items | `×` beside it in detailed view, or `/todo rm <n>` |
| Collapse or expand Done (grouped view) | `d` |
| Remove your completed items | `/todo clear` |
| Close | `/todo close`, or the pane's close mark |

Rows with `·you` are yours. `✓*` marks a tick you made that Claude has not yet seen;
it is handed to Claude as hidden context with your next prompt and clears once
Claude writes the row again. Your items are saved per project and come back next
session.

## Development

```
claude plugin validate plugins/todo-pane
claude plugin test plugins/todo-pane
tsc -p plugins/todo-pane                 # after the engine has written .claude-plugin/types/
claude --plugin-dir plugins/todo-pane    # a session with the mod loaded and hot-reloading
```

Design: `DESIGN.md`. Plan: `PLAN.md`.
````

- [ ] **Step 2: Add the marketplace entry**

In `.claude-plugin/marketplace.json`, add to `plugins`:

```json
{
  "name": "todo-pane",
  "source": "./plugins/todo-pane",
  "description": "An interactive to-do pane: Claude's list mirrored live plus your own items, in compact, detailed or grouped view."
}
```

Run: `cd ~/src/ClaudeSkills && jq . .claude-plugin/marketplace.json > /dev/null && claude plugin validate . && echo marketplace-ok`
Expected: `marketplace-ok` after the validator's report.

- [ ] **Step 3: Sync the spec with the one field the implementation added**

In `plugins/todo-pane/DESIGN.md` §3, the `Item` type gains one line after `userStatus?: Status`:

```ts
  overrideAt?: number   // when userStatus was set; compared with the delivery time (§4.3)
```

- [ ] **Step 4: Full gate**

```bash
cd ~/src/ClaudeSkills
claude plugin validate plugins/todo-pane
~/src/ItAbyss/webapp/node_modules/.bin/tsc -p plugins/todo-pane
claude plugin test plugins/todo-pane
```

Expected: `Validation passed`; no tsc output; `34 pass`, `0 fail`.

- [ ] **Step 5: Manual smoke test in a real session**

Run, from a terminal at least 120 columns wide: `cd ~/src/ClaudeSkills && claude --plugin-dir plugins/todo-pane`

Then, in that session:
1. `/plugin` → the dim line under the tabs reads `1 mod active · todo-pane`.
2. `/todo` → the pane docks on the right with `0/0 done · 0 running`, `v: compact`, and the add field.
3. Ask Claude: "Make a 3-item todo list for renaming a function, and start the first item." → the pane shows three rows, one `▶`.
4. Tab to a `○` row, Enter → it becomes `✓*` in yellow. Press `a`, type `Check the changelog`, Enter → a `·you` row appears.
5. Send "continue" → Claude's reply acknowledges the tick and the new item, and its next TodoWrite clears the `*`.
6. Press `v` twice → detailed, then grouped. `/todo view compact`.
7. `/todo close`, then exit and start `claude --plugin-dir plugins/todo-pane` again → the pane does not auto-open; `/todo` shows `Check the changelog` restored from the store.

If any step differs, run `claude --debug --plugin-dir plugins/todo-pane` and look for lines starting with `todo-pane:` in the debug log.

- [ ] **Step 6: Commit**

```bash
cd ~/src/ClaudeSkills
git add plugins/todo-pane/README.md plugins/todo-pane/DESIGN.md .claude-plugin/marketplace.json
git commit -m "Publish todo-pane in the marketplace with a README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K3JFY9qqKsGMidGBovdqGB"
```

Do not push; the owner pushes when ready.

---

## Spec coverage check

| DESIGN.md section | Task |
| --- | --- |
| §3 data model, ids | Task 0 (contract), Task 1 (ids) |
| §4.1 Claude → pane, all four tools, subagents ignored | Tasks 1, 2, 5 |
| §4.2 pane → Claude on prompt.submit, clear only without drop | Task 6 |
| §4.3 overrides and their clearing | Tasks 1, 3, 6 |
| §4.4 adoption | Tasks 3, 6 |
| §5 state atoms, store keys, transcript replay on start | Tasks 4, 5, 6, 7 |
| §6.1–6.4 header and the three views | Tasks 5, 8 |
| §6.5 controls: row buttons, v, a, add field, ×, d | Tasks 5, 6, 8 |
| §7 `/todo` forms | Tasks 5, 7 |
| §8 lifecycle: start/resume, hot reload (atoms), narrow terminal hint, auto-reopen | Tasks 5, 7 |
| §9 error handling: next-first observers, try/catch, clipping, render never writes | Tasks 3, 5, 6 |
| §10 tests | every task |
| §11 files and distribution | Tasks 0, 9 |
