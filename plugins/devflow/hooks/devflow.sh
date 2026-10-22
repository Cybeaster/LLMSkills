#!/usr/bin/env bash
# devflow hook: one script, five modes (DESIGN.md -> Hooks).
#
#   prompt  UserPromptSubmit                                arm the session on a feature-shaped prompt
#   skill   PostToolUse Skill                               stamp requirements / design / plan / critique,
#                                                           remind about the delta lines at the hand-offs
#   edit    PreToolUse Edit|Write|MultiEdit|NotebookEdit    remember the spec, gate code, stamp UI edits
#   bash    PreToolUse Bash                                 worktrees only under <repo>/<worktreeDir>/
#   stop    Stop                                            block once while UI changed since the last critique
#
# Silent unless the repo has .claude/devflow.json (looked up in the cwd's toplevel, then in the main
# worktree's). Fails open: no jq, bad stdin, no git, bad config or state -> exit 0 with no output.
# State: ${DEVFLOW_STATE_DIR:-~/.claude/state/devflow}/<session_id>.json, times in epoch milliseconds.
set -u

mode=${1:-}
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
printf '%s' "$input" | jq -e 'type == "object"' >/dev/null 2>&1 || exit 0
j() { printf '%s' "$input" | jq -r "($1) // empty | strings" 2>/dev/null; }

sid=$(j '.session_id')
case "$sid" in '' | *[!A-Za-z0-9._-]*) exit 0 ;; esac
cwd=$(j '.cwd')
[ -n "$cwd" ] || cwd=${CLAUDE_PROJECT_DIR:-}
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 0

