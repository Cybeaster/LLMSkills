---
name: orch-pool
description: Use at the start of any multi-step task, when a step is finished, when you need the person to decide something, and before fanning work out to other Claude sessions. Keeps this session's task pool in the orch orchestrator current, with evidence, so the person can see every session's progress in one place. Russian - план задач, отметь выполненное, спроси меня, запусти дочернюю сессию.
---

# orch: keep your task pool current

The person runs many Claude sessions at once and follows them through one overview (`orch tui`, `/orch`). Your pool is how they see you. `orch` is on your PATH.

## Three habits

1. **Plan first.** Before real work, write the steps: `orch plan "Create course" "Run audit" "Re-check CI"` and give the session a title once: `orch title "Beginner courses for all languages"`. Running `orch plan` again replaces only the pending steps and keeps finished, started, blocked and asking ones, so list only the steps still to do.
2. **Tick with evidence, as you go.** When a step is done, tick it right away, not in a batch at the end:
   - `orch task done t2 --evidence commit:<sha>`
   - `orch task done t3 --evidence pr:<number>` or `ci:<run-url>` (orch rechecks these live)
   - `orch task done t1 --evidence cmd:"npm test"` (orch runs it in your current directory and refuses a failing one; it stops a command after 110 s, so never use watch modes or servers here, and run longer suites yourself and tick with `commit:`, `ci:` or `note:`)
   - `note:<text>` or no evidence is shown as *claimed*, not done.
   Use `orch task start <id>` when you begin a step and `orch task block <id> "why"` when stuck.
3. **Fan out through orch.** To hand parts to other sessions, write a brief file first (spec, conventions, what to report back), then for each part: `orch spawn-child <taskId> --name <short-name> --cwd <dir> --brief <file> [--model <m>] [--effort <level>]`. Without them the child starts on the `spawn` entry of `~/.claude/routing/policy.json`, else opus / xhigh. Never open child sessions by hand; they would not show under your task.

## When you need the person

Run `orch ask <taskId> "the question"`, then send a push notification with the PushNotification tool naming this session and the question. The person may answer from their phone; the answer arrives as your next prompt, prefixed `[orch reply to: "…"]`.

## If you are a child

Your first context names your parent and brief. Read the brief before anything else, then `orch plan` your part.

`orch status` shows your pool; `orch status --all` shows every session.
