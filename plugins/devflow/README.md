# devflow

One flow for building features: requirements are drawn out first, one design doc carries every decision, code
waits until that doc is complete, UI is critiqued before it ships, and analytics is asked about at the hand-offs.
It replaces grilling + `superpowers:brainstorming` for feature work. Ordinary work is never blocked: a prompt
only gets a nudge, and the gates apply to a session once it has started the feature flow.

```
feature prompt ··► nudge (never a gate)
devflow:requirements ──► devflow:design ──► project gate ──► superpowers:writing-plans ──► code
(arms the session;        (writes ## Дизайн,   (e.g. Notion)   (plan carries both delta lines)
 writes ## Решения)        ## Work split, deltas)
armed + UI files edited ──► Stop blocked until `impeccable critique` ran after the last UI edit
```

## Skills

- **`devflow:requirements`**: for feature work, not small tweaks. Rounds of numbered ❓ questions, each with a ➡️
  recommendation that "yes" accepts. The whole frontier of open decisions goes out at once; facts are looked up
  (trivial ones directly, real investigation through subagents), never asked. Round 1 always settles UI,
  analytics and behavior contracts. It creates `<specDir>/<YYYY-MM-DD>-<slug>.md` up front (asking where first
  when the repo has no `devflow.json`) and writes each decision into `## Решения` as it lands, then hands off
  to `devflow:design`.
- **`devflow:design`**: reads `## Решения` without re-asking it, offers 2–3 approaches, writes `## Дизайн`,
  `## Work split` and the two delta lines (`**Behavior-contract delta:**`, `**Analytics delta:**`). For UI it
  draws a canvas (Artifact, Design type) and runs an `impeccable:impeccable` critique before the gate. Then it
  runs your project gate and hands off to `superpowers:writing-plans`, which copies both delta lines into the plan.

## Hooks

One script, `hooks/devflow.sh`, silent in any repo without `.claude/devflow.json`.

| Mode | Event | What it does |
| --- | --- | --- |
| `prompt` | UserPromptSubmit | A feature-shaped prompt (build / add / implement / new feature / сделай / добавь / фича…) gets a nudge toward `devflow:requirements`, naming `armingSkills` and the `gate` text when set; at most once per 30 minutes. Never arms. Not feature-shaped: prompts that start with fix / фикс / how / what / why / почему / как / commit / push / merge / rebase / build / run / deploy / review / screenshot / log, prompts about a PR, коммит, пуш, ветка, ревью, лог, скриншот, "implement the plan", and prompts about tests. `[no-devflow]` disarms the session and silences the nudge. |
| `skill` | PostToolUse `Skill` | **Arms the session** when `devflow:requirements`, `devflow:design` or an `armingSkills` wrapper starts, and says what is now gated plus "Project gate: …" when `gate` is set. Records when requirements, design, the plan and an impeccable critique ran. At requirements start and at the writing-plans / executing-plans / subagent-driven-development hand-off it reminds about the delta lines and, with `analyticsSkill` set, about running it. |
| `edit` | PreToolUse `Edit\|Write\|MultiEdit\|NotebookEdit` | A markdown file under `specDir` becomes this session's spec. While armed, an edit under `codePaths` is denied until the spec is on disk with `## Решения`, `## Дизайн` and `## Work split`, and the denial names what is missing. A session that edited no spec accepts the newest complete one in `specDir`. While armed, an edit under `uiPaths` with a `uiExtensions` suffix marks the UI as changed. |
| `bash` | PreToolUse `Bash` | `git worktree add` outside `<repo>/<worktreeDir>/` (or nested in another worktree) is denied. |
| `stop` | Stop | Armed and UI changed since the last critique → block once, asking for `impeccable:impeccable` critique and its fixes. Fixes made in answer to that block count as critiqued. An unarmed session never blocks; nothing else blocks Stop. |
| `end` | SessionEnd | Deletes the session's state. |

State lives in `~/.claude/state/devflow/<session_id>.json` (override with `DEVFLOW_STATE_DIR`), outside every
repo. Every mode fails open: no `jq`, bad input, no git, a broken config → exit 0, no output.

