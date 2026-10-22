---
name: requirements
description: 'Use when the user wants to work out a new feature or a change to how a product behaves - its requirements, a spec, a design doc - before plans or code, in place of grilling or superpowers:brainstorming when the subject is such a feature. Triggers - "new feature", "grill me" or "brainstorm" about a feature, "requirements", "design doc", "spec", "новая фича", "спроектируем фичу", "давай продумаем фичу". Not for small tweaks (a flag, an option, a one-file change), bug fixes, refactors or questions about existing code.'
---

# Requirements

Draw a feature's requirements out of the user in **rounds**, before anything is designed, and write each decision into the feature's **spec** the moment it is settled. Facts come from the codebase. Decisions come from the user.

## Setup

1. Read `.claude/devflow.json` at the repo root. In a linked worktree that has none, read the one in this repository's main worktree (the first entry of `git worktree list`). Take `specDir`, `contractsDir` and `analyticsSkill` when present. With no file at all, end the turn on one question, where to keep the spec (➡️ `docs/specs`), and create nothing until the user answers; their answer is `specDir` for this spec. Creating `.claude/devflow.json` stays the user's call, because that file switches devflow's hooks on for the repo.
2. Create the spec before round 1: `<specDir>/<YYYY-MM-DD>-<slug>.md`, today's date and a short kebab slug of the feature. It holds a `# <title>` line, one line of goal, and an empty `## Решения`. Only that heading: `## Дизайн` and `## Work split` are devflow:design's, and the devflow hook opens code edits once all three headings are on disk, so writing them early unlocks code before a design exists.
3. Gather the facts round 1 needs (see **Facts**): how the touched area works today, what already exists, which files in `contractsDir` cover it.

Write questions and the spec in the language the user writes in. The three headings stay exactly as written here, since the hook matches them.

## Rounds

The feature is a **design tree**: every decision opens the decisions that hang on it. The **frontier** is every open decision whose prerequisites are settled. A round asks the whole frontier at once, and nothing that waits on an answer still open in that round.

Number each question, give one recommendation, and word the question so "yes" accepts it:

```
❓ **1. <short title>**: <the question; the options, when there are several>

➡️ <recommended answer>, because <one line>

---

❓ **2. <short title>**: …
```

Round 1 always carries these three, beside the rest of the frontier:

- **UI**: does it change what a user sees, and which surfaces? A yes sends devflow:design through a canvas and an impeccable critique.
- **Analytics**: does it need product analytics events, and which decision would they inform? With `analyticsSkill` set, that skill picks the events at design time; here settle only whether.
- **Behavior contracts**: which contracts change? Name the `contractsDir` files that cover the touched surface and recommend; "none" is a valid answer.

When the request bundles independent features, round 1 opens with which one this spec covers; the others get specs of their own.

After each reply:

1. Write every decision it settles into `## Решения` right away with Edit: numbered, one line each, the decision and then why. A "yes" settles the recommendation as worded. A correction replaces the old line.
2. Recompute the frontier. Settled decisions unblock new questions; an answer can also reopen or prune a branch.
3. Ask the next round.

## Facts

How things are today is a fact: look it up, and never ask the user for it. A trivial lookup you do yourself with Glob, Grep or Read: one file, one listing, `devflow.json`, the spec. Real investigation (how an area works, what calls what, which contracts cover a surface, the history behind it) goes to subagents via the Agent tool, so your context stays on the decisions. Independent lookups go out in parallel, in one message.

With the routing plugin installed, each Agent `description` starts with a class tag and the call sets `model` and `effort` at or above that class's floor, or the plugin denies it; without the plugin, the tags are optional:

- `[search]`, model `haiku`, effort `low`: find files, read what exists, list the contracts.
- `[research]`, model `opus`, effort `high`: library or web documentation.

A running subagent holds back only the questions that need its answer; ask the rest of the frontier now.

## Done

The frontier is empty: every branch visited, every decision written in `## Решения`, nothing assumed in silence. Ask once whether the decisions are settled. On yes, invoke `devflow:design` with the Skill tool, args `decisions settled, do not re-ask: <spec path>`.
