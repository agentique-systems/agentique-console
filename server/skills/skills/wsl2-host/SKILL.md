---
name: wsl2-host
description: Quirks of a WSL2 host that change engineering conclusions — software-only GPU, untrustworthy frame pacing, browser flags, subprocess buffer limits.
version: 1.0.0
provenance: distilled from the straf3 live run's environment probe, 2026-08-15
status: draft
requires:
  tools: [Bash]
whenToUse: When measuring performance, driving a browser or GPU path, or interpreting timing/rendering results on a WSL2 host.
costNote: ~30 lines when invoked.
---

# WSL2 host quirks

Conclusions that are wrong on WSL2 unless you know the substrate:

## GPU and rendering

- The GPU path is typically SOFTWARE-ONLY (lavapipe/llvmpipe over RDP):
  rendering works, but performance numbers are meaningless as native
  measurements. Say "measured under software rasterization" in any report.
- Frame pacing and input latency cannot be trusted here; tuning that
  depends on them needs a native host and should be reported as blocked-on-
  environment, not attempted and reported as fact.
- Headless Chromium needs `--no-sandbox --disable-gpu` (or
  `--use-angle=swiftshader`) under most WSL2 setups; a silent hang at
  launch is usually the sandbox, not your code.

## Filesystem and processes

- Cross-OS paths (`/mnt/c/...`) are an order of magnitude slower than the
  Linux filesystem; keep build trees and caches under the Linux side.
- Subprocess output buffers matter: multi-MB stdout (large diffs,
  `git ls-files` over unignored build dirs) can exceed default buffers —
  pipe to files rather than capturing giant stdout.
- Long-running builds behave normally, but wall-clock measurements taken
  under RDP/remote sessions include scheduling noise; repeat measurements
  before concluding a regression.

## Memory pressure

- The WSL2 VM has a hard RAM ceiling (often well below the host's total)
  and disk-backed swap; several concurrent full-workspace builds fit in
  neither. Bound link parallelism (`CARGO_BUILD_JOBS=4` or `cargo ... -j4`)
  and prefer package-scoped builds (`cargo test -p <crate>`) over
  `--workspace` when the question is package-scoped.
- Never run more than one full-workspace build/test at a time across seats;
  say so in your report if you queued behind a teammate's build.
- If a build is OOM-killed (exit 137 / "signal: 9"), report it as memory
  pressure with the concurrent load you observed — do not retry into the
  same pressure.
