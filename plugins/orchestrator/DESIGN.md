# orchestrator — one view over every local Claude Code session

- **Date:** 2026-10-14
- **Status:** design approved in brainstorm; implementation plan pending
- **Target:** Claude Code on Linux, sessions run in herdr panes or any other terminal
- **Home:** `plugins/orchestrator/` in the `claude-skills` marketplace (this repo)

## 1. Goal and scope

The person runs about ten Claude Code sessions at once and cannot hold each one's context in their head. Each session tracks its work only inside its own chat. The orchestrator gives every session a **task pool** kept outside the chat, and one TUI that lists every live session with its pool, its progress and whether it is waiting on the person.

Three things are needed:

1. Discover every Claude session running locally and list it, one entry per session.
2. Opening an entry shows the pool that session must complete, for example *Create a course → Run audit → Re-check CI*.
3. Each session writes its own pool and ticks a task only when it has actually done it, with evidence.

Sessions can spawn **child sessions** in other terminals (a parent `beginner-courses` spawns `course-python`, `course-javascript`, `course-go`). Children are nested under the parent task that spawned them, share a brief written by the parent, and their progress and open questions roll up to the parent.

The person often drives the machine from a phone through Remote Control (`claude rc`). The overview must work there too: `/orch` in any session shows every session as tap-through choices, and the person can answer a waiting session's question from it (§8).

Out of scope for v1 (see §10): pools derived from transcripts, a web view, resuming external sessions in herdr, free-form prompting of sessions (only answers to ⚑ are sent), cross-machine sessions.

## 2. What already exists on the machine

| Source | Gives | Role |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | `pid`, `sessionId`, `cwd`, `name`, `status` (`busy`, `idle`, `shell` = idle with a background shell, `waiting` + `waitingFor` while a permission prompt or dialog is open), `procStart` (to spot a recycled pid), `bridgeSessionId` (Remote Control, else `null`), `spare` (a pre-started process, not a session yet) for every running Claude process, herdr or not | Discovery |
| `herdr agent list` (JSON) | `pane_id`, `agent_status`, `terminal_title`, `agent_session.value` = `sessionId` | herdr tag, pane focus, extra state |
| `~/.claude/projects/*/<sessionId>.jsonl` | Full transcript | Not used in v1 |
| TodoWrite / Task tools | Nothing: 0 calls across the 68 local transcripts | Not used |
| Hooks | `SessionStart`, `UserPromptSubmit` (a Stop hook cannot add context without blocking) | Registration, ⚑ clearing, staleness nudge |

Nothing records which session spawned which, so the parent link has to be declared at spawn time.

## 3. Decisions taken in the brainstorm

| Question | Decision |
| --- | --- |
| Where the pool lives, who writes it | The session itself, through the `orch` CLI, into a shared store. A transcript-derived fallback may come later |
| How "completed" is verified | A tick carries evidence (commit, PR, CI run, command + exit code, note). Without it the tick is shown as *claimed*. CI and PR evidence is rechecked live |
| UI | A TUI (`orch tui`) run in its own herdr pane |
| Sessions not started through herdr | Listed like the rest, tagged `external`; pool and evidence work the same, only pane focus is unavailable |
| Parent/child link | Declared by the parent through `orch spawn-child`, which passes the link and brief to the child's environment; a TUI key links by hand as fallback |
| Remote use (`claude rc`) | `/orch` in any session: an interactive overview through AskUserQuestion, links to each session on claude.ai, push notification on ⚑, and answers to ⚑ delivered into the waiting session. Not an artifact page, not a local web server |
| Build approach | One plugin with one CLI that owns every write; skill, hooks and TUI are thin layers over it. Not hand-edited JSON, not an MCP server |

## 4. Architecture

```
plugins/orchestrator/
  bin/orch          CLI, a prebuilt single-file bundle (plugins install without node_modules); Claude Code puts bin/ on PATH
  lib/orch-tui.mjs  the TUI bundle, loaded only by `orch tui` so hooks stay fast
  skills/orch-pool/ teaches: draft the pool first, tick with evidence, spawn children via orch, push on ask
  commands/orch.md  /orch: the interactive overview for Remote Control (§8)
  hooks/            SessionStart → orch hook session-start ; UserPromptSubmit → orch hook prompt-submit
  src/              TypeScript: store, model, sources, CLI, TUI (Ink)
```

## 5. Data

