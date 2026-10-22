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
p_end() { jq -cn --arg s "$S" --arg c "$1" '{session_id: $s, cwd: $c, hook_event_name: "SessionEnd", reason: "other"}'; }

arm() { hook skill "$(p_skill "$1" "${2:-devflow:requirements}")"; } # start the feature flow in $S
age() {                                                               # age <field> <minutes>: move a stamp into the past
	local f="$DEVFLOW_STATE_DIR/$S.json" t
	t=$(jq --arg k "$1" --argjson m "$2" '.[$k] = (.[$k] - $m * 60000)' "$f") && printf '%s\n' "$t" >"$f"
}

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
silent "no config: code edit after the flow starts" edit "$(p_edit "$N" Edit "$N/webapp/lib/x.ts")"
silent "no config: UI edit" edit "$(p_edit "$N" Write "$N/webapp/components/A.tsx")"
silent "no config: stop after a UI edit" stop "$(p_stop "$N")"
silent "no config: worktree outside the repo" bash "$(p_bash "$N" "git worktree add /tmp/elsewhere")"
silent "no config: session end" end "$(p_end "$N")"
check "no config: no state written" test ! -e "$DEVFLOW_STATE_DIR/$S.json"
P="$T/plain"
mkdir -p "$P/.claude"
printf '%s\n' "$CFG" >"$P/.claude/devflow.json"
silent "not a git repo: feature prompt" prompt "$(p_prompt "$P" "$FEATURE")"

# ==================================================================================================
echo "# fail open"
new
for m in prompt skill edit bash stop end; do
	silent "garbage stdin ($m)" "$m" 'not json {'
	silent "empty stdin ($m)" "$m" ''
	silent "JSON array stdin ($m)" "$m" '[1,2]'
	silent "no session_id ($m)" "$m" "$(jq -cn --arg c "$R" '{cwd: $c, prompt: "add a page", tool_input: {file_path: "webapp/x.ts", skill: "devflow:requirements", command: "git worktree add /tmp/x"}}')"
done
silent "unsafe session_id" prompt "$(jq -cn --arg c "$R" '{session_id: "../../x", cwd: $c, prompt: "add a page"}')"
silent "unsafe session_id (end)" end "$(jq -cn --arg c "$R" '{session_id: "../state", cwd: $c}')"
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
context "corrupt state file: still nudges" UserPromptSubmit prompt "$(p_prompt "$R" "$FEATURE")" "devflow:requirements"
check "corrupt state file: rewritten as JSON" jq -e '.nudged_at > 0' "$DEVFLOW_STATE_DIR/$S.json"

# ==================================================================================================
echo "# prompt: a nudge, never an arm"
for p in "$FEATURE" \
	"implement X and fix Y" \
	"Can you build a settings panel for notifications" \
	"We need a new feature: saved searches" \
	"Сделай новую страницу профиля" \
	"Добавь экспорт отчётов в CSV" \
	"давай реализуем выгрузку" \
	"Новая фича: избранные вопросы" \
	"спроектируем фичу поиска" \
	"Let's brainstorm the onboarding flow" \
	"write a design doc for the billing page"; do
	new
	context "nudges: $p" UserPromptSubmit prompt "$(p_prompt "$R" "$p")" \
		"devflow:requirements → devflow:design (not grilling / superpowers:brainstorming)" "Project gate: Read docs/gate.md and follow it"
	silent "nudge does not arm: $p" edit "$(p_edit "$R" Edit "$R/webapp/lib/x.ts")"
done
for p in "fix the login redirect" \
	"Fix: add a null check in the parser" \
	"Фикс: добавь проверку на null" \
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
	"commit and push" \
	"push the branch and add a changelog line" \
	"add a PR description and open the PR" \
	"merge development into master" \
	"rebase onto master and add the fixup" \
	"build the webapp and add the output to the report" \
	"run the linter" \
	"deploy to dev and add a note" \
	"review the diff and add comments" \
	"screenshot the new page" \
	"log in as admin and add a user" \
	"Сделай коммит и запушь" \
	"Добавь это в ветку dev" \
	"Сделай ревью этого PR" \
	"Добавь лог в обработчик" \
	"сделай скриншот страницы" \
	"implement the plan in docs/plans/x.md" \
	"Now execute the plan" \
	"выполни план"; do
	new
	silent "no nudge: $p" prompt "$(p_prompt "$R" "$p")"
