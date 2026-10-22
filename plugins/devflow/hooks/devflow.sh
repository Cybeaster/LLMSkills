#!/usr/bin/env bash
# devflow hook: one script, six modes (DESIGN.md -> Hooks).
#
#   prompt  UserPromptSubmit                                nudge a feature-shaped prompt toward the flow
#   skill   PostToolUse Skill                               arm when the flow starts; stamp requirements /
#                                                           design / plan / critique; remind at the hand-offs
#   edit    PreToolUse Edit|Write|MultiEdit|NotebookEdit    remember the spec, gate code, stamp UI edits
#   bash    PreToolUse Bash                                 worktrees only under <repo>/<worktreeDir>/
#   stop    Stop                                            armed: block once while UI is uncritiqued
#   end     SessionEnd                                      delete the session's state
#
# Only an armed session (devflow:requirements, devflow:design or an `armingSkills` wrapper started) is
# gated; ordinary work is never blocked. Silent unless the repo has .claude/devflow.json (looked up in the
# cwd's toplevel, then in the main worktree's). A project may vendor this script as
# .claude/hooks/devflow.sh: then any other copy (the installed plugin's) exits silently and only the
# project's runs, and that copy also takes the bare skill names `requirements` / `design`. Fails open:
# no jq, bad stdin, no git, bad config or state -> exit 0 with no output. The gate is advisory: it sees file tools, not shell writes.
# State: ${DEVFLOW_STATE_DIR:-~/.claude/state/devflow}/<session_id>.json, times in epoch milliseconds.
set -u

mode=${1:-}
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
printf '%s' "$input" | jq -e 'type == "object"' >/dev/null 2>&1 || exit 0
j() { printf '%s' "$input" | jq -r "($1) // empty | strings" 2>/dev/null; }

# git_common <dir>: absolute physical path of the repository's common git dir (shared by its worktrees)
git_common() {
	local c
	c=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
	case "$c" in /*) ;; *) c="$1/$c" ;; esac
	(cd "$c" 2>/dev/null && pwd -P)
}
# rp <file>: the file's canonical path (realpath, else its physical directory + its name)
rp() {
	if command -v realpath >/dev/null 2>&1; then
		realpath "$1" 2>/dev/null
	else
		(cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$1")")
	fi
}

cwd=$(j '.cwd')
[ -n "$cwd" ] || cwd=${CLAUDE_PROJECT_DIR:-}
top="" common="" main=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
	top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || top=""
	common=$(git_common "$cwd") || common=""
	[ -n "$common" ] && main=$(dirname "$common") # the main worktree's toplevel: <main>/.git is the common dir
fi

# Yield to a vendored project copy (<root>/.claude/hooks/devflow.sh, root = the cwd's toplevel, the main
# worktree or CLAUDE_PROJECT_DIR): when one exists and this script is none of them, it is the plugin's
# copy running beside the project's, so it stays out of the way, `end` included.
self=$(rp "${BASH_SOURCE[0]}")
vendored="" other=""
for r in "$top" "$main" "${CLAUDE_PROJECT_DIR:-}"; do
	[ -n "$r" ] && [ -f "$r/.claude/hooks/devflow.sh" ] || continue
	if [ -n "$self" ] && [ "$(rp "$r/.claude/hooks/devflow.sh")" = "$self" ]; then vendored=1; else other=1; fi
done
[ -z "$vendored" ] && [ -n "$other" ] && exit 0
if [ -n "$vendored" ]; then # the skills this project ships under their bare names
	REQ=requirements DES=design
else
	REQ=devflow:requirements DES=devflow:design
fi

sid=$(j '.session_id')
case "$sid" in '' | *[!A-Za-z0-9._-]*) exit 0 ;; esac
sdir=${DEVFLOW_STATE_DIR:-$HOME/.claude/state/devflow}
sfile="$sdir/$sid.json"
if [ "$mode" = end ]; then # the state is ours whatever the repo, so no config is needed to drop it
	rm -f "$sfile"
	rm -rf "$sfile.lock"
	exit 0
fi
[ -n "$top" ] && [ -n "$common" ] || exit 0 # no cwd, or not a git repository

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
	@sh "gate=\(.gate | str(""))",
	@sh "armingSkills=\(.armingSkills | list)",
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

# missing <spec>: the required sections it lacks, comma-separated
missing() {
	local m=""
	grep -qE '^##+[[:space:]]+Решения' "$1" || m="$m, ## Решения"
	grep -qE '^##+[[:space:]]+Дизайн' "$1" || m="$m, ## Дизайн"
	grep -qiE '^##+[[:space:]]+work split' "$1" || m="$m, ## Work split"
	printf '%s' "${m#, }"
}

# newest_complete <dir>: the most recently modified .md in dir that has all three sections
newest_complete() {
	[ -d "$1" ] || return 1
	local f
	ls -1t "$1" 2>/dev/null | while IFS= read -r f; do
		case "$f" in *.md) ;; *) continue ;; esac
		[ -f "$1/$f" ] && [ -z "$(missing "$1/$f")" ] && {
			printf '%s' "$1/$f"
			break
		}
	done
}

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
csv() { printf '%s' "$1" | paste -sd, - | sed 's/,/, /g'; }
sections="## Решения, ## Дизайн and ## Work split"
gateLine() { # " Project gate: <text>." when a gate is configured
	[ -n "$gate" ] || return 0
	case "$gate" in *[.!?]) printf ' Project gate: %s' "$gate" ;; *) printf ' Project gate: %s.' "$gate" ;; esac
}

# ---- modes ---------------------------------------------------------------------------------------

case "$mode" in

prompt)
	p=$(j '.prompt')
	[ -n "$p" ] || exit 0
	verdict=$(printf '%s' "$p" | jq -Rrs '
		if test("^\\s*/(impeccable:)?impeccable\\s+critique\\b"; "i") then "critique"
		elif test("\\[no-devflow\\]"; "i") then "waive"
		elif test("\\b(build|add|implement|create|introduce|brainstorm)\\b|\\bnew feature\\b|\\bdesign doc\\b|\\b(сделай|сделаем|добавь|добавим|создай|создадим|реализуй|реализуем|внедри|внедрим)\\b|\\bспроектир|\\bфич"; "i")
		  and (test("^\\W*((fix|how|what|why|почему|как|что|зачем|исправь|почини|поправь|commit|push|merge|rebase|build|run|deploy|review|screenshot|log)\\b|фикс)"; "i") | not)
		  and (test("\\bPR\\b|\\bpull request|\\b(implement|execute|follow)\\s+(the\\s+)?plan\\b|\\b(выполни|исполни|реализуй)\\s+план|коммит|\\b(за)?пуш|\\bветк|ревью|скриншот|\\bлог(и|ов|ах|ам|ом|е|у|а)?\\b"; "i") | not)
		  and (test("\\btest|тест"; "i") | not)
		then "feature" else "" end' 2>/dev/null)
	case "$verdict" in
	critique) put --argjson n "$(now_ms)" '.critique_at = $n' ;;
	waive) put '.armed = false | .waived = true' ;;
	feature) # a nudge, never an arm: at most once per 30 minutes, so a later feature is nudged again
		[ "$(get waived)" = true ] && exit 0
		n=$(now_ms)
		last=$(num "$(get nudged_at)")
		[ $((n - last)) -lt 1800000 ] && exit 0
		put --argjson n "$n" '.nudged_at = $n'
		if [ -n "$vendored" ]; then
			msg="[devflow] Feature work here goes through \`requirements\` → \`design\` (devflow, vendored in this project; with the plugin installed also devflow:requirements → devflow:design), not grilling / superpowers:brainstorming. Start with the Skill tool: requirements"
		else
			msg="[devflow] Feature work here goes through devflow:requirements → devflow:design (not grilling / superpowers:brainstorming). Start with the Skill tool: devflow:requirements"
		fi
		[ -n "$armingSkills" ] && msg="$msg, or the project's entry: $(csv "$armingSkills")"
		msg="$msg.$(gateLine)"
		[ -n "$codePaths" ] && msg="$msg Once the flow starts, edits under $(csv "$codePaths") wait until the spec in $specDir/ has $sections."
		ctx UserPromptSubmit "$msg If the user says this is not a feature, they can resend with [no-devflow]."
		;;
	esac
	;;