**Store:** `~/.claude/orchestrator/<sessionId>.json` (root overridable with `ORCH_HOME`). One file per session, written only by `orch`, through a temp file and an atomic rename.

```ts
type Pool = {
  sessionId: string
  title: string                                   // one line: what this session is for
  cwd: string
  parent?: { sessionId: string; taskId: string }  // set by spawn-child or the TUI link key
  brief?: string                                  // absolute path of the brief this child must read
  tasks: Task[]
  seq: number                                     // last task number handed out; ids are never reused
  createdAt: number
  updatedAt: number                               // any write
  touchedAt?: number                              // last write by the session itself through the CLI
  turnStartedAt?: number                          // set by the UserPromptSubmit hook
}

type Task = {
  id: string                                      // 't1', 't2'… stable, never reused
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  blockedReason?: string
  evidence?: Evidence
  children?: string[]                             // child sessionIds spawned for this task
  needsInput?: string                             // a question for the person
}

type Evidence =
  | { kind: 'commit'; ref: string }               // sha
  | { kind: 'pr';     ref: string }               // number or URL
  | { kind: 'ci';     ref: string }               // run URL
  | { kind: 'cmd';    ref: string; exit: number } // command orch ran itself
  | { kind: 'note';   ref: string }               // free text; drawn as claimed
```

**Live state is not stored.** It is joined at read time from `~/.claude/sessions/*.json` (alive, busy/idle, cwd), `herdr agent list` (pane, state, herdr/external tag) and `gh` (CI and PR status, cached 60 s). When a session ends, its pool file stays and the session is shown as *ended*, so a parent's rollup survives a crashed child.

**Rules, enforced by the CLI:**

- `done` without evidence, or with `note` evidence, is accepted and drawn as *claimed*.
- `cmd` evidence is produced by `orch` running the command; a non-zero exit refuses the tick.
- A task with children counts as done only when every child pool has all tasks done.
- A task's ⚑ shows on its own row and on every ancestor session's row.

## 6. Session side

**Session identity.** Claude Code sets `CLAUDE_CODE_SESSION_ID` in every Bash and hook subprocess and keeps it current across `/clear`; `orch` uses it first. As fallbacks for older Claude Code: the SessionStart hook's `export CLAUDE_SESSION_ID=<id>` in `CLAUDE_ENV_FILE`, then `CLAUDE_PID` looked up in `~/.claude/sessions/*.json`, then a walk up the parent PID chain (`/proc/<pid>/stat`) until it meets a registered pid.

**CLI:**

```
orch plan "Create course" "Run audit" "Re-check CI"   # create, or replace the pending part of, the pool
orch title "Beginner courses for all languages"
orch task add "…"
orch task start t2
orch task block t2 "why"
orch task done t2 --evidence commit:abc123 | pr:41 | ci:<run-url> | cmd:"npm test" | note:"…"
orch ask t2 "Which difficulty curve for Go?"          # sets needsInput
orch spawn-child t1 --name course-go --cwd .worktrees/course-go --brief docs/course-brief.md
orch link <child> <parent> <taskId>                  # attach a session under a parent task by hand
orch status                                           # this session's pool as text
orch status --all [--json]                            # every session, as text or JSON (§8)
orch reply <session> [--task <id>] -- "text"          # answer a session's ⚑ (§8)
orch tui                                              # the viewer (§7)
```

`orch plan` keeps done and in-progress tasks and replaces only pending ones, so re-planning never loses evidence.

**Skill `orch-pool`** (not `orch`, which would collide with the `/orch` command). Short; three habits:

1. On a real task, run `orch plan` before starting work.
2. Tick each step with evidence as soon as it is done, not in a batch at the end.
3. When fanning out, write a brief and use `orch spawn-child`; never spawn by hand.

**Hooks.** None of them ever blocks a turn; any error is appended to `$ORCH_HOME/orch.log` and swallowed.

A Stop hook cannot add context without blocking the turn, so the staleness check runs at the start of the next prompt instead.

