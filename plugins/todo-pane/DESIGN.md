# todo-pane — an interactive to-do pane for Claude Code

- **Date:** 2026-10-10
- **Status:** design approved in brainstorm; implementation plan pending
- **Target:** Claude Code 2.1.296 (mods API as written in its `claude-code.d.ts`); terminal and Desktop surfaces
- **Home:** `plugins/todo-pane/` in the `claude-skills` marketplace (this repo)

## 1. Goal and scope

A mod that draws a pane beside the transcript holding one to-do list with two owners: the items Claude tracks with its own TodoWrite / Task tools, mirrored live, and items the person adds by hand. The person can add, tick, untick and delete items from the pane and from a `/todo` command. The person's edits are handed to Claude as hidden context on their next prompt. The pane draws the same list in three **view modes**: compact, detailed, grouped.

The modes change only how the list is drawn. Claude's behaviour is untouched: the mod never rewrites a TodoWrite or Task call, never rewrites Claude's own `todo_reminder` attachment, never adds a tool to the model's prompt, and never changes the system prompt.

Out of scope for this version (see §12): a band above the prompt for narrow terminals, mid-turn delivery of edits, a model-callable tool.

## 2. Decisions taken in the brainstorm

| Question | Decision |
| --- | --- |
| Where the list lives | Inside the Claude Code session, as a mod (pane + slash command) |
| What "modes" means | View modes only: compact / detailed / grouped |
| Where items come from | Claude's TodoWrite and Task tool calls, plus the person's own items; the person's edits are fed back to Claude |
| Persistence of the person's items | Per project (keyed by session root), across sessions |
| Approach | A: one pane, three views, one `/todo` command. Not B (band fallback), not C (model tool) |
| Mirror both tool families | Yes: TodoWrite and TaskCreate / TaskUpdate / TaskList, since this build offers both and Claude may use either |

## 3. Data model

```ts
type Owner  = 'claude' | 'you'
type Status = 'pending' | 'in_progress' | 'completed'

type Item = {
  id: string            // 'tw:<hash>' TodoWrite row, 'task:<taskId>' Task tool row, 'u:<ulid>' the person's
  owner: Owner
  text: string          // TodoWrite content / Task subject / what the person typed (clipped to 500 chars)
  activeForm?: string   // Claude's present-continuous form, drawn while in_progress
  status: Status        // what the owner last said
  userStatus?: Status   // the person's tick/untick on a Claude row, until Claude has had its say (§4.3)
  adoptedBy?: string    // on a 'you' row: the id of the Claude row with the same folded text (§4.4)
  createdAt: number     // $.clock.now() ms
  updatedAt: number
}

type Change =
  | { kind: 'added';    text: string; at: number }
  | { kind: 'ticked';   text: string; owner: Owner; at: number }
  | { kind: 'unticked'; text: string; owner: Owner; at: number }
  | { kind: 'deleted';  text: string; at: number }

type View = 'compact' | 'detailed' | 'grouped'
```

**Ids.** TodoWrite rows carry no id, so `tw:` + FNV-1a of the folded text (§4.4) keys them; two rows with the same folded text get `#2`, `#3` suffixes in list order. This keeps overrides attached across reorders. Task rows use the engine's `taskId`. The person's rows get `u:<now>-<random>` (base-36 `$.clock.now()` and a `Math.random()` suffix), with no module counter that a hot reload would reset.

**Display order.** Claude rows in Claude's order, then the person's un-adopted rows in creation order. Row numbers (detailed view, `/todo rm`) follow this order.

## 4. Sync

### 4.1 Claude → pane

A `tool.call` hook on the main loop only (`e.agentId` absent) calls `next(e)` first, then observes the result inside try/catch so a bookkeeping error never blocks the tool.

| Tool | Effect on the Claude mirror |
| --- | --- |
| `TodoWrite` | Replace the mirror with `result.newTodos` (content, status, activeForm) |
| `TaskCreate` | Add `task:<result.task.id>` with the input's subject / description / activeForm, status pending |
| `TaskUpdate` | Patch that row's subject / activeForm / status; status `deleted` removes it |
| `TaskList` | Reconcile: rows in `result.tasks` are kept or added, Task rows absent are removed |

TodoWrite and Task rows coexist in one mirror; a session normally uses one family.

### 4.2 Pane → Claude

Every edit the person makes appends a `Change` to `pendingSync`. A `prompt.submit` hook attaches one block to the prompt's hidden `context` when `pendingSync` is non-empty:

