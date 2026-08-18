#!/usr/bin/env bash
set -euo pipefail

repo=${1:-.}

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'error: not inside a Git worktree: %s\n' "$repo" >&2
  exit 2
fi

top=$(git -C "$repo" rev-parse --show-toplevel)
git_dir=$(git -C "$repo" rev-parse --absolute-git-dir)
common_dir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
head=$(git -C "$repo" rev-parse --verify HEAD)
branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || printf '(detached)')
upstream=$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)

printf 'worktree: %s\n' "$top"
printf 'git-dir: %s\n' "$git_dir"
printf 'common-dir: %s\n' "$common_dir"
printf 'branch: %s\n' "$branch"
printf 'head: %s\n' "$head"
printf 'upstream: %s\n' "${upstream:-(none)}"

if [[ -n "$upstream" ]]; then
  divergence=$(git -C "$repo" rev-list --left-right --count "$upstream...HEAD")
  read -r upstream_only head_only <<< "$divergence"
  printf 'divergence: ahead=%s behind=%s\n' "$head_only" "$upstream_only"
fi

tracked=$(git -C "$repo" status --porcelain=v1 --untracked-files=no | wc -l | tr -d ' ')
untracked=$(git -C "$repo" ls-files --others --exclude-standard | wc -l | tr -d ' ')
printf 'changes: tracked=%s untracked=%s\n' "$tracked" "$untracked"

operation=none
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD BISECT_LOG; do
  marker_path=$(git -C "$repo" rev-parse --git-path "$marker")
  if [[ -e "$marker_path" ]]; then
    operation=$marker
    break
  fi
done
for marker in rebase-merge rebase-apply; do
  marker_path=$(git -C "$repo" rev-parse --git-path "$marker")
  if [[ -d "$marker_path" ]]; then
    operation=$marker
    break
  fi
done
printf 'operation: %s\n' "$operation"

printf '\nworktrees:\n'
git -C "$repo" worktree list --porcelain

printf '\nstatus:\n'
git -C "$repo" status --short --branch