done
new
hook prompt "$(p_prompt "$R" "$FEATURE")"
silent "a second feature prompt within 30 min is quiet" prompt "$(p_prompt "$R" "Add another panel")"
age nudged_at 31
context "after 30 min a feature prompt is nudged again" UserPromptSubmit prompt "$(p_prompt "$R" "Add another panel")" "devflow:requirements"
NG="$T/nogate"
mkrepo "$NG" '{"codePaths":["src/"]}'
new
context "no gate configured: nudge" UserPromptSubmit prompt "$(p_prompt "$NG" "$FEATURE")" "devflow:requirements"
lacks "... without a Project gate line" "Project gate"

# ==================================================================================================
echo "# arming: only when the feature flow starts"
MODE=edit
G="$T/gate"
mkrepo "$G" "$CFG"
new
hook prompt "$(p_prompt "$G" "$FEATURE")"
silent "a feature prompt alone leaves code free" edit "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")"
context "devflow:requirements arms" PostToolUse skill "$(p_skill "$G" devflow:requirements)" \
	"armed" "webapp/, api" "docs/specs/" "Project gate: Read docs/gate.md and follow it" "acme-analytics-events"
denies "armed by requirements: code edit denied" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "no spec yet"
hook skill "$(p_skill "$G" devflow:design "decisions settled")"
lacks "already armed: design adds no second arming note" "Project gate"
new
context "devflow:design arms" PostToolUse skill "$(p_skill "$G" devflow:design)" "armed" "Project gate:"
denies "armed by design: code edit denied" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "no spec yet"
AR="$T/arming"
mkrepo "$AR" '{"codePaths":["src/"],"armingSkills":["itabyss-brainstorm","itabyss-brainstorm-design"],"gate":"Open the Notion gate"}'
new
context "armingSkills: a project wrapper arms" PostToolUse skill "$(p_skill "$AR" itabyss-brainstorm)" "armed" "Project gate: Open the Notion gate"
denies "armed by the wrapper: code edit denied" "$(p_edit "$AR" Edit "$AR/src/x.ts")" "no spec yet"
new
context "armingSkills: a namespaced name arms too" PostToolUse skill "$(p_skill "$AR" proj:itabyss-brainstorm-design)" "armed"
new
silent "a skill not listed does not arm" skill "$(p_skill "$AR" superpowers:systematic-debugging)"
silent "... code stays free" edit "$(p_edit "$AR" Edit "$AR/src/x.ts")"
new
arm "$G"
silent "[no-devflow] disarms" prompt "$(p_prompt "$G" "it is a one-liner [no-devflow]")"
silent "waived: code edit allowed" edit "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")"
silent "waived: a feature prompt neither nudges nor arms" prompt "$(p_prompt "$G" "$FEATURE")"
silent "waived: still allowed" edit "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")"
context "starting the flow again re-arms" PostToolUse skill "$(p_skill "$G" devflow:requirements)" "armed"
denies "... and the gate is back" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "no spec yet"

