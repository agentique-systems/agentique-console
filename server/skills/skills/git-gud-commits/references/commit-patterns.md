# Commit Patterns

## Contents

1. Atomicity test
2. Split patterns
3. Index techniques
4. Rewrite safety
5. Handoff audit

## Atomicity test

A commit is acceptably atomic when:

- its subject describes one outcome
- every changed hunk contributes to that outcome
- required tests or fixtures travel with the behavior
- reverting it does not require unrelated reverts
- review does not require mentally separating mechanical and semantic changes
- the tree is valid under the repository's stated checks

Atomic does not mean tiny. A cross-layer feature can be one commit when its parts are inseparable and independently valid only together.

## Split patterns

| Mixed change | Preferred split |
| --- | --- |
| Rename plus behavior edit | Pure rename first, behavior second |
| Formatting plus logic | Formatting first or last, isolated |
| Refactor plus feature | Behavior-preserving refactor first, feature second |
| Dependency bump plus usage | Bump/lockfile first if independently valid, usage next |
| Schema plus consumers | Migration contract first, consumers in dependency order |
| Generated output plus source | Keep together and record generator command |
| Bug fix plus regression test | Keep together unless test-first history is intentionally useful |

## Index techniques

- `git diff --cached --check`: catch whitespace errors in the staged snapshot.
- `git diff --cached --word-diff`: inspect dense text changes.
- `git diff --cached --submodule=log`: audit submodule pointer changes.
- `git add -p`: select hunks from mixed tracked files.
- `git reset -p`: interactively unstage hunks when supported, without touching working files.
- `git restore --staged -- <path>`: unstage exact paths while keeping working changes.
- `git add --pathspec-from-file=<file>`: stage a reviewed long path list; use NUL mode for unusual names.

Quote pathspecs or prefix them with `--` so filenames cannot be mistaken for options. Inspect submodule, executable-bit, symlink, and rename changes explicitly.

## Rewrite safety

Before an interactive rewrite:

```bash
branch=$(git branch --show-current)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
git branch "backup/$branch/$stamp" HEAD
```

Then use fixup commits and autosquash. Compare old and new series:

```bash
git range-diff <old-base>..<backup-ref> <new-base>..HEAD
```

Delete the backup only after verification and publication. Do not set `rebase.updateRefs=true` casually in a multi-agent repository; it may move other local branch refs.

## Handoff audit

Before handoff, report:

```bash
git status --short --branch
git log --reverse --format='%H %s' <base>..HEAD
git diff --stat <base>...HEAD
git diff --check <base>...HEAD
```

Also report the exact validation commands and outcomes. Call out intentionally untracked files, ignored generated output, submodule changes, large binaries, file-mode changes, and commits not intended for integration.