```
[todo pane] The user edited the shared to-do pane since your last turn:
- ticked as completed: "Write tests for X" (your item)
- added: "Update CHANGELOG" (user item, pending)
- deleted: "Old idea" (user item)
Reflect ticks in your own list. Treat added user items as requested work unless the user says otherwise.
```

The hook rewrites `next({ ...e, context: [...(e.context ?? []), note] })`. `pendingSync` is cleared only once `next` resolves without `drop`; a dropped prompt keeps the changes for the next one. Nothing is sent mid-turn; a change made while a turn runs waits for the next prompt.

### 4.3 Overrides on Claude rows

Pressing a Claude row sets `userStatus` (completed if the row is not completed, otherwise pending). The row draws as `✓*` / `○*` in yellow. The override is cleared by the first Claude write that touches the row **after** the change was delivered (`Change.at` earlier than the delivery time), whatever status Claude chose, since Claude has then had its say. Claude writes before delivery leave the override in place. If Claude's new status already equals `userStatus`, it is cleared at once.

### 4.4 Adoption of the person's rows

Fold = lowercase, collapse whitespace, trim, strip one trailing `.`/`!`. When a Claude row's folded text equals a `you` row's folded text, the `you` row is marked `adoptedBy` and is not drawn; the Claude row draws with a dim `·you` badge and follows Claude's status. Pressing it toggles the override as in §4.3. Deleting it (`×` or `/todo rm`) removes the `you` row only; the Claude row stays, and the `deleted` change tells Claude.

## 5. State and persistence

**Session values** (`$.state`, declared in `types/index.d.ts` under `todo-pane`, read via `atom` / `read` / `update`): `claude: Item[]`, `pendingSync: Change[]`, `view: View`, `doneCollapsed: boolean`. These survive hot reload; module variables are not used for data.

**Store values** (`$.store`, JSON, across sessions):

| Key | Value |
| --- | --- |
| `project:<session root>` | `{ items: Item[] }` — the person's rows for that project, written on every change |
| `view` | the last chosen `View`, global |
| `open:<session root>` | `true` while the person has the pane open in that project |

The Claude mirror is never stored. On every `session.start` (startup and resume alike) it is rebuilt by replaying the transcript from `$.session.messages()`: the last TodoWrite tool use sets the list; TaskCreate / TaskUpdate / TaskList tool uses are replayed in order.

## 6. The pane

Id `todo`, title `Todo`. Drawn by one `ui.render` hook on `{ component: 'Pane', requestId: 'todo' }` using `$.ui.resolve(e)` elements (`Box`, `Text`, `Button`, `Input`). Width comes from `e.props.bodyColumns`; height from `e.viewport?.rows`. The pane docks beside the transcript in the fullscreen layout from 110 columns when opened by the person, and the engine seats it inline above the prompt elsewhere; the tree is the same.

### 6.1 Header (every view)

`<done>/<total> done · <n> running` on the left, the view name and the `[v]` button on the right. Counts exclude adopted `you` rows (they are the same item).

### 6.2 Compact (default)

One line per row: glyph, text truncated to the width, `·you` dim suffix on the person's rows.

```
┌ Todo ──────────────────────────────────┐
│ 3/7 done · 1 running      compact  [v] │
│ ✓ Explore project context              │
│ ✓ Ask clarifying questions             │
│ ▶ Propose 2-3 approaches               │
│ ○ Present design                       │
│ ○ Write design doc                     │
│ ✓* Update CHANGELOG              ·you  │
│ ○ Ping Addy about the band       ·you  │
│ + add item…                        [a] │
└────────────────────────────────────────┘
```

### 6.3 Detailed

Two lines per row: number, glyph, text (wrapped, not truncated); then owner and either `activeForm` (in progress), `done <age>`, `added <age>`, or `ticked <age>, not yet seen` for an undelivered override. The person's rows get a `[×]` delete button at the line end.

```
│ 3/7 done · 1 running     detailed  [v] │
│ 1 ✓ Explore project context            │
│     claude · done 12m ago              │
│ 3 ▶ Propose 2-3 approaches             │
│     claude · Proposing approaches…     │
│ 6 ✓* Update CHANGELOG              [×] │
│     you · ticked 1m ago, not yet seen  │
│ 7 ○ Ping Addy about the band       [×] │
│     you · added 4m ago                 │
│ + add item…                        [a] │
```

### 6.4 Grouped