# git_common <dir>: absolute physical path of the repository's common git dir (shared by its worktrees)
git_common() {
	local c
	c=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
	case "$c" in /*) ;; *) c="$1/$c" ;; esac
	(cd "$c" 2>/dev/null && pwd -P)
}
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git_common "$cwd") || exit 0
main=$(dirname "$common") # the main worktree's toplevel: <main>/.git is the common dir

cfg="$top/.claude/devflow.json"
[ -f "$cfg" ] || cfg="$main/.claude/devflow.json"
[ -f "$cfg" ] || exit 0
conf=$(jq -r '
	if type != "object" then error("not an object") else . end
	| def str($d): if type == "string" and length > 0 then . else $d end;
	  def list: if type == "array" then map(strings) else [] end | join("\n");
	@sh "specDir=\(.specDir | str("docs/specs"))",
	@sh "worktreeDir=\(.worktreeDir | str(".worktrees"))",
	@sh "analyticsSkill=\(.analyticsSkill | str(""))",
	@sh "codePaths=\(.codePaths | list)",
	@sh "uiPaths=\(.uiPaths | list)",
	@sh "uiExtensions=\(.uiExtensions | list)"' "$cfg" 2>/dev/null) || exit 0
eval "$conf"

# ---- helpers -------------------------------------------------------------------------------------

now_ms() {
	if [ -n "${EPOCHREALTIME:-}" ]; then
		local e=${EPOCHREALTIME/[.,]/}
		printf '%s' "${e:0:13}"
	else
		local d
		d=$(date +%s%3N 2>/dev/null)
		case "$d" in '' | *[!0-9]*) printf '%s000' "$(date +%s)" ;; *) printf '%s' "$d" ;; esac
	fi
}

# norm <abs path>: collapse //, /./ and /x/../ without touching the disk
norm() {
	local in=$1 out="" seg
	while [ -n "$in" ]; do
		seg=${in%%/*}
		if [ "$seg" = "$in" ]; then in=""; else in=${in#*/}; fi
		case "$seg" in '' | .) ;; ..) out=${out%/*} ;; *) out="$out/$seg" ;; esac
	done
	printf '%s' "${out:-/}"
}

# phys <abs path>: resolve symlinks in the longest existing prefix, keep the rest as written
phys() {
	local d rest="" p
	d=$(norm "$1")
	while [ ! -d "$d" ]; do
		rest="/$(basename "$d")$rest"
		d=$(dirname "$d")
	done
	p=$(cd "$d" 2>/dev/null && pwd -P) || return 1
	[ "$p" = / ] && p=""
	printf '%s' "$p$rest"
}

# under <rel> <dir>: rel is dir or inside it; "", "." and "/" mean the whole repo
under() {
	local d=${2#./}
	d=${d%/}
	if [ -z "$d" ] || [ "$d" = . ]; then return 0; fi
	[ "$1" = "$d" ] || [ "${1#"$d"/}" != "$1" ]
}

# in_list <rel> <newline-separated dirs>
in_list() {
	local e
	while IFS= read -r e; do
		[ -n "$e" ] || continue
		under "$1" "$e" && return 0
	done <<EOF
$2
EOF
	return 1
}

# has_ext <rel>: no uiExtensions configured means every file counts
has_ext() {
	[ -n "$uiExtensions" ] || return 0
	local e
	while IFS= read -r e; do
		[ -n "$e" ] || continue
		case "$e" in .*) ;; *) e=".$e" ;; esac
		case "$1" in *"$e") return 0 ;; esac
	done <<EOF
$uiExtensions
EOF
	return 1
}

sdir=${DEVFLOW_STATE_DIR:-$HOME/.claude/state/devflow}
sfile="$sdir/$sid.json"
lockd=""
unlock() {
	[ -n "$lockd" ] && rmdir "$lockd" 2>/dev/null
	lockd=""
}
trap unlock EXIT
lock() { # mkdir lock (portable, no flock); a lock older than ~2s is taken as stale
	local i=0
	lockd="$sfile.lock"
	while ! mkdir "$lockd" 2>/dev/null; do
		i=$((i + 1))
		if [ "$i" -ge 100 ]; then
			rm -rf "$lockd"
			mkdir "$lockd" 2>/dev/null
			break
		fi
		sleep 0.02 2>/dev/null || sleep 1
	done
}
get() { [ -s "$sfile" ] && jq -r "(.$1) // empty | tostring" "$sfile" 2>/dev/null; }
put() { # put [jq options...] <filter>: read-modify-write under the lock, atomic rename
	mkdir -p "$sdir" 2>/dev/null || return 0
	lock
	local cur='{}' t
	[ -s "$sfile" ] && cur=$(cat "$sfile" 2>/dev/null)
	printf '%s' "$cur" | jq -e 'type == "object"' >/dev/null 2>&1 || cur='{}'
	t=$(mktemp "$sdir/.tmp.XXXXXX" 2>/dev/null) || {
		unlock
		return 0
	}
	if printf '%s' "$cur" | jq "$@" >"$t" 2>/dev/null; then mv -f "$t" "$sfile"; else rm -f "$t"; fi
	unlock
}
num() { case "${1:-}" in '' | *[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac; }

ctx() { jq -cn --arg e "$1" --arg c "$2" '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}'; }
deny() {
	jq -cn --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
	exit 0
}
show() { # a path relative to the repo when it is inside it
	case "$1" in "$top"/*) printf '%s' "${1#"$top"/}" ;; "$main"/*) printf '%s' "${1#"$main"/}" ;; *) printf '%s' "$1" ;; esac
}
codeList() { printf '%s' "$codePaths" | paste -sd, - | sed 's/,/, /g'; }

# ---- modes ---------------------------------------------------------------------------------------

case "$mode" in

prompt)
	p=$(j '.prompt')
	[ -n "$p" ] || exit 0
	verdict=$(printf '%s' "$p" | jq -Rrs '
		if test("^\\s*/(impeccable:)?impeccable\\s+critique\\b"; "i") then "critique"
		elif test("\\[no-devflow\\]"; "i") then "waive"
		elif test("\\b(build|add|implement|create|introduce|brainstorm)\\b|\\bnew feature\\b|\\bdesign doc\\b|\\b(сделай|сделаем|добавь|добавим|создай|создадим|реализуй|реализуем|внедри|внедрим)\\b|\\bспроектир|\\bфич"; "i")
		  and (test("^\\W*(fix|how|what|why|почему|как|что|зачем|исправь|почини|поправь)\\b"; "i") | not)
		  and (test("\\btest|тест"; "i") | not)
		then "feature" else "" end' 2>/dev/null)
	case "$verdict" in
	critique) put --argjson n "$(now_ms)" '.critique_at = $n' ;;
	waive) put '.armed = false | .waived = true' ;;
	feature)
		[ "$(get armed)" = true ] && exit 0
		[ "$(get waived)" = true ] && exit 0
		put --argjson n "$(now_ms)" '.armed = true | .armed_at = $n'
		msg="[devflow] Feature work here goes through devflow:requirements → devflow:design (not grilling / superpowers:brainstorming). Start with the Skill tool: devflow:requirements."
		[ -n "$codePaths" ] && msg="$msg Edits under $(codeList) stay blocked until this session's spec in $specDir/ has ## Решения, ## Дизайн and ## Work split."
		ctx UserPromptSubmit "$msg If the user says this is not a feature, they can resend with [no-devflow]."
		;;
	esac
	;;

