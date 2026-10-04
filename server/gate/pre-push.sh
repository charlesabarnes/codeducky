#!/bin/sh
# Code Ducky pre-push gate (git pre-push hook).
# Blocks a push while the branch's Code Ducky session has open blocker or issue notes, or unticked
# items on a required checklist. Bypass once with: git push --no-verify
# Server: git config codeducky.url, else the URL baked in below.

# @common

remote_url=$2
if ! repo=$(codeducky_repo_from_url "$remote_url"); then
  codeducky_warn "cannot tell owner/name from remote URL '$remote_url'; push allowed without the review gate."
  cat >/dev/null
  exit 0
fi

branches=''
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ -n "$local_ref" ] || continue
  # Deleting a remote branch pushes nothing to review.
  case $local_sha in *[!0]*) ;; *) continue ;; esac
  case $local_ref in
    refs/heads/*) branch=${local_ref#refs/heads/} ;;
    *) case $remote_ref in refs/heads/*) branch=${remote_ref#refs/heads/} ;; *) continue ;; esac ;;
  esac
  case " $branches " in *" $branch "*) ;; *) branches="$branches $branch" ;; esac
done

blocked=0
for branch in $branches; do
  answer=$(codeducky_check "$repo" "$branch") || continue
  verdict=$(printf '%s\n' "$answer" | head -n 1)
  link=$(printf '%s\n' "$answer" | sed -n 's/^url //p')
  pr_link=$(printf '%s\n' "$answer" | sed -n 's/^pr //p')
  if [ "$verdict" = FAIL ]; then
    blocked=1
    {
      printf 'codeducky: push of %s@%s blocked by the review gate:\n' "$repo" "$branch"
      printf '%s\n' "$answer" | sed -n 's/^- /  - /p'
      printf '  Review: %s\n' "$link"
      [ -z "$pr_link" ] || printf '  Pull request: %s\n' "$pr_link"
    } >&2
  else
    printf '%s\n' "$answer" | sed -n 's/^- /codeducky: /p' >&2
  fi
done

if [ "$blocked" -ne 0 ]; then
  codeducky_warn 'resolve the notes or tick the items in Code Ducky, or push with --no-verify to skip the gate.'
  exit 1
fi
exit 0