| Hook | Action |
| --- | --- |
| SessionStart | `orch hook session-start`: export `CLAUDE_SESSION_ID`, create the pool file if missing. On a fresh start (`source: startup`) with `ORCH_PARENT`, `ORCH_PARENT_TASK`, `ORCH_BRIEF` set, record the parent link and brief and add this session to the parent task's `children`; if that task does not exist, keep only the brief. Then unset the `ORCH_*` variables so a `claude` the child runs is not linked too. Whenever the session has a brief, inject as context: *"Read <brief> first; your parent session is <title>."* |
| UserPromptSubmit | `orch hook prompt-submit`: clear `needsInput` on this session's tasks, since the person just replied; a prompt framed `[orch reply to: "…"]` clears only the question it answers. If the previous turn used Edit, Write, MultiEdit, NotebookEdit, Bash, Agent or Task (read from the transcript after `turnStartedAt`) and the pool has no tasks or `touchedAt < turnStartedAt`, add one line of context asking the session to update its pool. Then set `turnStartedAt`. Both hooks give up on a held lock after 1.5 s |

**`spawn-child`.** Follows the `herdr-spawn-rc` recipe: `herdr tab create` in the target cwd, `herdr agent start <name> --kind claude -- --remote-control <name>`, then `herdr agent get` until the child's session id is known. `herdr agent start` cannot set the child's environment, so the parent writes the link itself: the child's pool gets `parent` and `brief`, the parent task gets the child in `children` and, if it was still `pending`, goes `in_progress` (a blocked or done task keeps its status). Only then is the intro sent with `herdr agent prompt`: which task this child serves, read the brief, run `orch plan`. If any step after `agent start` fails, the error prints a ready `orch link <child> <parent> <task> --brief <file>` and the `herdr agent prompt` command with the intro, so the person can finish by hand. Outside herdr, `spawn-child` prints a `cd … && ORCH_PARENT=… ORCH_PARENT_TASK=… ORCH_BRIEF=… claude --remote-control <name> "<intro>"` command for the person to run; the child's SessionStart hook then records the link from those variables.

## 7. TUI (`orch tui`)

**List view**: a tree of live and recently ended sessions.

```
 ORCHESTRATOR                                     7 live · 1 ⚑ · 2 ended
 ▸ beginner-courses     ItAbyss          idle   herdr     2/4  ⚑1
   ├ course-python      wt/course-python busy   herdr     3/5
   ├ course-javascript  wt/course-js     busy   herdr     1/5
   └ course-go          wt/course-go     ended  —         5/5 ✓
   orchestrator         ClaudeSkills     busy   herdr     1/3
   HEAD                 ItAbyss          idle   herdr     —  no pool
   api-fix              strikerz         idle   external  0/2
```

- Children nest under their parent; ⚑ bubbles up to every ancestor.
- Sessions without a pool are listed as *no pool*, not hidden.
- Ended sessions drop off after 24 h unless they are a child of a live parent.
- A session blocked on a permission prompt or dialog shows state `waiting`.

**Pool view** (Enter):

```
beginner-courses — Beginner courses for all languages
✓ t1 Write course brief             commit 9f3e2a1
◐ t2 Create course per language     3 children: 1 ✓ 2 running
⚑ t3 Pick audit rubric              "Strict or lenient for beginners?"
· t4 Re-check CI                    ci: ✗ failing (live)
```

Evidence marks: ✓ proven, `~` claimed (no evidence or note only), ✗ a live CI/PR check disagrees with the tick.

**Keys:** `↑↓`/`jk` move, `Enter` open, `Esc` back, `f` focus the session's herdr pane (external sessions show cwd and pid instead), `o` print the session's claude.ai link, `l` link the selected session under a parent task, `r` refresh, `/` filter, `q` quit.

**Refresh:** every 3 s the TUI re-reads `$ORCH_HOME`, `~/.claude/sessions/` and `herdr agent list`; `gh` is asked only for CI and PR evidence, at most four at a time. Answers are cached 60 s, and final ones (merged or closed PRs, finished runs) for good. The TUI never waits on `gh`: it shows the last answer (or *unverified*) and refreshes it in the background. `orch task done` still waits for a fresh answer before it accepts CI or PR evidence.

## 8. Remote use (`claude rc`)

The TUI lives in a terminal pane and cannot be seen from a phone. Remote use goes through the chat of any session instead.

**`/orch` command.** It runs `orch status --all --json` and drives an AskUserQuestion loop, which Remote Control renders as tappable choices:

1. *Which session?* One option per session, the ones with ⚑ first: `beginner-courses 2/4 ⚑`. With more than four, the ⚑ sessions and the most recently active fill the slots and *Other* takes a name.
2. The chosen session's pool is printed as a short list, then *What now?* with **Answer ⚑** (only when the session has one), **Open session**, **Back**.
3. **Answer ⚑** takes the person's text and runs `orch reply`. **Open session** prints the claude.ai link.

