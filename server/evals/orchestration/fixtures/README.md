# Fixture workspaces for Tier B live scenarios

Committed, deterministic, zero-install — a clean checkout runs them.

- `empty-workspace` is implicit (no directory needed): greenfield scenarios.
- `small-cli/` — `reading-tracker`, a plain-JS CLI (add/list/finish/--version)
  with a `node --test` suite. Serves trivial-no-delegation, well-specified,
  suboptimal-framing, wasteful-parallelism, parallel-exploration,
  two-perspectives-better, ambiguous-signal, reviewer-invalidates-spec,
  restart-honesty, visual-judgment. Its shape is load-bearing: exactly one
  `JSON.parse` site (src/store.js), exactly three `fooBar` call sites, the
  default data path in `DATA_FILE`.
- `pinned-node-repo/` — a legacy CommonJS site builder pinned to Node 18
  (`.nvmrc` + `engines`). Serves hidden-constraint: the pin is the hidden
  constraint a modernization must discover.

The live runner seeds the fixture into a fresh workspace and commits it as
`fixture-baseline`, the anchor for the artifact diff. Validate a fixture
after editing it: `npm test` inside its directory must stay green, and the
load-bearing shapes above must survive.
