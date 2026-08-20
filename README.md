# ClaudeLearningSkills

Kirill's collection of Claude Code plugins and skills, organized as a plugin marketplace.

## Structure

```
.claude-plugin/marketplace.json   # marketplace manifest listing all plugins
plugins/
  learning-skills/                # plugin: skills for learning to code
    .claude-plugin/plugin.json
    skills/
      project-mentor/             # mentors a beginner through building their first project
      explain-this-project/       # explains an unfamiliar codebase from zero
```

Each plugin lives in its own directory under `plugins/` with a `.claude-plugin/plugin.json` manifest and its skills under `skills/`.

## Install

```
/plugin marketplace add <path-or-github-repo>
/plugin install learning-skills@kirill-skills
```

## Adding a new plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json`.
2. Add skills under `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`.
3. Register the plugin in `.claude-plugin/marketplace.json`.
4. Run `claude plugin validate .` to check the result.