skill)
	s=$(j '.tool_input.skill')
	[ -n "$s" ] || exit 0
	a=$(j '.tool_input.args')
	n=$(now_ms)
	msg=""
	handoff=""
	case "$s" in
	devflow:requirements)
		put --argjson n "$n" '.requirements_at = $n'
		[ -n "$analyticsSkill" ] && msg="[devflow] Requirements started. Round 1 settles whether this needs analytics; when it does, run the \`$analyticsSkill\` skill before devflow:design writes the spec's **Analytics delta** (the events it adds, or \"none — <reason>\")."
		;;
	devflow:design) put --argjson n "$n" '.design_at = $n' ;;
	writing-plans | *:writing-plans)
		put --argjson n "$n" '.plan_at = $n'
		handoff=1
		;;
	executing-plans | *:executing-plans | subagent-driven-development | *:subagent-driven-development) handoff=1 ;;
	impeccable | *:impeccable)
		printf '%s' "$a" | grep -qi 'critique' && put --argjson n "$n" '.critique_at = $n'
		;;
	impeccable:critique) put --argjson n "$n" '.critique_at = $n' ;;
	esac
	if [ -n "$handoff" ]; then
		sp=$(get spec)
		msg="[devflow] Implementation hand-off (\`$s\`). The plan header must repeat the spec's two delta lines verbatim: **Behavior-contract delta:** … and **Analytics delta:** …"
		[ -n "$sp" ] && msg="$msg (spec: $(show "$sp"))"
		msg="$msg. Copy them in if the plan lacks them."
		[ -n "$analyticsSkill" ] && msg="$msg If the spec has no **Analytics delta** yet and this builds something a user sees or does, run the \`$analyticsSkill\` skill first and write its delta into the spec and the plan (events added, or \"none — <reason>\")."
	fi
	[ -n "$msg" ] && ctx PostToolUse "$msg"
	;;

