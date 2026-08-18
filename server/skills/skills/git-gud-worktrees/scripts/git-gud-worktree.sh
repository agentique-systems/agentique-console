#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  git-gud-worktree.sh inspect [repository]
  git-gud-worktree.sh create <path> <new-branch> <start-point> [repository]
  git-gud-worktree.sh remove <path> [repository]
  git-gud-worktree.sh prune-preview [repository]
EOF
  exit 2
}

absolute_path() {
  local input=$1 parent base
  parent=$(dirname "$input")
  base=$(basename "$input")
  if [[ ! -d "$parent" ]]; then
    printf 'error: parent directory does not exist: %s\n' "$parent" >&2
    exit 2
  fi
  printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$base"
}

command=${1:-}
[[ -n "$command" ]] || usage
shift

case "$command" in
  inspect)
    repo=${1:-.}
    git -C "$repo" rev-parse --is-inside-work-tree >/dev/null
    printf 'common-dir: %s\n' "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
    git -C "$repo" worktree list --porcelain
    ;;
  create)
    [[ $# -ge 3 && $# -le 4 ]] || usage
    path=$(absolute_path "$1")
    branch=$2
    start=$3
    repo=${4:-.}
    git -C "$repo" rev-parse --is-inside-work-tree >/dev/null
    git check-ref-format --branch "$branch" >/dev/null
    if [[ -e "$path" ]]; then
      printf 'error: target path already exists: %s\n' "$path" >&2
      exit 3
    fi
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      printf 'error: local branch already exists: %s\n' "$branch" >&2
      exit 3
    fi
    start_oid=$(git -C "$repo" rev-parse --verify "$start^{commit}")
    printf 'creating branch %s at %s\n' "$branch" "$start_oid"
    git -C "$repo" worktree add -b "$branch" "$path" "$start_oid"
    git -C "$path" status --short --branch
    ;;
  remove)
    [[ $# -ge 1 && $# -le 2 ]] || usage
    path=$(absolute_path "$1")
    repo=${2:-.}
    registered=0
    worktrees=$(git -C "$repo" worktree list --porcelain)
    while IFS= read -r line; do
      if [[ "$line" == "worktree $path" ]]; then
        registered=1
        break
      fi
    done <<< "$worktrees"
    if [[ $registered -ne 1 ]]; then
      printf 'error: path is not a registered worktree: %s\n' "$path" >&2
      exit 3
    fi
    if [[ -n "$(git -C "$path" status --porcelain=v1)" ]]; then
      printf 'error: worktree is dirty; preserve or commit its changes first\n' >&2
      exit 4
    fi
    for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD BISECT_LOG rebase-merge rebase-apply; do
      marker_path=$(git -C "$path" rev-parse --git-path "$marker")
      if [[ -e "$marker_path" ]]; then
        printf 'error: Git operation is in progress: %s\n' "$marker" >&2
        exit 4
      fi
    done
    branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    tip=$(git -C "$path" rev-parse --verify HEAD)
    git -C "$repo" worktree remove "$path"
    printf 'removed worktree; retained branch=%s tip=%s\n' "${branch:-(detached)}" "$tip"
    ;;
  prune-preview)
    repo=${1:-.}
    git -C "$repo" worktree prune --dry-run --verbose
    ;;
  *)
    usage
    ;;
esac