Sections in fixed order: IN PROGRESS, PENDING, DONE. DONE collapses to its count when it holds more than three rows; `[d]` toggles it.

```
│ 3/7 done · 1 running      grouped  [v] │
│ ▶ IN PROGRESS (1)                      │
│   Propose 2-3 approaches               │
│ ○ PENDING (3)                          │
│   Present design                       │
│   Write design doc                     │
│   Ping Addy about the band       ·you  │
│ ✓ DONE (3)                         [d] │
│   collapsed                            │
│ + add item…                        [a] │
```

### 6.5 Controls

| Control | Element | Effect |
| --- | --- | --- |
| Item row | `Button key="item:<id>"` with the glyph and text as children | Enter or click toggles: `you` rows pending ↔ completed; Claude rows set the override (§4.3) |
| `[v]` | `Button hotkey="v"` | cycles compact → detailed → grouped; writes `view` to state and store |
| `[a]` | `Button hotkey="a"` | `$.ui.focus({ requestId: 'todo', key: 'add' })` |
| add field | `Input key="add" placeholder="add item…"` | Enter adds a `you` row, clears the field, appends an `added` change |
| `[×]` | `Button key="rm:<id>" dimColor` (detailed only, `you` rows) | removes the row, appends a `deleted` change |
| `[d]` | `Button hotkey="d"` (grouped only) | toggles `doneCollapsed` |
| Escape | engine | hands the keyboard back to the prompt |

Hotkeys act only while the pane holds focus, which `/todo`, a click or ctrl+x tab gives it (engine rule). Tab and the arrows walk the focus ring; while focused, the arrows at the ring's ends scroll the body (engine-owned scroll). The add field is the last element of the tree, so it scrolls with the list.

Glyphs are single-width: `○` pending, `▶` in progress, `✓` completed, `*` unconfirmed override, `×` delete, `·` badge separator. Colors: in-progress rows in the accent color, completed rows `dimColor`, overrides yellow, the person's badge dim. Item text is drawn only as `Text` children, never interpreted.

## 7. The `/todo` command

Registered in `session.start` with `$.command.register({ name: 'todo', description: 'Open the to-do pane; add, tick, remove items' })` and answered by a `command.run` hook on `{ command: 'todo' }` that parses `e.args`. Every answer is `{ text }` with no model turn, so it works while Claude is busy.

| Args | Does | Answer |
| --- | --- | --- |
| (none) | `$.ui.open({ id: 'todo', title: 'Todo', focus: true })`; sets `open:<root>` | `Todo pane opened.` or, when not placed, `Todo: widen the terminal to 110 columns or more.` |
| `view compact\|detailed\|grouped` | sets the view in state and store | `View: grouped` |
| `add <text>` | adds a `you` row | `Added: <text>` |
| `rm <n>` | removes the person's row numbered `n` in display order | `Removed: <text>`; for a Claude row: `That is Claude's item — tick it in the pane instead.`; out of range: `No item <n>.` |
| `clear` | removes the person's completed rows | `Cleared <k> done items.` |
| `close` | `$.ui.close({ id: 'todo' })`; clears `open:<root>` | `Todo pane closed.` |
| anything else | | one-line usage |

A `ui.close` hook with `e.origin === 'person'` also clears `open:<root>`.

## 8. Session lifecycle

- **Start / resume:** register the command; load `project:<root>` and `view`; rebuild the Claude mirror from the transcript (§5); if `open:<root>` is set, open the pane without focus. An unasked open is placed only from 144 columns (engine rule); when it is not placed the mod stays silent rather than toasting on every start.
- **Hot reload:** `register` and `session.start` run again; all data is in `$.state` or `$.store`, so nothing is lost. `$.ui.panes()` is consulted before opening so a reload does not re-open or re-focus.
- **Compaction:** no effect; the mirror lives in state.
- **Subagents:** tool calls with `e.agentId` are ignored; the pane shows the main loop's list even while an agent's transcript is in view.
- **Narrow terminal:** `$.ui.open` returns `isPlaced: false`; `/todo` answers with the widen hint; nothing else is drawn.
- **Desktop surface:** same tree; `Input` and `Button` exist there. No terminal-only element is used.

## 9. Error handling

- Observers (`tool.call`, `prompt.submit`) call `next(e)` first and wrap their own work in try/catch; an exception is logged with `$.ui.log` and the event proceeds unchanged.
- Store writes are awaited and failures logged; the session copy in state stays authoritative for the pane.
- Transcript replay tolerates missing or malformed tool uses (skip the entry).
- Text is clipped to 500 characters on add; empty or whitespace-only adds are ignored.
- The `ui.render` hook never writes state (engine refuses it); all writes happen in `onPress` / `onSubmit` / event hooks.

## 10. Testing

Gates for every change: `claude plugin validate plugins/todo-pane`, `tsc -p plugins/todo-pane`, `claude plugin test plugins/todo-pane`.

`hooks/model.ts` is pure (no `$`) and is unit-tested directly: TodoWrite snapshot merge with override retention; Task create / update / delete / list reconcile; adoption by folded text; the person's toggle, add, delete; override clearing before vs after delivery; display order and numbering; the sync note text.

Runtime scenarios with `claude-code/testing` (`describe` / `test($, on)`, `$.ui.mount` of the `Pane`):

1. A TodoWrite call fills the pane; header counts and glyphs match.
2. Pressing an item row toggles it; the next `prompt.submit` carries the `[todo pane]` note and `pendingSync` empties.
3. `/todo add foo` round-trips through the store; a fresh `session.start` with the same root restores it.
4. Pressing `[v]` cycles the view and persists it; `/todo view grouped` draws the three sections.
5. A `tool.call` with `agentId` leaves the mirror untouched.

## 11. Files and distribution

```
plugins/todo-pane/
  .claude-plugin/plugin.json       { name: "todo-pane", version, description, types: "./types/index.d.ts" }
  hooks/hooks.json                 { "modules": ["./register.tsx"] }
  hooks/register.tsx               hooks only: session.start, tool.call, prompt.submit, command.run, ui.close, ui.render
  hooks/model.ts                   Item / Change / View types, pure reducers, fold(), the sync note
  hooks/views.tsx                  header, the three views, the add row
  types/index.d.ts                 PluginState['todo-pane'] = { claude, pendingSync, view, doneCollapsed }
  tests/todo-pane.test.ts
  DESIGN.md                        this document
  README.md                        what it does, install line, hotkeys
