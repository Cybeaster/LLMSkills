---
description: Overview of every Claude session with tap-through choices - see pools, answer a waiting session, open it on claude.ai
allowed-tools: Bash(orch status:*), Bash(orch reply:*), AskUserQuestion, ListAgents, SendMessage
---

Show the person every local Claude session and let them act on one. This is used from a phone over Remote Control, so keep each message short and drive everything through AskUserQuestion.

1. Run `orch status --all --json`. It prints a compact tree of rows without their tasks: `sessionId`, `name`, `state` (busy, idle, waiting, ended), `tag`, `done`/`total`, `flags` (open questions in the subtree), `link` and `children`.
2. Ask *Which session?* with AskUserQuestion. Options, at most four: sessions with `flags > 0` first, then waiting, then busy ones; label each `name done/total` plus ` ⚑` when it has flags. The person can type any other session's name through *Other*. If there are no sessions, say so and stop.
3. Run `orch status <sessionId> --json` for the chosen row; it adds `tasks` (each with `mark`, `id`, `text`, `detail`). Print them as a short list (`mark id text — detail`) and the `link` if there is one. Then ask *What now?* with the options **Answer ⚑** (only when one of its tasks has `mark` ⚑; for a parent whose own tasks show no ⚑, find the child under `children` in the step-1 tree with `flags > 0` and use that child's `sessionId` for steps 3–4), **Open session** (only when it has a `link`), **Back**.
4. **Answer ⚑**: if the session has more than one ⚑ task, ask which one first. Ask the person for the answer as free text, then run `orch reply <sessionId> --task <taskId> -- '<answer>'` in single quotes, with every `'` in the answer written as `'\''`, so `$`, backticks and `"` in the answer reach the session literally (always the id, since two sessions can share a name; always `--`, since an answer may start with a dash).
   - exit 0: say it was delivered.
   - exit 3: it printed `{"route":"sendmessage","sessionId":…,"name":…,"cwd":…,"taskId":…,"text":…}`. Find that session with ListAgents: by `sessionId` if the listing shows it, else by `cwd`, else by `name`. Send `text` with SendMessage, then run `orch reply <sessionId> --task <taskId> --mark-only`. If no listed session matches, say so and leave the ⚑ open.
   - any other exit: show the error line.
5. **Open session**: print the link alone on its line so it is tappable.
6. **Back**: return to step 2 with a fresh `orch status --all --json`. Stop when the person picks nothing or says done.