skill)
	s=$(j '.tool_input.skill')
	[ -n "$s" ] || exit 0
	k=$s # the name matched below: a vendored project's bare requirements / design are devflow's
	if [ -n "$vendored" ]; then case "$s" in requirements | design) k="devflow:$s" ;; esac; fi
	a=$(j '.tool_input.args')
	n=$(now_ms)
	msg=""
	handoff=""
	# 1. arm when the feature flow starts (devflow's own skills or a project wrapper)
	arming=""
	case "$k" in devflow:requirements | devflow:design) arming=1 ;; esac
	while IFS= read -r e; do
		[ -n "$e" ] || continue
		case "$k" in "$e" | *:"$e") arming=1 ;; esac
	done <<EOF
$armingSkills
EOF
	if [ -n "$arming" ] && [ "$(get armed)" != true ]; then
		put --argjson n "$n" '.armed = true | .armed_at = $n | del(.waived)'
		msg="[devflow] Feature flow armed for this session (\`$s\`)."
		[ -n "$codePaths" ] && msg="$msg Edits under $(csv "$codePaths") wait until this session's spec in $specDir/ has $sections."
		[ -n "$uiPaths" ] && msg="$msg UI edits under $(csv "$uiPaths") need an impeccable critique before the turn ends."
		msg="$msg$(gateLine)"
	fi
	# 2. stamps and hand-off reminders
	case "$k" in
	devflow:requirements)
		put --argjson n "$n" '.requirements_at = $n'
		[ -n "$analyticsSkill" ] && msg="${msg:+$msg }[devflow] Requirements started. Round 1 settles whether this needs analytics; when it does, run the \`$analyticsSkill\` skill before $DES writes the spec's **Analytics delta** (the events it adds, or \"none — <reason>\")."
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

	armed=$(get armed)
	[ "$armed" = true ] || exit 0 # ordinary work: nothing to gate, nothing to critique

	# 2. feature code needs a spec on disk with all three sections: this session's, or, when it
	#    edited none, the newest complete one in specDir
	if [ -n "$codePaths" ] && in_list "$rel" "$codePaths"; then
		sp=$(get spec)
		why=""
		if [ -z "$sp" ]; then
			case "$specDir" in /*) sd=$specDir ;; *) sd="$froot/${specDir#./}" ;; esac
			if [ -z "$(newest_complete "${sd%/}")" ]; then
				why="this session has no spec yet and none in $specDir/ is complete. Run $REQ: it creates $specDir/<YYYY-MM-DD>-<slug>.md and settles ## Решения, then $DES adds ## Дизайн and ## Work split."
			fi
		elif [ ! -f "$sp" ]; then
			why="this session's spec $(show "$sp") is not on disk. Write it ($REQ, then $DES)."
		else
			miss=$(missing "$sp")
			if [ -n "$miss" ]; then
				next="$DES writes ## Дизайн and ## Work split."
				case "$miss" in *Решения*) next="$REQ writes ## Решения, then $next" ;; esac
				why="this session's spec $(show "$sp") is missing $miss. $next"
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
	[ "$(get armed)" = true ] || exit 0 # an unarmed session (a bug fix, a waiver) never blocks
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
