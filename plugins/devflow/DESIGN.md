# devflow — design

One versioned plugin for the way features get built: requirements are drawn out first, one design
doc carries every decision, UI work is critiqued before it ships, analytics is asked about at the
hand-offs. Settled with the owner on 2026-10-22 after an audit of the old ItAbyss setup (grilling +
superpowers brainstorming + a gitignored `feature-workflow.sh` + an analytics reminder hook), which
dead-ended after grilling, landed design docs in five places, and demanded impeccable at the wrong time.

## Flow

```
feature prompt ──► devflow:requirements ──► devflow:design ──► project gate ──► superpowers:writing-plans ──► code
                   (rounds, writes ## Решения)  (writes ## Дизайн,        (e.g. Notion)   (plan carries both delta lines)
                                                 ## Work split, deltas)
UI files edited ──► Stop blocked until `impeccable critique` ran after the last UI edit
```

## Pieces

| Piece | What it does |
| --- | --- |
| `skills/requirements` | Own replacement for grilling. Design-tree rounds, each question with a recommendation; facts found by subagents, never asked. Round 1 always settles: does it touch UI, does it need analytics, which behavior contracts change. Every settled decision is written to the spec's `## Решения` as it lands. Ends by invoking `devflow:design` with "decisions settled, do not re-ask". |
| `skills/design` | Own replacement for brainstorming. Reads `## Решения`, proposes 2–3 approaches with a recommendation, writes `## Дизайн`, `## Work split`, and the two delta lines into the same spec, runs the project gate, hands off to `superpowers:writing-plans`. For UI: canvas via the Artifact tool's Design type (quickstart `intent: "design"`), then `impeccable:impeccable` critique before the gate. |
| `hooks/devflow.sh` | One script, modes `prompt` / `skill` / `edit` / `bash` / `stop` (below). |
| `.claude/devflow.json` (in the project) | Turns devflow on for that repo and configures it. **No file → every hook is silent.** |

## The one design doc

`<specDir>/<YYYY-MM-DD>-<slug>.md`, one per feature:
`## Решения` (requirements) → `## Дизайн` (approach, architecture) → `## Work split` (one row per
kind: what, depends on, parallel?, branch) → `**Behavior-contract delta:** …` and `**Analytics delta:** …`.
The implementation plan stays `superpowers:writing-plans`' (its own dir); the hook makes sure it
repeats the two delta lines.

## Project config

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
Every key optional; missing `analyticsSkill` / `gate` / `uiPaths` turns that part off.

## Hooks

State: `~/.claude/state/devflow/<session_id>.json` (outside every repo, so worktrees and clones
share nothing and nothing dirties git). Every mode fails open: bad stdin, no `jq`, no config → exit 0, silent.

- **prompt** (UserPromptSubmit): a feature-shaped prompt (positive verbs build/add/implement/new
  feature/сделай/добавь/фича…, plus brainstorm / design doc / спроектир…, with negatives anchored at the
  start: `^(fix|how|what|why|почему|как|что|зачем|исправь|почини|поправь)\b`, and `test`/`тест`
  excluded) arms the session once and injects: "Feature work here goes through
  devflow:requirements → devflow:design (not grilling / superpowers:brainstorming)." `[no-devflow]` in a
  prompt disarms the session for good; a typed `/impeccable critique …` stamps `critique_at`.
- **skill** (PostToolUse Skill): records `requirements_at`, `design_at`, `plan_at`, `critique_at`
  (`impeccable:impeccable` whose args contain `critique`, or `/impeccable critique`). At
  `devflow:requirements` start, if `analyticsSkill` is set: one reminder to run it and put the
  **Analytics delta** in the spec. At the `writing-plans` / `executing-plans` /
  `subagent-driven-development` hand-off: one reminder that the plan repeats both delta lines, naming
  `analyticsSkill` when it is set.
- **edit** (PreToolUse Edit|Write|MultiEdit|NotebookEdit):
  - a path under `specDir` → remember it as this session's spec;
  - a path under `codePaths` while armed → deny unless this session's spec exists on disk with
    `## Решения`, `## Дизайн` and `## Work split` (checked on disk at that moment, so Edit and Write
    are judged the same and no unrelated file unlocks it); the deny names what is missing;
  - a path under `uiPaths` with a `uiExtensions` suffix → `ui_edit_at = now`.
  - no `codePaths` → no gate; no `uiExtensions` → every file under `uiPaths` counts.
- **bash** (PreToolUse Bash): `git worktree add` outside `<repo>/<worktreeDir>/` is denied (ported).
  `<repo>` is the main worktree; the path resolves against the cwd (or `-C`), and one nested inside an
  existing worktree is denied too.
- **stop** (Stop): if `ui_edit_at > critique_at` → block once with "UI changed since the last
  impeccable critique: run `impeccable:impeccable` critique and fix what it finds"; `stop_hook_active`
  prevents a loop. If a critique ran after that block, the continuation Stop counts the fixes made since
  as critiqued. Nothing else blocks Stop.

## Done means

1. `tests/run.sh` passes: synthetic payloads for every mode, including no-config silence, gate
   deny/allow, UI edit → Stop block → critique → Stop free, the anchored prompt regex, fail-open on
   garbage stdin.
2. `claude plugin validate plugins/devflow` passes.
3. Live in ItAbyss: a `claude -p` feature prompt gets the devflow injection; a code edit with no spec
   is denied; with a spec it passes.
4. ItAbyss carries only `.claude/devflow.json`, the Notion gate and `itabyss-analytics-events`; its
   old `feature-workflow.sh` / `analytics-events-reminder.sh` wiring is gone.