# ==================================================================================================
echo "# edit: spec gate"
new
silent "not armed: code edit allowed" edit "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")"
arm "$G"
denies "armed, no spec: code edit denied" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "webapp/lib/x.ts" "no spec yet" "devflow:requirements"
denies "armed, no spec: Write denied too" "$(p_edit "$G" Write "$G/webapp/lib/new.ts")" "no spec yet"
denies "armed, no spec: codePath without a slash" "$(p_edit "$G" Edit "$G/api/server.js")" "api/server.js"
silent "armed: a sibling of a codePath is free" edit "$(p_edit "$G" Edit "$G/apiary/x.js")"
silent "armed: README is free" edit "$(p_edit "$G" Edit "$G/README.md")"
silent "armed: docs are free" edit "$(p_edit "$G" Write "$G/docs/notes.md")"
silent "a non-markdown file in specDir is not a spec" edit "$(p_edit "$G" Write "$G/docs/specs/diagram.png")"
denies "... and does not unlock" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "no spec yet"
SP="$G/docs/specs/2026-10-22-csv-export.md"
silent "writing the spec (relative path) is allowed" edit "$(p_edit "$G" Write "docs/specs/2026-10-22-csv-export.md")"
check "the spec path is remembered" jq -e --arg p "$SP" '.spec == $p' "$DEVFLOW_STATE_DIR/$S.json"
denies "spec remembered but not on disk" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "docs/specs/2026-10-22-csv-export.md" "not on disk"
spec "$SP"
denies "empty spec: denied naming all three sections" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "## Решения" "## Дизайн" "## Work split" "devflow:requirements"
spec "$SP" req
denies "spec with ## Решения only: names the two missing" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "missing ## Дизайн, ## Work split" "devflow:design"
lacks "... and not the present one" "missing ## Решения"
spec "$G/docs/specs/2026-01-01-other.md" req design split
denies "own spec incomplete: another complete spec does not unlock" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "missing ## Дизайн, ## Work split"
spec "$SP" req design
denies "spec without ## Work split" "$(p_edit "$G" Write "$G/webapp/lib/x.ts")" "missing ## Work split"
spec "$SP" req design split
silent "complete spec: Edit allowed" edit "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")"
silent "complete spec: Write allowed" edit "$(p_edit "$G" Write "$G/webapp/lib/y.ts")"
silent "complete spec: MultiEdit allowed" edit "$(p_edit "$G" MultiEdit "$G/api/server.js")"
silent "complete spec: NotebookEdit allowed" edit "$(p_edit "$G" NotebookEdit "$G/webapp/nb.ipynb")"
mv "$SP" "$SP.bak"
denies "spec checked on disk at that moment (removed again)" "$(p_edit "$G" Edit "$G/webapp/lib/x.ts")" "not on disk"
mv "$SP.bak" "$SP"
F="$T/fallback"
mkrepo "$F" "$CFG"
spec "$F/docs/specs/2026-01-01-old.md" req design split
spec "$F/docs/specs/2026-02-01-newer.md" req
touch -t 202601010000 "$F/docs/specs/2026-01-01-old.md"
touch -t 202602010000 "$F/docs/specs/2026-02-01-newer.md"
new
arm "$F" devflow:design
silent "no spec this session: the newest complete spec in specDir unlocks" edit "$(p_edit "$F" Edit "$F/webapp/lib/x.ts")"
rm "$F/docs/specs/2026-01-01-old.md"
denies "no spec this session and none complete: denied" "$(p_edit "$F" Edit "$F/webapp/lib/x.ts")" "no spec yet"
mkdir -p "$G/webapp"
new
arm "$G/webapp"
rm -f "$SP" "$G/docs/specs/2026-01-01-other.md"
denies "cwd in a subdirectory, relative path" "$(p_edit "$G/webapp" Edit "lib/x.ts")" "webapp/lib/x.ts"
O="$T/other"
mkrepo "$O"
silent "armed: a file in an unrelated repo is not judged" edit "$(p_edit "$G" Edit "$O/webapp/lib/x.ts")"
NC="$T/nocode"
mkrepo "$NC" '{"uiPaths":["src/ui/"]}'
new
arm "$NC"
silent "no codePaths: the gate is off" edit "$(p_edit "$NC" Edit "$NC/src/lib/x.ts")"

# ==================================================================================================
echo "# UI edit -> stop -> critique (armed sessions only)"
U="$T/ui"
mkrepo "$U" '{"uiPaths":["webapp/components/","webapp/app/"],"uiExtensions":[".tsx",".css"]}'
new
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
silent "not armed: a UI bug fix never blocks Stop" stop "$(p_stop "$U")"
arm "$U"
silent "UI edits made before arming do not count" stop "$(p_stop "$U")"
new
arm "$U"
silent "armed: UI edit is allowed" edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
blocks "armed: stop blocks after a UI edit" "$(p_stop "$U")"
silent "stop_hook_active: no loop" stop "$(p_stop "$U" true)"
blocks "still uncritiqued: the next stop blocks again" "$(p_stop "$U")"
silent "impeccable critique (Skill)" skill "$(p_skill "$U" impeccable:impeccable "critique webapp/components/Button.tsx")"
silent "stop free after the critique" stop "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
silent "[no-devflow] after a UI edit" prompt "$(p_prompt "$U" "skip the flow [no-devflow]")"
silent "waived: stop never blocks" stop "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
hook stop "$(p_stop "$U")"
hook skill "$(p_skill "$U" impeccable:impeccable "critique the button")"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
silent "block -> critique -> fixes: the continuation stop is free" stop "$(p_stop "$U" true)"
silent "... and the fixes count as critiqued" stop "$(p_stop "$U")"
new
arm "$U"
hook skill "$(p_skill "$U" impeccable:impeccable "critique the button")"
hook edit "$(p_edit "$U" Write "$U/webapp/app/page.css")"
blocks "a critique before the UI edit is stale" "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
hook skill "$(p_skill "$U" impeccable:impeccable "polish webapp/components")"
blocks "impeccable without critique does not count" "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
hook skill "$(p_skill "$U" impeccable "critique header")"
silent "unqualified impeccable skill with critique counts" stop "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/Button.tsx")"
silent "user-typed /impeccable critique" prompt "$(p_prompt "$U" "/impeccable critique the header")"
silent "... counts as a critique" stop "$(p_stop "$U")"
new
arm "$U"
hook edit "$(p_edit "$U" Edit "$U/webapp/components/util.ts")"
silent "UI path with a non-UI extension: stop free" stop "$(p_stop "$U")"
hook edit "$(p_edit "$U" Edit "$U/webapp/lib/Thing.tsx")"
silent "UI extension outside uiPaths: stop free" stop "$(p_stop "$U")"
new
arm "$NC"
hook edit "$(p_edit "$NC" Edit "$NC/src/ui/Any.vue")"
blocks "no uiExtensions: every file under uiPaths counts" "$(p_stop "$NC")"
NU="$T/noui"
mkrepo "$NU" '{"codePaths":["src/"]}'
new
arm "$NU"
spec "$NU/docs/specs/2026-10-22-a.md" req design split
hook edit "$(p_edit "$NU" Write "$NU/docs/specs/2026-10-22-a.md")"
hook edit "$(p_edit "$NU" Edit "$NU/src/components/A.tsx")"
silent "no uiPaths: stop never blocks" stop "$(p_stop "$NU")"

