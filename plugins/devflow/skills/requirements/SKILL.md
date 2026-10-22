---
name: requirements
description: 'Use first for any new feature or behavior change in a codebase, before design, plans or code, and in place of grilling or superpowers:brainstorming whenever the thing being grilled or brainstormed is a feature to build. Triggers - "new feature", "build / add / implement X", "grill me", "brainstorm", "requirements", "design doc", "новая фича", "спроектируем фичу", "сделай / добавь", "давай продумаем". Not for bug fixes, refactors or questions about existing code.'
---

# Requirements

Draw a feature's requirements out of the user in **rounds**, before anything is designed, and write each decision into the feature's **spec** the moment it is settled. Facts come from the codebase, found by subagents. Decisions come from the user.

## Setup

1. Read `.claude/devflow.json` at the repo root. In a linked worktree that has none, read the one in this repository's main worktree (the first entry of `git worktree list`). No file means the defaults. Take `specDir` (default `docs/specs`), `contractsDir` and `analyticsSkill` when present.
2. Create the spec before round 1: `<specDir>/<YYYY-MM-DD>-<slug>.md`, today's date and a short kebab slug of the feature. It holds a `# <title>` line, one line of goal, and an empty `## Решения`. Only that heading: `## Дизайн` and `## Work split` are devflow:design's, and the devflow hook opens code edits once all three headings are on disk, so writing them early unlocks code before a design exists.
3. Send fact-finding subagents (see **Facts**) for what round 1 needs: how the touched area works today, what already exists, which files in `contractsDir` cover it. Work from their reports; your own context stays on the decisions.

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
- **Behavior contracts**: which contracts change? Name the `contractsDir` files that cover the touched surface (a subagent finds them) and recommend; "none" is a valid answer.

When the request bundles independent features, round 1 opens with which one this spec covers; the others get specs of their own.

After each reply:

1. Write every decision it settles into `## Решения` right away with Edit: numbered, one line each, the decision and then why. A "yes" settles the recommendation as worded. A correction replaces the old line.
2. Recompute the frontier. Settled decisions unblock new questions; an answer can also reopen or prune a branch.
3. Ask the next round.

## Facts

How things are today is a fact: a subagent looks it up, and the user is never asked it. You read `devflow.json` and the spec yourself; everything else (code, docs, contracts, history, even a directory listing) comes back from a subagent dispatched with the Agent tool, its `description` starting with a routing class tag and its `model` and `effort` set explicitly. Independent lookups go out in parallel, in one message:

- `[search]`, model `haiku`, effort `low`: find files, read what exists, list the contracts.
- `[research]`, model `opus`, effort `high`: library or web documentation.

The routing plugin, when installed, holds Agent calls to these floors. A running subagent holds back only the questions that need its answer; ask the rest of the frontier now.

## Done

The frontier is empty: every branch visited, every decision written in `## Решения`, nothing assumed in silence. Ask once whether the decisions are settled. On yes, invoke `devflow:design` with the Skill tool, args `decisions settled, do not re-ask: <spec path>`.
