# LLMSkills

A collection of agent skills, packaged as a plugin for **both Claude Code and Codex**.

The skills themselves are plain [`SKILL.md`](https://github.com/openai/codex/blob/main/docs/skills.md)
directories — prose instructions, no agent-specific syntax — so the same files serve either
agent. Only the packaging differs, and both manifests sit side by side.

## Structure

```
.claude-plugin/marketplace.json     # marketplace manifest — Claude Code
.agents/plugins/marketplace.json    # marketplace manifest — Codex
plugins/
  devflow/                          # requirements → design → plan, gated by hooks
  learning-skills/
    .claude-plugin/plugin.json      # plugin manifest — Claude Code
    .codex-plugin/plugin.json       # plugin manifest — Codex
    skills/                         # read by BOTH; nothing is duplicated
      project-mentor/               # mentors a beginner through their first project
      explain-this-project/         # explains an unfamiliar codebase from zero
  orchestrator/                     # task pools, child sessions, TUI, /orch
  routing/                          # model + effort policy for delegated work
  writing-skills/
    .claude-plugin/plugin.json
    .codex-plugin/plugin.json
    skills/
      ru-style/                     # writes, checks, fixes and scores Russian text (Пиши, сокращай + ru-text)
```

`plugins/<name>/skills/<skill>/SKILL.md` is where Claude Code's plugin format and Codex's
compatibility layout *both* look for skills, so the tree needs no per-agent copy.

## Install

**Claude Code**

```
/plugin marketplace add Cybeaster/LLMSkills
/plugin install learning-skills@claude-skills
/plugin install writing-skills@claude-skills
```

**Codex**

```
codex plugin marketplace add Cybeaster/LLMSkills
codex plugin add learning-skills@llm-skills
codex plugin add writing-skills@llm-skills
```

The marketplace *names* differ (`claude-skills` vs `llm-skills`) because each agent reads its
own manifest; the repository argument is the same.

**npx skills, any agent**

The [`skills`](https://github.com/vercel-labs/skills) CLI installs a single skill straight from
this repository into Claude Code, Codex and the other agents it supports:

```
npx skills add Cybeaster/LLMSkills --list              # every skill in the repository
npx skills add Cybeaster/LLMSkills --skill ru-style -g # one skill, for your user
npx skills update -g                                   # later: pull the latest version
```

Without `-g` the skill goes into the current project. The CLI asks which agents to install into;
`-a claude-code` (or `-a codex`) picks one and skips the question.

**Without a plugin, either agent**

Each skill is a self-contained directory, so it can also be copied straight in:

```
cp -R plugins/learning-skills/skills/project-mentor ~/.claude/skills/   # Claude Code
cp -R plugins/learning-skills/skills/project-mentor ~/.codex/skills/    # Codex
```

Restart the agent, then `/skills` lists it. Both agents use that same command.

## Adding a new plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json` and
   `plugins/<plugin-name>/.codex-plugin/plugin.json`.
2. Add skills under `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`.
3. Register the plugin in **both** `.claude-plugin/marketplace.json` and
   `.agents/plugins/marketplace.json`.
4. Check the result: `claude plugin validate .`, and for Codex add the local directory as a
   marketplace (`codex plugin marketplace add .`) then confirm `codex plugin list` shows it.

## Adding a new skill

Keep `SKILL.md` agent-neutral — no `~/.claude/` paths, no `CLAUDE.md` or `AGENTS.md`
references, no agent-specific tool names or slash commands. A skill written that way installs
into either agent unchanged, which is the whole point of the layout above.

## License

MIT — see [LICENSE](LICENSE).