The gate is advisory: it watches the file tools, so a shell write (`cat > file`, `sed -i`) passes. It keeps
an honest agent on the flow; it is not a sandbox.

## Config

`.claude/devflow.json` at the repo root turns devflow on. A linked worktree without its own file uses the main
worktree's. Every key is optional.

```json
{
  "specDir": "docs/specs",
  "codePaths": ["webapp/", "api/"],
  "uiPaths": ["webapp/components/", "webapp/app/"],
  "uiExtensions": [".tsx", ".css"],
  "worktreeDir": ".worktrees",
  "analyticsSkill": "itabyss-analytics-events",
  "armingSkills": ["itabyss-brainstorm", "itabyss-brainstorm-design"],
  "gate": "Read .claude/skills/shared/itabyss-notion-gate.md and follow it",
  "contractsDir": "docs/behavior"
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `specDir` | `docs/specs` | Where specs live; a markdown edit here is this session's spec. |
| `codePaths` | none (no gate) | Directories whose edits wait for a complete spec once armed. `"."` means the whole repo. |
| `uiPaths` | none (no critique block) | Directories whose edits, once armed, need an impeccable critique before Stop. |
| `uiExtensions` | every file | Suffixes under `uiPaths` that count as UI. |
| `worktreeDir` | `.worktrees` | The only place `git worktree add` may create worktrees. |
| `analyticsSkill` | none (no reminder) | The skill that decides analytics events; named in the reminders. |
| `armingSkills` | none | Project wrappers that start the flow and so arm the session, bare or namespaced names. |
| `gate` | none (plain approval) | Text `devflow:design` follows as the project's review step before the plan; also shown on arming and in the nudge. |
| `contractsDir` | none | Where behavior contracts live; the skills check it for the Behavior-contract delta. |

## Vendoring

A project can carry devflow itself, so a fresh clone works with no plugin install. Copy these three paths
byte-identically (no edits: the copy decides it is the project's by its location):

| From the plugin | Into the project |
| --- | --- |
| `skills/requirements/` | `.claude/skills/requirements/` |
| `skills/design/` | `.claude/skills/design/` |
| `hooks/devflow.sh` | `.claude/hooks/devflow.sh` |

and wire the hooks in the project's `.claude/settings.json`, the same events and matchers as `hooks/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" prompt", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Skill", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" skill", "timeout": 10 }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" edit", "timeout": 10 }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" bash", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" stop", "timeout": 10 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/devflow.sh\" end", "timeout": 10 }] }
    ]
  }
}
```

Merge these arrays into any hooks the project already has. `.claude/devflow.json` still turns devflow on.

**With the plugin installed too**, both copies fire on every event. The plugin's copy yields: when
`<root>/.claude/hooks/devflow.sh` exists (root = the cwd's git toplevel, the main worktree, or
`$CLAUDE_PROJECT_DIR`) and is not the running script (compared by real path), it exits silently, `end`
included. The project's copy is that file, so it runs. Byte-identical copies make this safe: the check is
by location, not by content.

**Skill names.** A vendored skill appears bare (`requirements`, `design`) beside the plugin's
`devflow:requirements` / `devflow:design`. The project's copy of the hook treats both spellings as
devflow's: either arms the session and stamps its step, the nudge names the bare skills first, and the
gate's messages name the bare skills. The plugin's copy never takes a bare name, since outside a vendoring
project `design` may be some other skill.

To update, copy the three paths again from the new plugin version.

## Depends on

Needs `bash`, `git` and `jq`. Claude Code only: the hooks are what hold the flow together.

Soft dependencies, used when installed:

- **superpowers** (`superpowers:writing-plans`): `devflow:design` hands the spec to it for the plan.
- **impeccable** (`impeccable:impeccable`): the UI critique the Stop hook asks for and `devflow:design` runs on the canvas.
- **The Artifact tool's Design type**: the canvas in `devflow:design`'s UI branch.
- **routing** (optional): when installed, the skills' subagent calls carry its class tags, model and effort.

## Test

```bash
bash plugins/devflow/tests/run.sh
```

## Install

```
/plugin install devflow@claude-skills
```
