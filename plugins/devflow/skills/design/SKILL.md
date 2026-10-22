---
name: design
description: 'Use when the requirements of a feature are settled and it needs its design, in place of superpowers:brainstorming for that step - devflow:requirements (or `requirements` where the project vendors devflow) handed off with "decisions settled", or the user points at a spec with ## Решения and asks for approaches, architecture, the design doc, "спроектируй", "предложи подходы", "дизайн фичи". Unsettled requirements go to that requirements skill first.'
---

# Design

Turn a settled `## Решения` into a design that a plan can be written from: approaches, the chosen one written into the same spec, a work split, the two delta lines, a canvas when there is UI, the project gate, then the plan.

## Steps

1. **Load the spec.** The path comes in the args; without one, take the newest spec in `specDir` that this session wrote. Read `.claude/devflow.json` at the repo root (in a linked worktree that has none, the one in this repository's main worktree, the first entry of `git worktree list`) for `specDir` (default `docs/specs`), `gate`, `contractsDir` and `analyticsSkill`. Read `## Решения` in full. Settled decisions are inputs: build on them as worded. When the design needs a decision that is missing, ask only that one, as a numbered ❓ question with a ➡️ recommendation worded so "yes" accepts it, and append the answer to `## Решения` before going on.
2. **Learn the code it lands in.** Look up a single file or listing yourself; send real investigation of the files, patterns and contracts the design touches to Agent subagents (with the routing plugin installed: description tagged `[search]`, model `haiku`, effort `low`), then read what they point at. The design follows the codebase's existing patterns.
3. **Approaches.** Propose 2 or 3 genuinely different approaches, each with what it costs and what it buys, your recommendation first, as one ❓ question with ➡️ the recommended one. End your turn on that question: the approach is the user's decision even when one option is plainly best. Their reply settles it; write it into `## Решения` as the next numbered decision, and only then start step 4.
4. **Write `## Дизайн`** below `## Решения`: the chosen approach and why; components, each with one job and a clear boundary; data flow; failure handling; how it is tested; the rejected approaches, one line each. Size each part to its weight.
5. **Write `## Work split`**: a table with one row per kind of work (code, UI, content or static files, migrations and so on) and the columns what, depends on, parallel?, branch. A kind that needs its own owner decision gets its own branch.
6. **Write the two delta lines** under the table, one line each:
   - `**Behavior-contract delta:** <contract file → the section it updates>`, or `none — <why>`. The files in `contractsDir` that cover the touched surface decide it.
   - `**Analytics delta:** <events added: name, properties, trigger>`, or `none — <why>`. When `## Решения` says analytics is needed and `analyticsSkill` is set, run that skill with the Skill tool and write its delta here.
7. **UI branch**, when `## Решения` says the feature changes what a user sees: run the canvas and critique below.
8. **Self-review the spec**: placeholders, sections that contradict each other, a requirement readable two ways, a scope one plan cannot hold. Fix inline.
9. **Gate.** When `devflow.json` has `gate`, do what its text says; it names the project's review step. Without one, give the spec path and a short summary and ask the user to approve. Revise on feedback. The gate passes when the user approves.
10. **Hand off.** Invoke `superpowers:writing-plans` with the Skill tool, args `spec: <path>. Copy its **Behavior-contract delta:** and **Analytics delta:** lines verbatim into the plan header.`

The spec now holds `## Решения`, `## Дизайн` and `## Work split`, which is what the devflow hook checks before it lets code edits through.

## Canvas and critique (UI branch)

A written spec pins down behavior and under-specifies shape: density, hierarchy, the empty list, the phone. Rounds on a canvas cost minutes; the same rounds against built code cost days.

1. Call the Artifact tool with `action: "quickstart"` and `intent: "design"`, and follow what it returns to start the canvas.
2. Paint the real product: colors, type, spacing and components taken from the project's own styles, with enough of the surrounding page to judge the new part in context.
3. Write the copy in the product's language. Copy the user already wrote stays verbatim; its wording often carries a product decision.
4. Boards: desktop, mobile (about 390 wide), the states (empty, loading, error, longest plausible content), and a Before board when the work reshapes something that ships today.
5. Annotate the implementation facts and limits on the canvas: a page size the endpoint hard-codes, a column that does not exist. Check every number you draw against its real source first, because a canvas showing data the system cannot produce gets approved and then cannot be built.
6. Invoke `impeccable:impeccable` with the Skill tool, args `critique <canvas URL or source path>`. Apply its material fixes and republish to the same file path so the URL holds.
7. Put the canvas URL in `## Дизайн`. The gate reviews spec and canvas together; expect correction rounds there and republish to the same path each time.
