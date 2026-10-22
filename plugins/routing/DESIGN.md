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
| `Workflow` `agent()` calls | the prompt section tells Claude to pass `opts.model` + `opts.effort`; the `agent.spawn` hook fills a missing model with `workflowModel` and logs the agent at once; a `turn.step` hook logs the effort its first request really carried as a second row |
| Subagent and workflow-agent task prompts | `agent.spawn` hook: every new non-fork agent (subagent, teammate, workflow agent; not a resume) gets a `[routing]` header before its prompt: its class, model, effort, and the floors on one line |
| Spawned sessions (`orch spawn-child`, herdr) | fixed `spawn` floor (`opus` / `xhigh`) unless the user names a model; orch passes `--model`/`--effort` (orchestrator plugin) |

## Subagents

`prompt.compose` shapes only the main session's system prompt (its input has no `agentId`), so a
subagent never sees the routing section, yet its own `Agent` calls are held to the table like any
other. The `agent.spawn` hook closes that gap through the task prompt instead:

```
[routing] You run as [search] on haiku at effort low. Stay within that budget: don't over-explore.
If you delegate (Agent tool / workflow agent()), follow these floors — tag the description with one class and pass model + effort at or above it:
search haiku/low · mechanical haiku/medium · implement opus/high · …
```

- Rendered by `agentHeader()` in `policy.ts` from the merged policy, like the section and the deny text.
- The class comes from the description tag (`classOf()`, the same parser `check()` uses); an untagged or
  unknown tag reads `unclassified`, no model reads `inherited`.
- An `Agent` spawn's effort is not on `AgentSpawnInput`: the allowed `tool.call` keeps `{ cls, model,
  effort }` by `tool_use_id` (at most 200, the oldest dropped; deleted once the call settles) and the
  spawn takes it. A workflow agent's effort is unknown at spawn, so its header leaves effort out and
  names the filled model.
- Forks (they inherit the parent's context) and resumes (a content rewrite is ignored) are untouched.
- A workflow run that keeps its script out of SDK events hands the hook a placeholder prompt and the
  engine drops the rewrite; that agent starts without the header, by design.

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
  Teammates (`Agent({ name })`) are held like any other call.
- **Only the model's own Agent calls are held to the table; another plugin's programmatic calls pass**
  (`next.origin.plugin !== 'engine'`), unlogged.
- **`[override]`** just before or after the class tag lets a call go below its floor or use `max`. Claude adds it
  only when the user explicitly asked; the log records it.
- **`max` effort** needs `[override]`.
- **Escalation:** after a delegated result fails verification, the retry goes one step up (model or
  effort), never past fable/xhigh unless the user asks. Claude's judgment, stated in the prompt
  section; the floor check allows it because stronger is always allowed.
- **Fail open.** A hook that throws lets the call through: routing is cost and quality, not security.
- **Project file** is `<session root>/.claude/routing.json` (`$.session.root()`), so a subagent or a
  shell `cd` elsewhere still finds it; the relative `.claude/routing.json` only when the root is unknown.

## Single source of truth

`policy.json` in the plugin, layered by the user and project files above. The prompt section and
the deny message are both rendered from the merged policy, so the text Claude reads cannot drift
from what the hook enforces. orch reads only the user file's `spawn` key and falls back to
`opus`/`xhigh`, so it has no code dependency on this plugin.

## Log

One JSON line per decision in `~/.claude/state/routing/<YYYY-MM-DD>-<sid>.jsonl` (one file per
session per day, so concurrent sessions never rewrite each other's file). Fields: `ts`, `surface`
(`agent` | `workflow`), `cls`, `model`, `effort`, `override`, `verdict` (`allow` | `deny` |
`exempt` | `filled` | `effort`), `reason`, `outcome`, `subagentType`, `runId`, `agentIndex`, `agentId`,
`label`. A workflow agent's row is written at spawn (with its `agentId`); its effort arrives later as a
second row `{ ts, surface: 'workflow', agentId, verdict: 'effort', effort }` on that agent's first
`turn.step`, joined to the spawn row by `agentId`. A remote agent never steps, so it has the spawn row
alone; at most 500 agents wait for a first step, the oldest dropped. All rows go through one chained
writer, since `$.fs` has no append.
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
