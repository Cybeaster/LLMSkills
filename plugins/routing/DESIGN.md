# routing — design

Claude Code does not know which model and effort to give delegated work. This plugin gives it a
policy, puts the policy in front of the model, holds `Agent` calls to it, and logs every choice.
Settled in a grilling session on 2026-10-21/22; this file is the record.

## Goal

Quality first. Delegated work gets a model and effort chosen by **task class**; money is saved only
on mechanical work. The main session's own model and its `effortLevel: xhigh` are never touched.

## Surfaces

| Surface | How it is held to the policy |
| --- | --- |
| `Agent` tool calls | `tool.call` hook: denies a call without a `[class]` tag, `model` and `effort` at or above the class floor |
| `Workflow` `agent()` calls | the prompt section tells Claude to pass `opts.model` + `opts.effort`; the `agent.spawn` hook fills a missing model with `workflowModel` and logs the agent; a `turn.step` hook logs the effort it really ran at |
| Spawned sessions (`orch spawn-child`, herdr) | fixed `spawn` floor (`opus` / `xhigh`) unless the user names a model; orch passes `--model`/`--effort` (orchestrator plugin) |

## Policy table (floors — stronger is allowed)

| Tag | Class | Model | Effort |
| --- | --- | --- | --- |
| `[search]` | Search/locate | haiku | low |
| `[mechanical]` | Mechanical edit | haiku | medium |
| `[implement]` | Implementation | opus | high |
| `[content]` | Content authoring | opus | xhigh |
| `[review]` | Review/verify | fable | xhigh |
| `[design]` | Design / root-cause debugging | fable | xhigh |
| `[research]` | Research | opus | high |

Ladders: `haiku < sonnet < opus < fable`; `low < medium < high < xhigh < max`.

## Rules

- **Precedence:** the user's explicit words > skill frontmatter > project `<repo>/.claude/routing.json`
  > user `~/.claude/routing/policy.json` > the plugin's `policy.json` > inherit. The class table
  outranks *agent* frontmatter: every agent type is held to it except `fork`, which always inherits.
- **`[override]`** in the description lets a call go below its floor or use `max`. Claude adds it
  only when the user explicitly asked; the log records it.
- **`max` effort** needs `[override]`.
- **Escalation:** after a delegated result fails verification, the retry goes one step up (model or
  effort), never past fable/xhigh unless the user asks. Claude's judgment, stated in the prompt
  section; the floor check allows it because stronger is always allowed.
- **Fail open.** A hook that throws lets the call through: routing is cost and quality, not security.

## Single source of truth

`policy.json` in the plugin, layered by the user and project files above. The prompt section and
the deny message are both rendered from the merged policy, so the text Claude reads cannot drift
from what the hook enforces. orch reads only the user file's `spawn` key and falls back to
`opus`/`xhigh`, so it has no code dependency on this plugin.

## Log

One JSON line per decision in `~/.claude/state/routing/<YYYY-MM-DD>-<sid>.jsonl` (one file per
session per day, so concurrent sessions never rewrite each other's file). Fields: `ts`, `surface`
(`agent` | `workflow`), `cls`, `model`, `effort`, `override`, `verdict` (`allow` | `deny` |
`exempt` | `filled`), `reason`, `outcome`, `subagentType`, `runId`, `agentIndex`, `label`.
Read with `cat ~/.claude/state/routing/*.jsonl | jq -s 'group_by(.cls) | map({cls: .[0].cls, n: length})'`.

## Mechanism

A hooks **module** (mod) rather than a shell `PreToolUse` hook: one in-process module sees `Agent`
calls (`tool.call`), every subagent and workflow agent start (`agent.spawn`), the effort a request
really carries (`turn.step`), and composes the system prompt (`prompt.compose`), so the rule text
is generated, not a hand-kept copy in `~/.claude/rules/`.

## Done means

1. Tests pass: tag missing, below floor, `[override]`, `fork` exempt, `[content]` on sonnet denied.
2. Live: an untagged `Agent` call is denied; the tagged retry passes and is logged.
3. A small workflow run logs its agents.
4. `orch spawn-child` with no flags starts the child on opus / xhigh.
