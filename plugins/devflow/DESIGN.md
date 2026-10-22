# devflow — design

One versioned plugin for the way features get built: requirements are drawn out first, one design
doc carries every decision, UI work is critiqued before it ships, analytics is asked about at the
hand-offs. Settled with the owner on 2026-10-22 after an audit of the old ItAbyss setup (grilling +
superpowers brainstorming + a gitignored `feature-workflow.sh` + an analytics reminder hook), which
dead-ended after grilling, landed design docs in five places, and demanded impeccable at the wrong time.

**Gate features, never block ordinary work.** A prompt only ever gets a nudge. The gates (code waits
for the spec, Stop waits for a UI critique) apply only to a session that started the feature flow.

## Flow

```
feature prompt ··► nudge (never a gate)
devflow:requirements ──► devflow:design ──► project gate ──► superpowers:writing-plans ──► code
(arms the session;        (writes ## Дизайн,   (e.g. Notion)   (plan carries both delta lines)
 writes ## Решения)        ## Work split, deltas)
armed + UI files edited ──► Stop blocked until `impeccable critique` ran after the last UI edit
```

A project wrapper listed in `armingSkills` (ItAbyss: `itabyss-brainstorm`, `itabyss-brainstorm-design`)
arms the session the same way when it starts.

## Pieces

| Piece | What it does |
| --- | --- |
| `skills/requirements` | Own replacement for grilling, for feature work only (not small tweaks). Design-tree rounds, each question with a recommendation; facts looked up, never asked (trivial lookups directly, real investigation through subagents). Round 1 always settles: does it touch UI, does it need analytics, which behavior contracts change. Every settled decision is written to the spec's `## Решения` as it lands. With no `devflow.json` it first asks where to keep the spec. Ends by invoking `devflow:design` with "decisions settled, do not re-ask". |
| `skills/design` | Own replacement for brainstorming. Reads `## Решения`, proposes 2–3 approaches with a recommendation, writes `## Дизайн`, `## Work split`, and the two delta lines into the same spec, runs the project gate, hands off to `superpowers:writing-plans`. For UI: canvas via the Artifact tool's Design type (quickstart `intent: "design"`), then `impeccable:impeccable` critique before the gate. |
| `hooks/devflow.sh` | One script, modes `prompt` / `skill` / `edit` / `bash` / `stop` / `end` (below). |
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
  "armingSkills": ["itabyss-brainstorm", "itabyss-brainstorm-design"],
  "gate": "Read .claude/skills/shared/itabyss-notion-gate.md and follow it",
  "contractsDir": "docs/behavior"
}
```
Every key optional; missing `analyticsSkill` / `gate` / `uiPaths` / `codePaths` / `armingSkills` turns
that part off.

## Hooks

State: `~/.claude/state/devflow/<session_id>.json` (outside every repo, so worktrees and clones
share nothing and nothing dirties git), deleted at SessionEnd. Every mode fails open: bad stdin, no
`jq`, no config → exit 0, silent.

- **prompt** (UserPromptSubmit): never arms. A feature-shaped prompt (positive verbs
  build/add/implement/new feature/сделай/добавь/фича…, plus brainstorm / design doc / спроектир…) gets a
  nudge: "Feature work here goes through devflow:requirements → devflow:design (not grilling /
  superpowers:brainstorming)", naming the `armingSkills` wrappers and the `gate` text ("Project gate: …")
  when set. At most once per 30 minutes per session, so a later feature is nudged again. Not
  feature-shaped:
  - anchored at the start: `^(fix|фикс…|how|what|why|почему|как|что|зачем|исправь|почини|поправь|commit|push|merge|rebase|build|run|deploy|review|screenshot|log)`;
  - anywhere: PR / pull request, "implement / execute / follow the plan", «выполни план», коммит, пуш,
    ветк…, ревью, лог(и), скриншот, and `test` / `тест`.

  `[no-devflow]` in a prompt disarms the session and silences the nudge; a typed
  `/impeccable critique …` stamps `critique_at`.
- **skill** (PostToolUse Skill): **arms the session** when `devflow:requirements`, `devflow:design` or a
  skill named in `armingSkills` starts (bare or namespaced name), clearing any `[no-devflow]`. On
  arming it says what is now gated and, with `gate` set, "Project gate: …", so starting
  `devflow:requirements` directly still opens the project's gate. Records `requirements_at`,
  `design_at`, `plan_at`, `critique_at` (`impeccable:impeccable` whose args contain `critique`, or
  `/impeccable critique`). At `devflow:requirements` start, if `analyticsSkill` is set: one reminder to
  run it and put the **Analytics delta** in the spec. At the `writing-plans` / `executing-plans` /
  `subagent-driven-development` hand-off: one reminder that the plan repeats both delta lines, naming
  `analyticsSkill` when it is set.
- **edit** (PreToolUse Edit|Write|MultiEdit|NotebookEdit):
  - a markdown path under `specDir` → remember it as this session's spec;
  - not armed → nothing else happens;
  - a path under `codePaths` → deny unless the spec exists on disk with `## Решения`, `## Дизайн` and
    `## Work split` (checked on disk at that moment, so Edit and Write are judged the same). The spec
    is this session's; a session that edited none (say, one that starts design on an existing spec)
    accepts the newest `.md` in `specDir` that has all three. The deny names what is missing;
  - a path under `uiPaths` with a `uiExtensions` suffix → `ui_edit_at = now`;
  - no `codePaths` → no gate; no `uiExtensions` → every file under `uiPaths` counts.
- **bash** (PreToolUse Bash): `git worktree add` outside `<repo>/<worktreeDir>/` is denied (ported).
  `<repo>` is the main worktree; the path resolves against the cwd (or `-C`), and one nested inside an
  existing worktree is denied too.
- **stop** (Stop): only while armed (not waived): if `ui_edit_at > critique_at` → block once with "UI
  changed since the last impeccable critique: run `impeccable:impeccable` critique and fix what it
  finds"; `stop_hook_active` prevents a loop. If a critique ran after that block, the continuation Stop
  counts the fixes made since as critiqued. An unarmed session (a `.tsx` bug fix) never blocks, and
  nothing else blocks Stop.
- **end** (SessionEnd): deletes the session's state file, config or not.

**Advisory, not a sandbox.** The gate watches the file tools (Edit, Write, MultiEdit, NotebookEdit).
A shell write (`cat > file`, `sed -i`, a script) passes untouched; the gate keeps an honest agent on
the flow, it does not contain a determined one.

## Done means

1. `tests/run.sh` passes: synthetic payloads for every mode, including no-config silence, the nudge
   that never arms, arming by the flow's skills and `armingSkills`, gate deny/allow and the spec
   fallback, armed UI edit → Stop block → critique → Stop free (unarmed never blocks), the prompt
   regex, SessionEnd cleanup, fail-open on garbage stdin.
2. `claude plugin validate plugins/devflow` passes.
3. Live in ItAbyss: a `claude -p` feature prompt gets the devflow nudge; once the flow starts, a code
   edit with no spec is denied; with a spec it passes.
4. ItAbyss carries only `.claude/devflow.json`, the Notion gate and `itabyss-analytics-events`; its
   old `feature-workflow.sh` / `analytics-events-reminder.sh` wiring is gone.