# ==================================================================================================
echo "# skill: stamps and analytics reminders"
new
context "requirements start: analytics reminder" PostToolUse skill "$(p_skill "$G" devflow:requirements)" "acme-analytics-events" "Analytics delta"
silent "design start (already armed): silent" skill "$(p_skill "$G" devflow:design "decisions settled")"
hook edit "$(p_edit "$G" Write "$SP")"
context "writing-plans: both delta lines + analytics" PostToolUse skill "$(p_skill "$G" superpowers:writing-plans)" \
	"Behavior-contract delta" "Analytics delta" "acme-analytics-events" "docs/specs/2026-10-22-csv-export.md"
context "executing-plans: hand-off reminder" PostToolUse skill "$(p_skill "$G" superpowers:executing-plans)" "Analytics delta" "acme-analytics-events"
context "subagent-driven-development: hand-off reminder" PostToolUse skill "$(p_skill "$G" superpowers:subagent-driven-development)" "Behavior-contract delta"
hook skill "$(p_skill "$G" impeccable:impeccable "critique x")"
silent "unrelated skill: silent" skill "$(p_skill "$G" superpowers:systematic-debugging)"
check "stamps are plain integer milliseconds" jq -e '[.requirements_at, .design_at, .plan_at, .critique_at, .armed_at]
	| all(type == "number" and . == floor and . > 1000000000000 and . < 100000000000000)' "$DEVFLOW_STATE_DIR/$S.json"
new
context "no analyticsSkill: requirements start only arms" PostToolUse skill "$(p_skill "$NG" devflow:requirements)" "armed" "src/"
lacks "... without an analytics reminder" "run the"
context "no analyticsSkill: writing-plans still asks for the delta lines" PostToolUse skill "$(p_skill "$NG" writing-plans)" "Behavior-contract delta" "Analytics delta"
lacks "... without naming an analytics skill" "run the"

# ==================================================================================================
echo "# bash: worktree hygiene"
MODE=bash
mkdir -p "$R/webapp"
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
context "worktree session finds the main config" UserPromptSubmit prompt "$(p_prompt "$W" "$FEATURE")" "Project gate:"
arm "$W"
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
context "a worktree's own config wins" PostToolUse skill "$(p_skill "$W" devflow:requirements)" "design/" "src/"

# ==================================================================================================
echo "# session end"
new
hook prompt "$(p_prompt "$R" "$FEATURE")"
check "fixture: the session has state" test -s "$DEVFLOW_STATE_DIR/$S.json"
mkdir -p "$DEVFLOW_STATE_DIR/$S.json.lock"
silent "SessionEnd is silent" end "$(p_end "$R")"
check "SessionEnd deletes the state file" test ! -e "$DEVFLOW_STATE_DIR/$S.json"
check "... and a leftover lock" test ! -e "$DEVFLOW_STATE_DIR/$S.json.lock"
new
mkdir -p "$DEVFLOW_STATE_DIR"
printf '{"armed":true}' >"$DEVFLOW_STATE_DIR/$S.json"
silent "SessionEnd from a repo without config" end "$(p_end "$N")"
check "... still deletes the state" test ! -e "$DEVFLOW_STATE_DIR/$S.json"
check "hooks.json wires SessionEnd to the end mode" jq -e '.hooks.SessionEnd[0].hooks[0].command | endswith("devflow.sh\" end")' "$here/../hooks/hooks.json"

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