**Links.** A session's entry in `~/.claude/sessions/<pid>.json` carries `bridgeSessionId` when it is on Remote Control; its link is `https://claude.ai/code/<bridgeSessionId>`. Sessions without one show no link.

**Push on ⚑.** The skill tells a session that runs `orch ask` to also send a push notification naming itself and the question, so the person learns about it on the phone without opening `/orch`.

**`orch reply <session> "text"`.** Delivers the answer into the waiting session as its next prompt, then clears that task's `needsInput`:

| Target | Route |
| --- | --- |
| herdr pane | `herdr agent prompt <pane_id> "<text>"`; if the agent is working, `herdr agent wait` for idle up to 90 s first, so a reply from the phone answers within one Bash call; still busy: refused, the ⚑ stays open; a pane that closed meanwhile: refused with herdr's reason |
| not in herdr | `orch reply` exits with code 3 and prints the session's id, name, cwd, task and the framed text; `/orch` finds it with ListAgents, sends the text with SendMessage, then runs `orch reply --mark-only` for that task |

The text is prefixed `[orch reply to: "<question>"]` (the question on one line, at most 200 characters) so the receiving session knows which ⚑ it answers. `orch reply` refuses a session with no open ⚑, asks for `--task` when several are open, and sends nothing if the question was answered in the session while it waited; free-form prompting stays out of scope.

## 9. Failure handling

| Case | Behaviour |
| --- | --- |
| Pool file unreadable | That row shows *unreadable pool*; the rest renders |
| Stale registry file (crash, recycled pid) | Live only while its pid runs with the start time Claude recorded (`procStart`), as Claude Code itself checks; otherwise *ended* |
| herdr not running | Every session tagged `external`; `f` disabled |
| `gh` missing or offline | CI/PR evidence shown as *unverified*, not ✗ |
| Child's parent pool gone | Child shown at top level as *orphan*; `l` relinks it |
| Two sessions in one cwd | Always told apart by `sessionId`, never by path |
| `orch reply` target ended or its pane gone | Refused with the reason; the ⚑ stays open |
| Concurrent writes (child registering into parent) | Atomic rename plus a per-file lock in `orch` |
| Hook meets a held or orphaned lock | Gives up after 1.5 s and logs it; the prompt is never held up |
| Hand-started child given a wrong `ORCH_PARENT_TASK` | Not linked; it still gets its brief, and `orch link` fixes the link |
| Pools of short-lived sessions (`claude -p`, `/clear`) | Ended sessions with no tasks, children or title are hidden; their pools are deleted after 7 days by the SessionStart hook, at most once an hour |
| `/clear` in a session | Claude Code starts a new session id: the old pool shows as *ended*, the new one starts empty, and a child is linked only on its first start, so it is never added twice |

## 10. Out of scope for v1

- Pools derived from transcripts for sessions that never wrote one.
- A local web view (the store is plain JSON, so it can be added without redesign).
- Resuming an exited external session inside herdr.
- Sending free-form prompts or keys to sessions; only answers to ⚑ go through `orch reply`.
- Sessions on other machines.
- Carrying a pool across `/clear` (the new session id has no link to the old one).
- Claude Code's Bash sandbox: it runs commands in their own pid namespace and limits writes, so `orch` called from inside it cannot see other sessions or write `$ORCH_HOME`. The README tells the user to add `orch *` to `sandbox.excludedCommands`, and says plainly that this also lets `cmd:` evidence run outside the sandbox.

## 11. Testing

- **Unit:** the pool model and rules (evidence states, child rollup, ⚑ bubbling, `plan` keeping done tasks), and the join of registry, herdr and `gh` output, against fixtures recorded from real `~/.claude/sessions/*.json` and `herdr agent list`.
- **CLI:** each command against a temp `ORCH_HOME`, including concurrent writes to one pool.
- **Remote:** `orch status --all --json` against fixtures, including `bridgeSessionId` links; `orch reply` against stubbed herdr (idle, busy then idle, pane gone) and the non-herdr exit code.
- **TUI:** snapshot tests of the list and pool views with `ink-testing-library`.
- **End-to-end smoke:** a fake parent runs `spawn-child` with herdr stubbed; the child's SessionStart hook links it, and the parent's rollup updates.
