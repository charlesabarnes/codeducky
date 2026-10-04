#!/bin/sh
# Rubberduck review gate for Claude Code: a PreToolUse hook on Bash that acts on "git push".
# Denies the command (hookSpecificOutput.permissionDecision "deny") while the branch's Rubberduck
# session has open blocker or issue notes, or unticked items on a required checklist.
# Everything else, and every failure to reach the server, is allowed.

# @common

input=$(cat)

# Reads a string field from the hook JSON (top level or tool_input); jq when installed, else sed.
json_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r --arg k "$1" '(.[$k] // .tool_input[$k] // "") | strings' 2>/dev/null
  else
    printf '%s' "$input" | tr '\n' ' ' | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | sed 's/\\"/"/g; s/\\\\/\\/g'
  fi
}

tool=$(json_field tool_name)
[ "$tool" = Bash ] || exit 0
command=$(json_field command)
cwd=$(json_field cwd)

# Only git push, possibly after cd/&&; not "git push --help" or a dry run, and --no-verify skips us.
case $command in
  *'git push'*) args=${command#*git push} ;;
  *'git -C '*' push'*) args=${command#*git -C * push} ;;
  *) exit 0 ;;
esac
case $command in
  *--no-verify* | *--dry-run* | *' -n '* | *--help*) exit 0 ;;
esac

[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd" 2>/dev/null
# "cd <dir> && git push" pushes from <dir>.
case $command in
  'cd '*)
    dir=${command#cd }
    dir=${dir%%[;&|]*}
    dir=$(printf '%s' "$dir" | sed "s/^[[:space:]]*//; s/[[:space:]]*$//; s/^[\"']//; s/[\"']$//")
    case $dir in "~"*) dir=$HOME${dir#\~} ;; esac
    [ -d "$dir" ] && cd "$dir" 2>/dev/null
    ;;
esac
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The arguments after "push": the first non-option is the remote, the next the refspec.
args=${args%%[;&|]*}
args=$(printf '%s' "$args" | tr -d "\"'")
remote=''
refspec=''
for word in $args; do
  case $word in
    push) ;;
    -*) ;;
    *)
      if [ -z "$remote" ]; then remote=$word
      elif [ -z "$refspec" ]; then refspec=$word
      fi
      ;;
  esac
done

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$refspec" ]; then
  src=${refspec#+}
  src=${src%%:*}
  [ -n "$src" ] && [ "$src" != HEAD ] && branch=${src#refs/heads/}
fi
[ -n "$branch" ] && [ "$branch" != HEAD ] || exit 0
if [ -z "$remote" ]; then
  remote=$(git config --get "branch.$branch.pushRemote" 2>/dev/null || git config --get remote.pushDefault 2>/dev/null || git config --get "branch.$branch.remote" 2>/dev/null || echo origin)
fi
remote_url=$(git remote get-url --push "$remote" 2>/dev/null || printf '%s' "$remote")
repo=$(rubberduck_repo_from_url "$remote_url") || exit 0

answer=$(rubberduck_check "$repo" "$branch") || exit 0
[ "$(printf '%s\n' "$answer" | head -n 1)" = FAIL ] || exit 0

link=$(printf '%s\n' "$answer" | sed -n 's/^url //p')
pr_link=$(printf '%s\n' "$answer" | sed -n 's/^pr //p')
reason=$(
  printf 'Rubberduck review gate: push of %s@%s is blocked.\n' "$repo" "$branch"
  printf '%s\n' "$answer" | sed -n 's/^- /- /p'
  printf 'Review: %s\n' "$link"
  [ -z "$pr_link" ] || printf 'Pull request: %s\n' "$pr_link"
  printf 'Fix the notes (and resolve them with resolve_note) or tick the required items, then push again. Do not bypass with --no-verify unless the user asks.'
)
escaped=$(printf '%s' "$reason" | tr '\t' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }')
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$escaped"
exit 0
