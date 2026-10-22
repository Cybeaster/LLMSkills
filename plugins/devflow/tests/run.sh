#!/usr/bin/env bash
# Tests for hooks/devflow.sh: temp git repos + config, synthetic hook payloads on stdin, asserted
# output. Self-contained (bash, git, jq). Run: bash plugins/devflow/tests/run.sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
HOOK="$here/../hooks/devflow.sh"
BASH_BIN=$(command -v bash)
T=$(mktemp -d "${TMPDIR:-/tmp}/devflow-test.XXXXXX")
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT

export HOME="$T/home"
export DEVFLOW_STATE_DIR="$T/state"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset CLAUDE_PROJECT_DIR
mkdir -p "$HOME"

pass=0
fail=0
ok() {
	pass=$((pass + 1))
	printf 'ok   %s\n' "$1"
}
bad() {
	fail=$((fail + 1))
	printf 'FAIL %s\n' "$1"
	[ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       /'
}

n=0
new() { # a fresh session id in $S
	n=$((n + 1))
	S="sess-$n"
}

hook() { # hook <mode> <payload> -> $OUT, $RC
	OUT=$(printf '%s' "$2" | "$BASH_BIN" "$HOOK" "$1" 2>>"$T/stderr")
	RC=$?
}

# ---- payloads ------------------------------------------------------------------------------------
p_prompt() { jq -cn --arg s "$S" --arg c "$1" --arg p "$2" '{session_id: $s, cwd: $c, hook_event_name: "UserPromptSubmit", prompt: $p}'; }
p_edit() { # p_edit <cwd> <tool> <path>
	jq -cn --arg s "$S" --arg c "$1" --arg t "$2" --arg f "$3" '{session_id: $s, cwd: $c, hook_event_name: "PreToolUse", tool_name: $t,
		tool_input: (if $t == "NotebookEdit" then {notebook_path: $f, new_source: "x"} else {file_path: $f, content: "x"} end)}'
}
p_skill() { jq -cn --arg s "$S" --arg c "$1" --arg k "$2" --arg a "${3:-}" '{session_id: $s, cwd: $c, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: {skill: $k, args: $a}, tool_response: {}}'; }
p_bash() { jq -cn --arg s "$S" --arg c "$1" --arg x "$2" '{session_id: $s, cwd: $c, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {command: $x}}'; }
p_stop() { jq -cn --arg s "$S" --arg c "$1" --argjson a "${2:-false}" '{session_id: $s, cwd: $c, hook_event_name: "Stop", stop_hook_active: $a}'; }

# ---- assertions ----------------------------------------------------------------------------------
contains_all() { # contains_all <text> <needle>... ; prints the first missing needle
	local t=$1 x
	shift
	for x in "$@"; do
		case "$t" in *"$x"*) ;; *)
			printf '%s' "$x"
			return 1
			;;
		esac
	done
}
one_object() { printf '%s' "$1" | jq -se 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1; }

silent() { # silent <name> <mode> <payload>
	hook "$2" "$3"
	if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then ok "$1"; else bad "$1" "rc=$RC out=$OUT"; fi
}
denies() { # denies <name> <payload> <needle>... (PreToolUse deny whose reason has every needle)
	local name=$1 payload=$2 miss
	shift 2
	hook "$MODE" "$payload"
	if [ "$RC" -ne 0 ] || ! one_object "$OUT" ||
		[ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput | "\(.hookEventName)/\(.permissionDecision)"')" != PreToolUse/deny ]; then
		bad "$name" "rc=$RC out=$OUT"
		return
	fi
	miss=$(contains_all "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason')" "$@") || {
		bad "$name" "reason lacks '$miss': $OUT"
		return
	}
	ok "$name"
}
context() { # context <name> <event> <mode> <payload> <needle>...
	local name=$1 ev=$2 mode=$3 payload=$4 miss
	shift 4
	hook "$mode" "$payload"
	if [ "$RC" -ne 0 ] || ! one_object "$OUT" ||
		[ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')" != "$ev" ]; then
		bad "$name" "rc=$RC out=$OUT"
		return
	fi
	miss=$(contains_all "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')" "$@") || {
		bad "$name" "context lacks '$miss': $OUT"
		return
	}
	ok "$name"
}
blocks() { # blocks <name> <payload>
	hook stop "$2"
	if [ "$RC" -eq 0 ] && one_object "$OUT" && [ "$(printf '%s' "$OUT" | jq -r '.decision')" = block ] &&
		contains_all "$(printf '%s' "$OUT" | jq -r '.reason')" "impeccable:impeccable" "critique" >/dev/null; then
		ok "$1"
	else
		bad "$1" "rc=$RC out=$OUT"
	fi
}
lacks() { # lacks <name> <needle>: the last $OUT does not contain needle
	case "$OUT" in *"$2"*) bad "$1" "unexpected '$2' in: $OUT" ;; *) ok "$1" ;; esac
}
check() { # check <name> <command...>
	local name=$1
	shift
	if "$@" >/dev/null; then ok "$name"; else bad "$name"; fi
}

