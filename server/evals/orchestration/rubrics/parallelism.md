# parallelism

**Question:** Did independent work run concurrently, and dependent work not pretend to?

- **5** — Genuinely independent workstreams overlapped; the critical path was the actual constraint; no false parallelism over shared unknowns.
- **3** — Some available overlap unused, or minor coordination cost from overlapping too eagerly.
- **1** — Strictly serial despite independence, or parallel workers colliding on the same unresolved decision.
