---
name: build-hygiene
description: Keep build outputs out of git and builds fast across worktrees — gitignore first, shared caches, offline flags, lockfile conflict etiquette.
version: 1.0.0
provenance: distilled from the straf3 live run, 2026-08-15
status: validated
requires:
  tools: [Bash, Edit, Write]
whenToUse: Before the first build in a fresh workspace or worktree, and whenever a commit is about to include generated output.
costNote: ~35 lines when invoked; the run it comes from committed 556MB of target/ into history.
---

# Build hygiene

A live run committed 556MB of `target/` into git history in its first wave;
three separate agents escalated it, nobody could rewrite history mid-run, and
every subsequent clone/diff/summary paid for it.

## Before the first build

- Check `.gitignore` covers the ecosystem's build dirs (`target/`, `dist/`,
  `build/`, `node_modules/`, `.venv/`, `__pycache__/`) BEFORE running the
  build. Adding the ignore after outputs exist still requires untracking.
- `git status` after the first build; if generated files appear, fix the
  ignore before any commit.

## Fast builds across worktrees

- Every worktree cold-builds by default. For Rust, set a shared target dir
  (`CARGO_TARGET_DIR=$HOME/.cache/shared-target` or a workspace-level
  `.cargo/config.toml`) so sibling worktrees reuse artifacts — a cold
  `cargo clippy --workspace --all-targets` alone can take 5+ minutes.
- After the first fetch, prefer `--offline` (cargo) / `--prefer-offline`
  (npm) — sandboxed networks make registry probes slow or flaky.
- Expect the FIRST build after a worktree re-provision to be cold; say so in
  your report rather than treating it as a regression.

## Lockfile conflicts

`Cargo.lock` / `package-lock.json` merge conflicts are regenerable: take the
current mainline lockfile and re-run the resolver (`cargo check`,
`npm install --package-lock-only`) rather than hand-merging hunks. For the
conflict operation itself (index stages, ours/theirs, verification), follow
`git-gud-conflicts` — it governs every conflict you resolve.