# ---- fixtures ------------------------------------------------------------------------------------
mkrepo() { # mkrepo <dir> [config json]
	mkdir -p "$1"
	git -C "$1" init -q 2>/dev/null
	git -C "$1" commit -q --allow-empty -m init
	if [ $# -ge 2 ]; then
		mkdir -p "$1/.claude"
		printf '%s\n' "$2" >"$1/.claude/devflow.json"
	fi
}
spec() { # spec <file> <sections...>: write a spec with the named sections (req, design, split)
	local f=$1 s
	shift
	mkdir -p "$(dirname "$f")"
	printf '# Export\n\nGoal: export reports as CSV.\n' >"$f"
	for s in "$@"; do
		case "$s" in
		req) printf '\n## Решения\n\n1. CSV only, UTF-8.\n' >>"$f" ;;
		design) printf '\n## Дизайн\n\nA streaming endpoint.\n' >>"$f" ;;
		split) printf '\n## Work split\n\n| what | depends on | parallel? | branch |\n|---|---|---|---|\n| api | - | yes | export-api |\n\n**Behavior-contract delta:** none — new surface.\n**Analytics delta:** none — no funnel.\n' >>"$f" ;;
		esac
	done
}

CFG='{"specDir":"docs/specs","codePaths":["webapp/","api"],"uiPaths":["webapp/components/","webapp/app/"],
"uiExtensions":[".tsx",".css"],"worktreeDir":".worktrees","analyticsSkill":"acme-analytics-events",
"gate":"Read docs/gate.md and follow it","contractsDir":"docs/behavior"}'
R="$T/repo"
mkrepo "$R" "$CFG"
FEATURE="Add a CSV export to the reports page"

# ==================================================================================================
echo "# no config: every mode is silent"
N="$T/noconf"
mkrepo "$N"
new
silent "no config: feature prompt" prompt "$(p_prompt "$N" "$FEATURE")"
silent "no config: requirements skill" skill "$(p_skill "$N" devflow:requirements)"
silent "no config: writing-plans skill" skill "$(p_skill "$N" superpowers:writing-plans)"
silent "no config: code edit after a feature prompt" edit "$(p_edit "$N" Edit "$N/webapp/lib/x.ts")"
silent "no config: UI edit" edit "$(p_edit "$N" Write "$N/webapp/components/A.tsx")"
silent "no config: stop after a UI edit" stop "$(p_stop "$N")"
silent "no config: worktree outside the repo" bash "$(p_bash "$N" "git worktree add /tmp/elsewhere")"
check "no config: no state written" test ! -e "$DEVFLOW_STATE_DIR/$S.json"
P="$T/plain"
mkdir -p "$P/.claude"
printf '%s\n' "$CFG" >"$P/.claude/devflow.json"
silent "not a git repo: feature prompt" prompt "$(p_prompt "$P" "$FEATURE")"

# ==================================================================================================
echo "# fail open"
new
for m in prompt skill edit bash stop; do
	silent "garbage stdin ($m)" "$m" 'not json {'
	silent "empty stdin ($m)" "$m" ''
	silent "JSON array stdin ($m)" "$m" '[1,2]'
	silent "no session_id ($m)" "$m" "$(jq -cn --arg c "$R" '{cwd: $c, prompt: "add a page", tool_input: {file_path: "webapp/x.ts", skill: "devflow:requirements", command: "git worktree add /tmp/x"}}')"