```

Development happens in the session's hot-reload folder (`~/.claude/dev-mods/<session>/todo-pane/`) and the result is copied here. `.claude-plugin/marketplace.json` gains:

```json
{ "name": "todo-pane", "source": "./plugins/todo-pane", "description": "An interactive to-do pane: Claude's list mirrored live plus your own items, in compact, detailed or grouped view." }
```

Install: `/plugin install todo-pane@claude-skills`, then `/reload-plugins`.

## 12. Later, if wanted

- **Band fallback:** draw the compact header as an `AbovePrompt` band when the pane is not placed (approach B).
- **Mid-turn delivery:** `$.session.append` a user-role note the moment an edit is made, so a long autonomous turn sees ticks at once.
- **Model tool:** a registered tool that lets Claude read the person's rows directly (approach C). Changes Claude's behaviour; deliberately excluded now.

## 13. API facts this design relies on (build 2.1.296)

- Events: `session.start`, `tool.call` (result shapes `TodoWrite.newTodos`, `TaskCreate.task.id`, `TaskUpdate` input `status` incl. `deleted`, `TaskList.tasks`), `prompt.submit` (`context: string[]`, `turnId`, `origin`), `command.run` (`command`, `args`), `ui.close` (`origin: 'person' | 'plugin' | 'unload'`), `ui.render` for `Pane` (`e.props.bodyColumns`, `placement`, `isFocused`, `scroll`; `e.viewport.rows`).
- Methods: `$.command.register`, `$.ui.open` (`id`, `title`, `focus`, `rows`, `columns`; `isPlaced`), `$.ui.close`, `$.ui.panes`, `$.ui.focus`, `$.ui.toast`, `$.ui.log`, `$.ui.resolve`, `$.state.get/set` (refused during render), `$.store.get/set/delete`, `$.session.root/id/messages`, `$.clock.now`.
- Elements: `Box`, `Text` (`color`, `dimColor`, `bold`, `wrap`), `Button` (`key`, `hotkey` one digit or lowercase letter, `onPress`, `dimColor`, `plain`, `variant`), `Input` (`key`, `placeholder`, `value`, `onSubmit`, `onInput`, `autoFocus`).
- Rules: a pane opened by the person's command is placed from 110 columns, unasked from 144; hotkeys work only while the pane holds focus; `$.state` survives hot reload, module variables do not; `claude plugin validate` holds every `$.state` key to the types contract.