edit)
	f=$(j '.tool_input.file_path // .tool_input.notebook_path')
	[ -n "$f" ] || exit 0
	case "$f" in /*) ;; *) f="$cwd/$f" ;; esac
	f=$(phys "$f") || exit 0
	d=$(dirname "$f")
	while [ ! -d "$d" ]; do d=$(dirname "$d"); done
	froot=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || exit 0
	[ "$(git_common "$d")" = "$common" ] || exit 0 # another repository: not ours to judge
	rel=${f#"$froot"/}
	[ "$rel" != "$f" ] || exit 0

	# 1. a markdown file under specDir is this session's spec
	if under "$rel" "$specDir" && [ "${rel%.md}" != "$rel" ]; then
		put --arg s "$f" '.spec = $s'
		exit 0
	fi

	# 2. feature code while armed needs the spec on disk with all three sections
	if [ -n "$codePaths" ] && in_list "$rel" "$codePaths" && [ "$(get armed)" = true ]; then
		sp=$(get spec)
		why=""
		if [ -z "$sp" ]; then
			why="this session has no spec yet. Run devflow:requirements: it creates $specDir/<YYYY-MM-DD>-<slug>.md and settles ## Решения, then devflow:design adds ## Дизайн and ## Work split."
		elif [ ! -f "$sp" ]; then
			why="this session's spec $(show "$sp") is not on disk. Write it (devflow:requirements, then devflow:design)."
		else
			miss=""
			grep -qE '^##+[[:space:]]+Решения' "$sp" || miss="$miss, ## Решения"
			grep -qE '^##+[[:space:]]+Дизайн' "$sp" || miss="$miss, ## Дизайн"
			grep -qiE '^##+[[:space:]]+work split' "$sp" || miss="$miss, ## Work split"
			if [ -n "$miss" ]; then
				next="devflow:design writes ## Дизайн and ## Work split."
				case "$miss" in *Решения*) next="devflow:requirements writes ## Решения, then $next" ;; esac
				why="this session's spec $(show "$sp") is missing ${miss#, }. $next"
			fi
		fi
		[ -n "$why" ] && deny "[devflow] Blocked: $rel is feature code, and $why Code edits open once the spec has all three sections. If the user says this is not a feature, they can resend with [no-devflow]."
	fi

	# 3. a UI file: any critique before now is stale
	if [ -n "$uiPaths" ] && in_list "$rel" "$uiPaths" && has_ext "$rel"; then
		put --argjson n "$(now_ms)" '.ui_edit_at = $n'
	fi
	;;

bash)
	c=$(j '.tool_input.command')
	[ -n "$c" ] || exit 0
	case "$c" in *worktree*) ;; *) exit 0 ;; esac
	# Find the first `git [-C dir] worktree add [options] <path>` and take its path. Redirections
	# (2>&1, > log, < in) go first so their targets are never read as the path.
	set -f
	# shellcheck disable=SC2046
	set -- $(printf '%s' "$c" | tr -d "\"'" | sed -E \
		-e 's/[0-9]*>&[0-9-]+//g' \
		-e 's/(&|[0-9]*)>>?[[:space:]]*[^[:space:];|&]+//g' \
		-e 's/<+[[:space:]]*[^[:space:];|&]+//g' \
		-e 's/(&&|\|\||[;|&()])/ ; /g')
	set +f
	st=0 gdir="" wt=""
	for w in "$@"; do
		case $st in
		0) [ "$w" = git ] && st=1 && gdir="" ;;
		1) case "$w" in -C) st=2 ;; -c) st=3 ;; worktree) st=4 ;; -*) ;; *) st=0 ;; esac ;;
		2) gdir=$w st=1 ;;
		3) st=1 ;;
		4) if [ "$w" = add ]; then st=5; else st=0; fi ;;
		5) case "$w" in
			';') st=0 ;;
			-b | -B | --reason) st=6 ;;
			-*) ;;
			*)
				wt=$w
				break
				;;
			esac ;;
		6) st=5 ;;
		esac
	done
	[ -n "$wt" ] || exit 0
	base=$cwd
	case "$gdir" in '') ;; /*) base=$gdir ;; *) base="$cwd/$gdir" ;; esac
	case "$wt" in "~"/*) wt="$HOME/${wt#"~"/}" ;; /*) ;; *) wt="$base/$wt" ;; esac
	want=$(phys "$wt") || exit 0
	case "$worktreeDir" in /*) wroot=$worktreeDir ;; *) wroot="$main/${worktreeDir#./}" ;; esac
	wroot=$(phys "${wroot%/}") || exit 0
	case "$want" in "$wroot"/?*)
		# inside the worktree dir, but not nested inside a worktree that already lives there
		d=$(dirname "$want")
		while [ "$d" != "$wroot" ] && [ ! -e "$d/.git" ]; do d=$(dirname "$d"); done
		[ "$d" = "$wroot" ] && exit 0
		;;
	esac
	deny "[devflow] Worktrees live under $wroot/ (scratch and /tmp get wiped, and nested ones confuse git status). Re-run with a path like $wroot/$(basename "$want")."
	;;

stop)
	ui=$(num "$(get ui_edit_at)")
	[ "$ui" -gt 0 ] || exit 0
	cr=$(num "$(get critique_at)")
	if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active == true' 2>/dev/null)" = true ]; then
		# Continuing after a Stop block: never block twice. If a critique ran since our block, the
		# edits made after it are its fixes, so the block is satisfied.
		bl=$(num "$(get stop_blocked_at)")
		if [ "$bl" -gt 0 ] && [ "$cr" -ge "$bl" ]; then
			put --argjson n "$(now_ms)" '.critique_at = $n | del(.stop_blocked_at)'
		else
			put 'del(.stop_blocked_at)'
		fi
		exit 0
	fi
	[ "$ui" -gt "$cr" ] || exit 0
	put --argjson n "$(now_ms)" '.stop_blocked_at = $n'
	jq -cn '{decision: "block", reason: "[devflow] UI changed since the last impeccable critique: run `impeccable:impeccable` critique and fix what it finds (Skill tool, args \"critique <the changed surface>\")."}'
	;;

esac
exit 0