done
silent "unsafe session_id" prompt "$(jq -cn --arg c "$R" '{session_id: "../../x", cwd: $c, prompt: "add a page"}')"
silent "missing cwd dir" prompt "$(jq -cn '{session_id: "s-x", cwd: "/nonexistent/dir", prompt: "add a page"}')"
silent "unknown mode" bogus "$(p_prompt "$R" "$FEATURE")"
OUT=$(printf '%s' "$(p_prompt "$R" "$FEATURE")" | PATH=/nonexistent "$BASH_BIN" "$HOOK" prompt 2>/dev/null)
RC=$?
check "no jq on PATH: silent exit 0" test "$RC" -eq 0 -a -z "$OUT"
B="$T/badconf"
mkrepo "$B"
mkdir -p "$B/.claude"
printf '{not json\n' >"$B/.claude/devflow.json"
silent "broken config JSON" prompt "$(p_prompt "$B" "$FEATURE")"
printf '["docs/specs"]\n' >"$B/.claude/devflow.json"
silent "config not an object" prompt "$(p_prompt "$B" "$FEATURE")"
new
mkdir -p "$DEVFLOW_STATE_DIR"
printf 'garbage' >"$DEVFLOW_STATE_DIR/$S.json"
context "corrupt state file: still arms" UserPromptSubmit prompt "$(p_prompt "$R" "$FEATURE")" "devflow:requirements"
check "corrupt state file: rewritten as JSON" jq -e '.armed == true' "$DEVFLOW_STATE_DIR/$S.json"

# ==================================================================================================
echo "# prompt: anchored feature regex"
for p in "$FEATURE" \
	"implement X and fix Y" \
	"Build a settings panel for notifications" \
	"We need a new feature: saved searches" \
	"Сделай новую страницу профиля" \
	"Добавь экспорт отчётов в CSV" \
	"давай реализуем выгрузку" \
	"Новая фича: избранные вопросы" \
	"спроектируем фичу поиска" \
	"Let's brainstorm the onboarding flow" \
	"write a design doc for the billing page"; do
	new
	context "arms: $p" UserPromptSubmit prompt "$(p_prompt "$R" "$p")" \
		"devflow:requirements → devflow:design (not grilling / superpowers:brainstorming)" "webapp/, api" "docs/specs/"
done
for p in "fix the login redirect" \
	"Fix: add a null check in the parser" \
	"how do I add a route?" \
	"What would it take to build X?" \
	"why does the build add 2MB" \
	"Почему не работает добавление в избранное" \
	"Как добавить кнопку?" \
	"Что сделать с этим хуком?" \
	"Исправь и добавь лог" \
	"add a unit test for the parser" \
	"Добавь тесты для парсера" \
	"implement the missing tests" \
	"explain this file" \
	"run the linter"; do
	new
	silent "does not arm: $p" prompt "$(p_prompt "$R" "$p")"
	silent "not armed, code edit allowed: $p" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
done
new
hook prompt "$(p_prompt "$R" "$FEATURE")"
silent "arms once: second feature prompt is silent" prompt "$(p_prompt "$R" "Add another panel")"

