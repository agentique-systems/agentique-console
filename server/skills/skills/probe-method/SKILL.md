---
name: probe-method
description: Settling an empirical question with a minimal probe — one falsifiable hypothesis, a reproducible harness, published numbers, and the willingness to falsify your own prior conclusion.
version: 1.0.0
provenance: canonized from the straf3 run's wasm-determinism and dettrig-accuracy probes, 2026-08-15
status: validated
requires:
  tools: [Bash, Write]
whenToUse: When a decision depends on a fact about runtime behavior, an environment, or a dependency that reading code cannot settle (numeric determinism, performance envelopes, platform quirks).
costNote: ~35 lines when invoked; a good probe replaces hours of speculation.
---

# Probe method

The best work of the run this skill comes from was three probes — one of
which existed specifically to falsify another's conclusion, and did. That is
the standard.

## Shape of a probe

1. **One falsifiable hypothesis**, written first: "native and wasm builds
   produce bit-identical trajectories for N commands × M angles."
2. **A minimal reproducible harness**: its own directory (`probes/<name>/`),
   own manifest, a README with the exact commands, and NO dependence on the
   main build. Someone must be able to re-run it from the README alone.
3. **Measured output, not impressions**: counts, ULPs, bytes, milliseconds,
   written to files the report cites. "Bit-identical except 3 sin_cos calls
   at step.rs:955-957, diverging 1 ULP at command 1791" — not "mostly
   identical".
4. **Independent ground truth** when the probe validates a fix: derive the
   expected values a second way, or the probe merely tests that the fix
   agrees with itself. (The run's second probe falsified the first's
   own-trig threshold exactly this way: 8192°, not 16384°.)
5. **A conclusion that names its scope**: what was measured, on what
   host/toolchain, and what was NOT covered.

## Report

State hypothesis → method → numbers → verdict → scope limits, in that
order, with paths to the harness and raw output. A falsified hypothesis is
a full success — say plainly what it overturns.
