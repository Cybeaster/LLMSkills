# orchestrator

One view over every Claude Code session running on this machine.

- Each session keeps a **task pool** through the `orch` CLI and ticks tasks with **evidence** (commit, PR, CI run, a command orch runs itself). CI and PR evidence is rechecked live.
- Sessions spawned by a session (`orch spawn-child`) nest **under the task** that spawned them, read a shared **brief**, and roll their progress and open questions up to the parent.
- `orch tui` shows every session in a herdr pane; `/orch` does the same from your phone over Remote Control and lets you **answer a waiting session** from there.

Design: [DESIGN.md](DESIGN.md). Plan: [PLAN.md](PLAN.md).

## Requirements

- Node 18+ for `bin/orch` and the hooks; Node 20+ for `orch tui` (`package.json` `engines` says `>=18`, the floor of the CLI and the hooks; `orch tui` needs 20).
- `gh` for `pr:` and `ci:` evidence.
- herdr for the TUI's `f` key, for in-pane replies, and for `spawn-child` in a tab.

## Install

```bash
claude plugin marketplace add ~/src/ClaudeSkills     # once
claude plugin install orchestrator@claude-skills
```

Then start (or restart) sessions; each registers itself. `orch` is on PATH only inside Claude's own shell, so for the overview pane add a shell function once (it resolves the highest installed version at call time) and run `orch tui` in a herdr pane of its own:

```bash
orch() { "$(ls -d ~/.claude/plugins/cache/claude-skills/orchestrator/*/ | sort -V | tail -1)bin/orch" "$@"; }
```

If Claude Code's Bash sandbox is on, `orch` inside it cannot see other sessions or write its store: every session shows as ended and `orch plan` fails. `orch` needs to read other sessions' process info and write its store, so it has to be excluded from the sandbox. Be aware of what that means: `orch task done … --evidence cmd:"…"` runs any command, and an excluded `orch *` runs it outside the sandbox, so this opens the sandbox for every session. Put it in your user settings (`~/.claude/settings.json`); project settings are ignored for this key when the sandbox is admin-required:

```json
{ "sandbox": { "excludedCommands": ["orch *"] } }
```

The exclusion does not cover compound calls like `cd x && orch …`.

## TUI keys

| Key | Does |
| --- | --- |
| `↑↓` / `jk` | move (scroll, in a session's pool) |
| `enter` | open the session's pool |
| `esc` / `←` / `h` | back (cancels a picker) |
| `f` | focus the session's herdr pane |
| `o` | show the session's claude.ai link |
| `l` | (list only) attach the session under a parent task |
| `/` | filter: type, `enter` keeps it, `esc` clears it (also clears a kept filter in the list) |
| `r` | refresh now (it refreshes every 3 s) |
| `q` | quit |

## Development

```bash
cd plugins/orchestrator
npm install
npm test && npm run typecheck
npm run build      # bin/orch and lib/orch-tui.mjs are committed: rebuild before committing
npm run check:bundle   # after committing: fails if the committed bundles are stale
```

Pools live in `~/.claude/orchestrator/<sessionId>.json` (`ORCH_HOME` overrides it; the Claude home itself is `ORCH_CLAUDE_HOME`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`); hook errors go to `orch.log` there.