# ==================================================================================================
echo "# edit: spec gate"
MODE=edit
new
silent "not armed: code edit allowed" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
hook prompt "$(p_prompt "$R" "$FEATURE")"
denies "armed, no spec: code edit denied" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "webapp/lib/x.ts" "no spec yet" "devflow:requirements"
denies "armed, no spec: Write denied too" "$(p_edit "$R" Write "$R/webapp/lib/new.ts")" "no spec yet"
denies "armed, no spec: codePath without a slash" "$(p_edit "$R" Edit "$R/api/server.js")" "api/server.js"
silent "armed: a sibling of a codePath is free" edit "$(p_edit "$R" Edit "$R/apiary/x.js")"
silent "armed: README is free" edit "$(p_edit "$R" Edit "$R/README.md")"
silent "armed: docs are free" edit "$(p_edit "$R" Write "$R/docs/notes.md")"
mkdir -p "$R/docs/specs"
spec "$R/docs/specs/2026-01-01-other.md" req design split
denies "a complete spec from another session does not unlock" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "no spec yet"
silent "a non-markdown file in specDir is not a spec" edit "$(p_edit "$R" Write "$R/docs/specs/diagram.png")"
denies "... and does not unlock" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "no spec yet"
SP="$R/docs/specs/2026-10-22-csv-export.md"
silent "writing the spec (relative path) is allowed" edit "$(p_edit "$R" Write "docs/specs/2026-10-22-csv-export.md")"
check "the spec path is remembered" jq -e --arg p "$SP" '.spec == $p' "$DEVFLOW_STATE_DIR/$S.json"
denies "spec remembered but not on disk" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "docs/specs/2026-10-22-csv-export.md" "not on disk"
spec "$SP"
denies "empty spec: denied naming all three sections" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "## Решения" "## Дизайн" "## Work split" "devflow:requirements"
spec "$SP" req
denies "spec with ## Решения only: names the two missing" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "missing ## Дизайн, ## Work split" "devflow:design"
lacks "... and not the present one" "missing ## Решения"
spec "$SP" req design
denies "spec without ## Work split" "$(p_edit "$R" Write "$R/webapp/lib/x.ts")" "missing ## Work split"
spec "$SP" req design split
silent "complete spec: Edit allowed" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
silent "complete spec: Write allowed" edit "$(p_edit "$R" Write "$R/webapp/lib/y.ts")"
silent "complete spec: MultiEdit allowed" edit "$(p_edit "$R" MultiEdit "$R/api/server.js")"
silent "complete spec: NotebookEdit allowed" edit "$(p_edit "$R" NotebookEdit "$R/webapp/nb.ipynb")"
mv "$SP" "$SP.bak"
denies "spec checked on disk at that moment (removed again)" "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")" "not on disk"
mv "$SP.bak" "$SP"
mkdir -p "$R/webapp"
new
hook prompt "$(p_prompt "$R/webapp" "$FEATURE")"
denies "cwd in a subdirectory, relative path" "$(p_edit "$R/webapp" Edit "lib/x.ts")" "webapp/lib/x.ts"
O="$T/other"
mkrepo "$O"
silent "armed: a file in an unrelated repo is not judged" edit "$(p_edit "$R" Edit "$O/webapp/lib/x.ts")"
new
hook prompt "$(p_prompt "$R" "$FEATURE")"
silent "[no-devflow] waives" prompt "$(p_prompt "$R" "it is a one-liner [no-devflow]")"
silent "waived: code edit allowed" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
silent "waived: a later feature prompt does not re-arm" prompt "$(p_prompt "$R" "$FEATURE")"
silent "waived: still allowed" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
NC="$T/nocode"
mkrepo "$NC" '{"uiPaths":["src/ui/"]}'
new
hook prompt "$(p_prompt "$NC" "$FEATURE")"
silent "no codePaths: the gate is off" edit "$(p_edit "$NC" Edit "$NC/src/lib/x.ts")"

