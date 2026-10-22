# devflow

One flow for building features: requirements are drawn out first, one design doc carries every decision, code
waits until that doc is complete, UI is critiqued before it ships, and analytics is asked about at the hand-offs.
It replaces grilling + `superpowers:brainstorming` for feature work.

```
feature prompt ──► devflow:requirements ──► devflow:design ──► project gate ──► superpowers:writing-plans ──► code
                   (rounds, writes ## Решения)  (writes ## Дизайн,        (e.g. Notion)   (plan carries both delta lines)
                                                 ## Work split, deltas)
UI files edited ──► Stop blocked until `impeccable critique` ran after the last UI edit
```

## Skills

- **`devflow:requirements`**: rounds of numbered ❓ questions, each with a ➡️ recommendation that "yes" accepts.
  The whole frontier of open decisions goes out at once; facts come from subagents, never from you. Round 1
  always settles UI, analytics and behavior contracts. It creates `<specDir>/<YYYY-MM-DD>-<slug>.md` up front
  and writes each decision into `## Решения` as it lands, then hands off to `devflow:design`.
- **`devflow:design`**: reads `## Решения` without re-asking it, offers 2–3 approaches, writes `## Дизайн`,
  `## Work split` and the two delta lines (`**Behavior-contract delta:**`, `**Analytics delta:**`). For UI it
  draws a canvas (Artifact, Design type) and runs an `impeccable:impeccable` critique before the gate. Then it
  runs your project gate and hands off to `superpowers:writing-plans`, which copies both delta lines into the plan.

## Hooks

One script, `hooks/devflow.sh`, silent in any repo without `.claude/devflow.json`.

| Mode | Event | What it does |
| --- | --- | --- |
| `prompt` | UserPromptSubmit | A feature-shaped prompt (build / add / implement / new feature / сделай / добавь / фича…, not one that starts with fix / how / what / why / почему / как, not one about tests) arms the session once and points Claude at `devflow:requirements`. `[no-devflow]` in a prompt disarms it for the session. |
| `skill` | PostToolUse `Skill` | Records when requirements, design, the plan and an impeccable critique ran. At requirements start and at the writing-plans / executing-plans / subagent-driven-development hand-off it reminds about the delta lines and, with `analyticsSkill` set, about running it. |
| `edit` | PreToolUse `Edit\|Write\|MultiEdit\|NotebookEdit` | A markdown file under `specDir` becomes this session's spec. While armed, an edit under `codePaths` is denied until that spec is on disk with `## Решения`, `## Дизайн` and `## Work split`, and the denial names what is missing. An edit under `uiPaths` with a `uiExtensions` suffix marks the UI as changed. |
| `bash` | PreToolUse `Bash` | `git worktree add` outside `<repo>/<worktreeDir>/` (or nested in another worktree) is denied. |
| `stop` | Stop | UI changed since the last critique → block once, asking for `impeccable:impeccable` critique and its fixes. Fixes made in answer to that block count as critiqued. Nothing else blocks Stop. |

State lives in `~/.claude/state/devflow/<session_id>.json` (override with `DEVFLOW_STATE_DIR`), outside every
repo. Every mode fails open: no `jq`, bad input, no git, a broken config → exit 0, no output.

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
  "gate": "Read .claude/skills/shared/itabyss-notion-gate.md and follow it",
  "contractsDir": "docs/behavior"
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `specDir` | `docs/specs` | Where specs live; a markdown edit here is this session's spec. |
| `codePaths` | none (no gate) | Directories whose edits wait for a complete spec. `"."` means the whole repo. |
| `uiPaths` | none (no critique block) | Directories whose edits need an impeccable critique before Stop. |
| `uiExtensions` | every file | Suffixes under `uiPaths` that count as UI. |
| `worktreeDir` | `.worktrees` | The only place `git worktree add` may create worktrees. |
| `analyticsSkill` | none (no reminder) | The skill that decides analytics events; named in the reminders. |
| `gate` | none (plain approval) | Text `devflow:design` follows as the project's review step before the plan. |
| `contractsDir` | none | Where behavior contracts live; the skills check it for the Behavior-contract delta. |

## Test

```bash
bash plugins/devflow/tests/run.sh
```

## Install

```
/plugin install devflow@claude-skills
```

Needs `bash`, `git` and `jq`. Claude Code only: the hooks are what hold the flow together.
