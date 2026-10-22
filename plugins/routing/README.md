# routing

Picks the model and effort for work Claude delegates, by task class.

- **Agent calls** must start `description` with a class tag (`[search]`, `[mechanical]`, `[implement]`,
  `[content]`, `[review]`, `[design]`, `[research]`) and pass `model` + `effort` at or above that class's
  minimum. Anything else is denied with the table, and Claude retries. `fork` is exempt.
- **Workflow agents** without a model get `workflowModel`; every one is logged, with the effort it ran at.
- **Claude sees the table** as a system-prompt section generated from the policy, so it never drifts.
- **Subagents see it too**: each new subagent, teammate and workflow agent gets a `[routing]` line before its task, naming its own class, model and effort and the floors it must follow if it delegates.
- **orch** children start on the `spawn` model and effort (orchestrator ≥ 0.1.1).

| Tag | Model (min) | Effort (min) |
| --- | --- | --- |
| `[search]` | haiku | low |
| `[mechanical]` | haiku | medium |
| `[implement]` | opus | high |
| `[content]` | opus | xhigh |
| `[review]` | fable | xhigh |
| `[design]` | fable | xhigh |
| `[research]` | opus | high |

`[override]` next to the tag lets a call go below its minimum or use `max`; Claude adds it only when
you asked for that model or effort, and the log records it.

## Change the table

Layer a partial file over the defaults in `policy.json`:

- `~/.claude/routing/policy.json`: yours, every project
- `<repo>/.claude/routing.json`: one project

```json
{ "classes": { "search": { "model": "opus" } }, "spawn": { "effort": "high" } }
```

A value that is not on the ladders (`haiku < sonnet < opus < fable`, `low < medium < high < xhigh < max`)
is ignored, so a typo never weakens a floor. A floor of `max` can only be met with `[override]`.

## Read the log

```bash
cat ~/.claude/state/routing/*.jsonl | jq -s 'group_by(.cls) | map({cls: .[0].cls, n: length, denied: map(select(.verdict == "deny")) | length})'
```

## Install

```
/plugin install routing@claude-skills
```