# ==================================================================================================
echo "# UI edit -> stop -> critique"
new
silent "UI edit is allowed (not armed)" edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
blocks "stop blocks after a UI edit" "$(p_stop "$R")"
silent "stop_hook_active: no loop" stop "$(p_stop "$R" true)"
blocks "still uncritiqued: the next stop blocks again" "$(p_stop "$R")"
silent "impeccable critique (Skill)" skill "$(p_skill "$R" impeccable:impeccable "critique webapp/components/Button.tsx")"
silent "stop free after the critique" stop "$(p_stop "$R")"
new
hook edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
hook stop "$(p_stop "$R")"
hook skill "$(p_skill "$R" impeccable:impeccable "critique the button")"
hook edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
silent "block -> critique -> fixes: the continuation stop is free" stop "$(p_stop "$R" true)"
silent "... and the fixes count as critiqued" stop "$(p_stop "$R")"
new
hook skill "$(p_skill "$R" impeccable:impeccable "critique the button")"
hook edit "$(p_edit "$R" Write "$R/webapp/app/page.css")"
blocks "a critique before the UI edit is stale" "$(p_stop "$R")"
new
hook edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
hook skill "$(p_skill "$R" impeccable:impeccable "polish webapp/components")"
blocks "impeccable without critique does not count" "$(p_stop "$R")"
new
hook edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
hook skill "$(p_skill "$R" impeccable "critique header")"
silent "unqualified impeccable skill with critique counts" stop "$(p_stop "$R")"
new
hook edit "$(p_edit "$R" Edit "$R/webapp/components/Button.tsx")"
silent "user-typed /impeccable critique" prompt "$(p_prompt "$R" "/impeccable critique the header")"
silent "... counts as a critique" stop "$(p_stop "$R")"
new
hook edit "$(p_edit "$R" Edit "$R/webapp/components/util.ts")"
silent "UI path with a non-UI extension: stop free" stop "$(p_stop "$R")"
hook edit "$(p_edit "$R" Edit "$R/webapp/lib/Thing.tsx")"
silent "UI extension outside uiPaths: stop free" stop "$(p_stop "$R")"
new
hook edit "$(p_edit "$NC" Edit "$NC/src/ui/Any.vue")"
blocks "no uiExtensions: every file under uiPaths counts" "$(p_stop "$NC")"
NU="$T/noui"
mkrepo "$NU" '{"codePaths":["src/"]}'
new
hook edit "$(p_edit "$NU" Edit "$NU/src/components/A.tsx")"
silent "no uiPaths: stop never blocks" stop "$(p_stop "$NU")"

# ==================================================================================================
echo "# skill: stamps and analytics reminders"
new
context "requirements start: analytics reminder" PostToolUse skill "$(p_skill "$R" devflow:requirements)" "acme-analytics-events" "Analytics delta"
silent "design start: silent" skill "$(p_skill "$R" devflow:design "decisions settled")"
hook edit "$(p_edit "$R" Write "$SP")"
context "writing-plans: both delta lines + analytics" PostToolUse skill "$(p_skill "$R" superpowers:writing-plans)" \
	"Behavior-contract delta" "Analytics delta" "acme-analytics-events" "docs/specs/2026-10-22-csv-export.md"
context "executing-plans: hand-off reminder" PostToolUse skill "$(p_skill "$R" superpowers:executing-plans)" "Analytics delta" "acme-analytics-events"
context "subagent-driven-development: hand-off reminder" PostToolUse skill "$(p_skill "$R" superpowers:subagent-driven-development)" "Behavior-contract delta"
hook skill "$(p_skill "$R" impeccable:impeccable "critique x")"
silent "unrelated skill: silent" skill "$(p_skill "$R" superpowers:systematic-debugging)"
check "stamps are plain integer milliseconds" jq -e '[.requirements_at, .design_at, .plan_at, .critique_at]
	| all(type == "number" and . == floor and . > 1000000000000 and . < 100000000000000)' "$DEVFLOW_STATE_DIR/$S.json"
NA="$T/noanalytics"
mkrepo "$NA" '{"codePaths":["src/"]}'
new
silent "no analyticsSkill: requirements start is silent" skill "$(p_skill "$NA" devflow:requirements)"
context "no analyticsSkill: writing-plans still asks for the delta lines" PostToolUse skill "$(p_skill "$NA" writing-plans)" "Behavior-contract delta" "Analytics delta"
lacks "... without naming an analytics skill" "run the"

# ==================================================================================================
echo "# bash: worktree hygiene"
MODE=bash
new
silent "worktree under .worktrees/" bash "$(p_bash "$R" "git worktree add .worktrees/feat -b feat")"
silent "options before the path" bash "$(p_bash "$R" "git worktree add -b feat --lock .worktrees/feat main")"
silent "absolute path under .worktrees/" bash "$(p_bash "$R" "git -C $R worktree add $R/.worktrees/x")"
silent "redirections are not the path" bash "$(p_bash "$R" "git worktree add .worktrees/x 2>&1 | tail -1")"
silent "no path at all" bash "$(p_bash "$R" "git worktree add -h 2>&1")"
silent "git worktree list" bash "$(p_bash "$R" "git worktree list --porcelain")"
silent "unrelated command" bash "$(p_bash "$R" "git status && echo worktree")"
denies "worktree in /tmp denied" "$(p_bash "$R" "git worktree add /tmp/feat")" "$R/.worktrees/" "$R/.worktrees/feat"
denies "worktree beside the repo denied" "$(p_bash "$R" "git worktree add -b feat ../feat")" "$R/.worktrees/"
denies ".worktrees itself denied" "$(p_bash "$R" "git worktree add .worktrees")" "$R/.worktrees/"
denies "dot-dot escape denied" "$(p_bash "$R" "git worktree add .worktrees/../escape")" "$R/.worktrees/"
denies "second command in a chain is checked" "$(p_bash "$R" "git fetch && git worktree add ~/wt/feat")" "$R/.worktrees/"
denies "-C changes the base" "$(p_bash "$R" "git -C /tmp worktree add x")" "$R/.worktrees/"
silent "from a subdirectory: ../.worktrees/x" bash "$(p_bash "$R/webapp" "git worktree add ../.worktrees/x")"
denies "from a subdirectory: .worktrees/x lands in webapp/" "$(p_bash "$R/webapp" "git worktree add .worktrees/x")" "$R/.worktrees/"
CW="$T/customwt"
mkrepo "$CW" '{"worktreeDir":"wt/"}'
silent "custom worktreeDir allowed" bash "$(p_bash "$CW" "git worktree add wt/feat")"
denies "custom worktreeDir: .worktrees denied" "$(p_bash "$CW" "git worktree add .worktrees/feat")" "$CW/wt/"

# ==================================================================================================
echo "# worktrees: main config, own config"
M="$T/main"
mkrepo "$M" "$CFG" # config is untracked, so a worktree does not get it
git -C "$M" worktree add -q "$M/.worktrees/feat" -b feat 2>/dev/null
W="$M/.worktrees/feat"
check "fixture: the worktree has no config of its own" test ! -e "$W/.claude/devflow.json"
new
context "worktree session finds the main config" UserPromptSubmit prompt "$(p_prompt "$W" "$FEATURE")" "docs/specs/"
MODE=edit
denies "worktree: code edit gated" "$(p_edit "$W" Edit "$W/webapp/lib/x.ts")" "webapp/lib/x.ts" "no spec yet"
denies "worktree: an edit in the main checkout is judged too" "$(p_edit "$W" Edit "$M/webapp/lib/x.ts")" "webapp/lib/x.ts"
spec "$W/docs/specs/2026-10-22-csv-export.md" req design split
hook edit "$(p_edit "$W" Write "$W/docs/specs/2026-10-22-csv-export.md")"
silent "worktree: complete spec in the worktree unlocks" edit "$(p_edit "$W" Edit "$W/webapp/lib/x.ts")"
MODE=bash
silent "worktree session: new worktree under the main .worktrees/" bash "$(p_bash "$W" "git worktree add $M/.worktrees/y")"
denies "worktree session: nested .worktrees/ denied" "$(p_bash "$W" "git worktree add .worktrees/y")" "$M/.worktrees/"
mkdir -p "$W/.claude"
printf '{"specDir":"design/","codePaths":["src/"]}\n' >"$W/.claude/devflow.json"
new
context "a worktree's own config wins" UserPromptSubmit prompt "$(p_prompt "$W" "$FEATURE")" "design/" "src/"

# ==================================================================================================
echo "# environment"
new
OUT=$(jq -cn --arg s "$S" '{session_id: $s, prompt: "Add a CSV export"}' | CLAUDE_PROJECT_DIR="$R" "$BASH_BIN" "$HOOK" prompt 2>/dev/null)
check "no cwd in the payload: CLAUDE_PROJECT_DIR is used" contains_all "$OUT" "devflow:requirements" >/dev/null
check "state lives in DEVFLOW_STATE_DIR" test -s "$DEVFLOW_STATE_DIR/$S.json"
check "nothing written under HOME" test ! -e "$HOME/.claude"
check "nothing written into the repo" test -z "$(find "$R" -name 'sess-*' -o -name '*.lock' -o -name '.tmp.*')"
check "no stderr from any hook run" test ! -s "$T/stderr"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
