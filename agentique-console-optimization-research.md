# Agentique Console: Output Quality and Value-per-Token Research Report

**Date:** 2026-08-05  
**Repository snapshot:** `2b01b04` — `feat: add AI elements for task queue and task management`  
**Branch:** `main`  
**Repository state at time of research:** Clean  
**Verification:** TypeScript checks passed; 188 tests passed across server and web workspaces.

## Executive summary

Agentique Console already implements several valuable harness optimizations:

- persistent orchestrator sessions
- durable agent sessions and mailbox delivery
- coalesced milestone wake-ups
- bounded context rotation
- profile-specific tools, permissions, models, and effort
- global and per-session concurrency limits
- structured participant output
- sandboxed process and browser tools
- durable usage and provider-history records

Its main limitation is not the lack of optimization ideas. It is the lack of an experimental control plane capable of proving whether an idea improves quality, latency, reliability, or value per token.

The strongest research direction is to turn fixed policies into measurable, versioned, adaptive policies:

1. Build a full experiment and evaluation kernel.
2. Add quality-anchored model, effort, and budget routing.
3. Replace recency-based context rotation with indexed working memory.
4. Redesign high-volume tools around bounded, task-shaped outputs.
5. Compare the current double harness against equal-budget alternative topologies.
6. Allocate planning, verification, and parallel inference according to measured risk.
7. Use native Claude Agent SDK Skills for just-in-time specialization.
8. Learn from traces offline before allowing constrained online routing.
9. Investigate shadow counterfactuals as the first unconventional experiment.

These are provisional directions selected during the interview, not implementation commitments. They should receive independent technical review before implementation.

---

## 1. Current architecture

### Main orchestrator

The main orchestrator runs as a persistent streaming Claude Agent SDK conversation. Operator messages are either queued or injected into the active stream as steering input.

Its tool surface is intentionally read-only:

- `Read`
- `Glob`
- `Grep`
- web search and fetch
- Console delegation and task tools

Writing, shell execution, and native SDK delegation are denied. Consequently, substantive implementation must normally pass through an AgentSession.

Material AgentSession reports wake the main orchestrator. Repeated pending reports from the same AgentSession are coalesced, and duplicate operator-facing responses from wake turns are suppressed.

### Managed AgentSessions

Each AgentSession contains:

- one coordinator
- one to four specialists
- independently resumable provider sessions
- profile snapshots
- an enforced `main ↔ coordinator ↔ specialist` communication topology
- durable mailbox delivery and acknowledgement

Profiles define instructions, model, effort, tools, permissions, turn limits, sandbox requirements, and runtime capabilities.

### Persistence and recovery

SQLite stores:

- messages and mailbox delivery state
- user and agent turns
- events
- tool calls and results
- interactions and plans
- tasks
- usage samples
- large artifacts
- provider transcript entries

The SDK session store is mirrored eagerly into SQLite. Recovery logic handles interrupted turns and unacknowledged deliveries.

### Context management

Participants rotate to a new provider session when either threshold is exceeded:

- 120,000 context tokens
- 30 model turns

Rotation preserves up to 4,000 characters drawn from the most recent relevant mailbox messages. The main orchestrator uses a similar generation and memory mechanism.

This protects availability, but the retained memory is based primarily on recency and truncation. It does not distinguish enduring constraints from obsolete observations or provide references back to exact evidence.

---

## 2. Existing strengths

Several current design decisions already support good value per token:

- Persistent main sessions avoid repeated initialization and preserve provider-side caching opportunities.
- Wake coalescing reduces unnecessary orchestrator turns.
- The star topology limits unbounded agent chatter.
- Profile-specific tool surfaces reduce irrelevant tool definitions and accidental capability use.
- Durable artifacts prevent large outputs from bloating event rows.
- Long-running processes expose blocking reads, avoiding polling turns.
- Structured participant output reduces ambiguous termination.
- Context rotation prevents unlimited history growth.
- A cheaper, low-effort model is already used for composer rewriting.
- Model and effort overrides already exist at global and profile levels.

The architecture therefore provides good seams for experimentation without requiring a complete rewrite.

---

## 3. Measurement gaps

The `usage_samples` table currently records:

- input tokens
- output tokens
- cost
- participant/profile/generation
- turn ID

This is insufficient for controlled optimization.

Notably, the SDK mapper combines ordinary input, cache-creation input, and cache-read input into one value. Agentique therefore cannot currently determine whether prompt caching is working or compare cached and uncached economics.

Missing measurements include:

- experiment and arm identity
- complete policy snapshot
- requested and effective model
- thinking and effort configuration
- task budget and termination reason
- cache-write and cache-read tokens
- queue, provider, tool, and end-to-end latency
- retries and rate-limit delays
- tool-result tokens
- coordination-only tokens and turns
- router decisions and rejected alternatives
- operator interventions
- deterministic acceptance results
- rubric and human quality scores
- rework, rollback, and regression outcomes

Without these, an optimization may merely move cost between participants or improve apparent speed while reducing completion quality.

---

## 4. Evaluation foundation

The selected objective is:

> Prioritize output quality while maximizing useful value produced per token.

This should not be collapsed into one scalar score. The experiment system should report a Pareto frontier across:

- task completion
- correctness and acceptance
- useful work produced
- input, output, cache, and reasoning tokens
- monetary cost
- latency
- reliability and variance
- operator effort
- coordination overhead

A candidate should normally satisfy a quality non-inferiority floor before efficiency gains are considered.

### Evaluation corpus

The selected corpus is hybrid:

- reproducible seeded tasks
- sanitized real Agentique tasks
- hidden held-out tasks reserved for confirmation

Task families should span:

- repository exploration
- diagnosis
- contained implementation
- cross-component changes
- testing and review
- frontend work
- external research
- planning
- ambiguous interactive requests
- long-running incremental work

### Layered grading

Use the least subjective valid grader:

1. deterministic checks and workspace invariants
2. task-specific acceptance tests
3. diff-scope and safety checks
4. blinded rubric grading for open-ended properties
5. sampled human pairwise review

Graders and hidden tests must remain outside agent-writable workspaces. Evaluation integrity is itself a failure mode for autonomous agents.

Anthropic similarly recommends examining full trajectories, task outcomes, tool errors, token consumption, and runtime rather than relying only on final-answer grading. See [Demystifying agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [evaluating agent tools](https://www.anthropic.com/engineering/writing-tools-for-agents).

---

## 5. Candidate optimization portfolio

### 5.1 Quality-anchored inference routing

A task-characterization stage would estimate:

- ambiguity
- risk and reversibility
- decomposability
- sequential dependency
- verification strength
- expected tool density
- context size
- novelty
- likely failure cost

A versioned policy would then select:

- topology
- model
- effort/thinking level
- token or monetary budget
- verification depth
- escalation conditions

The selected strategy is quality-anchored rather than universally cheap-first:

- bounded, predictable, strongly verifiable work may use efficient inference;
- ambiguous, consequential, novel, or weakly verifiable work routes directly to stronger inference;
- failed checks, contradictions, repeated tool errors, or stalled progress trigger escalation.

Settings should initially adapt at phase and role boundaries. Changing them every turn would increase session churn and may reduce prompt-cache reuse.

The policy should start as inspectable rules. After sufficient data exists, a constrained contextual bandit may compete with the frozen rule policy. Contextual-bandit research shows potential for improving multi-model quality/cost trade-offs, but Agentique's delayed, multi-turn rewards make local validation essential. See [Online multi-LLM selection](https://ojs.aaai.org/index.php/AAAI/article/view/39672).

### 5.2 Adaptive test-time compute

Reasoning effort, retries, verification, and alternate candidates should draw from a shared task budget.

Additional compute is granted only when:

- a deterministic or independent check fails;
- evidence is contradictory;
- the task reaches a consequential uncertain decision;
- the expected benefit exceeds the added token and latency cost.

Hard caps and diminishing-return rules are required. Repeated self-critique without new evidence should not earn more compute.

### 5.3 Indexed working memory

The selected context candidate replaces the current 4,000-character recency tail with typed state:

- objective and acceptance criteria
- operator decisions
- hard constraints
- task and dependency state
- artifact and symbol references
- evidence-backed claims
- failed approaches
- unresolved questions
- next action

The compact state should reference exact journal entries and artifacts. Full evidence is retrieved only when relevant.

Before each phase or generation, a context manifest should record:

- available token budget
- selected items
- excluded items
- selection reason
- source and freshness
- estimated token cost

This makes lost constraints and context bloat observable. Recent compression research reports substantial reductions in peak context with limited performance loss, although these results remain task- and implementation-dependent. See [ACON](https://arxiv.org/abs/2510.00615).

### 5.4 Project experience memory with anti-rot controls

Cross-task experience reuse was selected only conditionally because stale project guidance could be worse than no memory.

The experience store must be separate from authoritative project facts. Each entry should include:

- provenance
- supporting evidence
- workspace and dependency fingerprints
- policy, model, skill, and tool versions
- assumptions and validity conditions
- executable revalidation checks where possible
- creation and last-validation times
- successful and contradictory uses

Retrieved experience must be presented as a candidate prior lesson, not as current truth. Changed files, schemas, dependencies, tests, or tool versions should invalidate affected entries. Contradictions should demote or retire them.

A no-experience control arm is mandatory. If revalidation cost or stale-guidance frequency outweighs saved work, the feature should be rejected.

Record-and-replay research gives this direction a technical basis, but it should be treated as exploratory. See [Agent Record & Replay](https://arxiv.org/abs/2505.17716).

### 5.5 Bounded and compound tools

The selected tool strategy includes:

- token-aware response limits
- filtering and projections
- pagination and cursors
- actionable truncation messages
- full-output artifacts
- repository structure and symbol views
- focused diff summaries
- test-failure extraction
- evaluated compound read-only operations

Each tool should report:

- result tokens
- execution time
- errors
- truncation
- subsequent reuse
- downstream success

Agent-facing tools should return decision-relevant information rather than raw API-shaped data. Anthropic identifies output filtering, pagination, namespacing, focused descriptions, and task-shaped tools as important sources of agent quality and token efficiency. See [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).

Dynamic tool search is deferred. Anthropic positions it primarily for much larger toolsets, while current profiles expose comparatively few tools. See [Managing tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context).

### 5.6 Caching

Three caching mechanisms should remain distinct:

- **Provider prompt cache:** low-risk; instrument cache reads and writes accurately.
- **Deterministic tool cache:** reuse read-only results only when workspace state, arguments, tool version, and permissions match.
- **Semantic experience reuse:** higher-risk; requires evidence and revalidation.

Caching final agent answers is not recommended for mutable software-development contexts. Exact deterministic operations and stable prompt prefixes are safer targets.

Anthropic reports major cost and latency reductions from prompt caching on long stable prefixes, but Agentique must measure its actual persistent-session hit rates. See [Token-saving API updates](https://www.anthropic.com/news/token-saving-updates).

### 5.7 Adaptive execution topology

The current double harness should remain an experimental arm, not the unquestioned default.

Equal-budget comparison arms should include:

- one generalist worker
- one worker with selective independent verification
- the current centralized star
- parallel specialists with centralized synthesis
- selective branch-and-choose execution

The router should choose topology using task properties rather than workflow names.

This comparison is important because current main-agent restrictions prevent a true single-worker implementation baseline. Any fair experiment must equalize model access, tools, permissions, token budgets, and acceptance checks.

A controlled study across agent architectures found that centralized multi-agent execution helped parallelizable tasks but could substantially degrade sequential and tool-heavy tasks. It also found greater error amplification in uncoordinated systems. See [Towards a Science of Scaling Agent Systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/).

### 5.8 Risk-triggered rolling planning

The selected planning policy triggers explicit planning based on:

- ambiguity
- dependency depth
- irreversibility
- failure impact
- coordination needs

The plan should be an executable contract containing:

- goal
- constraints
- owned step
- expected artifact
- dependency
- verification
- stop or escalation condition

Only the near horizon should be detailed. Later steps are refined after new evidence arrives.

This should be compared with both no-plan and complete-upfront-plan arms under matched budgets. Long-running-agent work from Anthropic supports incremental progress and durable feature/acceptance state over attempts to solve an entire project in one context. See [Effective long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

### 5.9 Deterministic-first verification

The selected verification ladder is:

1. schema and permission checks
2. diff-scope and invariant checks
3. build, test, lint, and type checks
4. task-specific acceptance tests
5. mutation or adversarial checks where justified
6. independent model review for residual subjective properties
7. human review for consequential ambiguity

A separate reviewer should not be paid for every trivial success. Conversely, actor self-review should not be treated as independent evidence.

### 5.10 Selective trajectory branching

Rather than running several complete candidates, branch only at consequential uncertain decisions:

- competing diagnoses
- architectural alternatives
- repair strategies
- ambiguous interpretations

Shared exploration is retained, and independent checks select the branch. The installed SDK supports resume and session forking.

SWE-Replay reports that reusing earlier trajectory work can outperform naive repeated software-agent runs at lower cost, but this requires local replication. See [SWE-Replay](https://arxiv.org/abs/2601.22129).

### 5.11 Native SDK Skills

The earlier “capability packet” proposal maps directly to Claude Agent SDK Skills and should not introduce a competing format.

Skills provide:

- filesystem-based `SKILL.md` bundles
- metadata discovery at startup
- on-demand full-content loading
- explicit selection through the SDK `skills` option
- plugin-qualified skill names

See [Agent Skills in the SDK](https://code.claude.com/docs/en/agent-sdk/skills).

The selected trust boundary allows Console-owned and project-authored skills. This needs careful design because Agentique currently uses `settingSources: []`. Enabling the project setting source may also load project instructions, settings, hooks, commands, and other configuration.

The independent review should assess whether project skills should be supplied through:

- explicit project plugins;
- a vetted skills-only staging plugin;
- or broader project setting-source loading with additional controls.

Each run must record skill names, source, plugin version, and content hashes. Persistent sessions should only change skill sets at controlled recycle boundaries.

### 5.12 Typed evidence-bearing handoffs

The current closing schema has only:

- message
- recipient
- category

A candidate schema should add:

- task ID
- result status
- changed facts
- evidence and artifact references
- checks performed
- uncertainty
- requested next action
- validity conditions

This may allow deterministic scheduling of routine transitions and reduce repeated prose. It should be evaluated against the current free-text protocol because schema overhead or rigidity could offset the benefits.

### 5.13 Offline prompt and tool optimization

The selected policy allows models to:

- cluster trajectory failures;
- identify recurring prompt and tool problems;
- propose revised prompts, skill descriptions, schemas, or tool contracts.

It does not allow automatic deployment.

Candidates should be evaluated on development tasks, then once against a dark held-out set. Promotion remains explicit and versioned.

Automatic prompt optimization has improved multi-stage LM systems in published experiments, but it creates a strong evaluator-overfitting risk. See [MIPRO](https://arxiv.org/abs/2406.11695).

### 5.14 Shadow counterfactuals

The selected unconventional experiment is shadow evaluation.

For sampled tasks, a shadow process records what alternate policies would have selected:

- model and effort
- topology
- context manifest
- skill set
- verification depth

Most shadow decisions remain non-executing. A smaller sample receives full paired execution to measure whether the shadow prediction was correct.

This can create training data for routing while limiting costly or risky live exploration. Its central metric is routing regret: the quality or value per token lost by the selected policy relative to the best tested alternative.

---

## 6. Deferred or rejected ideas

| Idea | Status | Reason |
|---|---|---|
| Universal cheap-first model cascade | Not selected | Failed first attempts may reduce both quality and total efficiency on difficult tasks. |
| Per-turn model switching | Deferred | Higher responsiveness but more session churn and cache disruption. |
| Provider-only context compaction | Control arm | Simple, but does not provide evidence-aware memory or diagnose omissions. |
| Cross-project semantic memory | Not selected | High contamination, privacy, and stale-guidance risk. |
| Dynamic tool search immediately | Deferred | Current tool surfaces are below the likely benefit threshold. |
| Always-on independent reviewers | Not selected | Predictable coordination and latency cost on easily verified tasks. |
| Actor-only self-review | Not selected | Correlated failure and weak independence. |
| Richer multi-agent topology as the sole direction | Not selected | Must compete with equal-budget single-worker execution. |
| Automatically generated per-run system prompts | Deferred | Difficult to audit and version; native Skills offer a safer first step. |
| Automatic prompt/tool promotion | Not selected | High evaluator-overfitting and silent-regression risk. |
| Agent compute bids | Deferred moonshot | Interesting, but agents may systematically overstate expected benefit. |
| Agent-controlled active forgetting | Deferred moonshot | Higher risk of silently discarding enduring constraints. |
| Response-level semantic caching | Deferred | Mutable repository state makes apparently similar tasks unsafe to reuse. |
| Model fine-tuning/RL | Long-term only | Provider model access is limited; data and evaluation maturity should come first. |

---

## 7. Core hypotheses for independent review

1. Complete instrumentation will expose enough coordination and cache waste to change optimization priorities.
2. Quality-anchored routing will preserve or improve quality while reducing unnecessary flagship-model inference.
3. Phase/role routing will outperform both whole-session and per-turn routing after cache and churn are included.
4. Indexed working memory will reduce input tokens without increasing lost-constraint failures.
5. Bounded, task-shaped tool outputs will reduce tokens, redundant calls, and invalid tool use.
6. An adaptive topology policy will outperform the current mandatory star on value per token.
7. Rolling planning will outperform complete upfront planning on long or uncertain tasks.
8. A deterministic-first verification ladder will retain most reviewer quality gains at lower cost.
9. Native skill selection will improve specialization without the fixed context cost of embedding all guidance in profiles.
10. Project experience memory will only help if revalidation is cheaper than rediscovery and stale guidance remains rare.
11. Offline prompt optimization will improve held-out outcomes rather than merely development scores.
12. Shadow policy predictions will be accurate enough to train routing with fewer complete counterfactual executions.

---

## 8. Principal risks and counterarguments

- The experiment kernel may become more complex than the harness it evaluates.
- Router inference may consume more tokens than it saves.
- Quality graders may encode stylistic preferences rather than task value.
- LLM judges may favor outputs from related model families.
- Real task replays may not be reproducible because repositories and dependencies evolve.
- Equal token budgets may not imply equal monetary or latency budgets.
- Multi-agent systems may appear better merely because they receive more aggregate compute.
- Prompt caching can hide true context growth unless cached token categories remain separate.
- Bandit rewards will be delayed, sparse, and non-stationary.
- Skills and project memory introduce prompt-injection and stale-guidance surfaces.
- Typed handoffs may omit useful nuance that free text retains.
- Compound tools may overfit common workflows and reduce generality.
- Multiple simultaneous optimizations will make causal attribution impossible.
- Provider and SDK changes may invalidate historical comparisons.

The experimental program should therefore change one policy family at a time, retain frozen controls, and record complete version manifests.

---

## 9. Questions for a second-opinion reviewer

1. Is a full experiment kernel justified before smaller policy experiments?
2. Which quality measures best represent “useful work” across heterogeneous tasks?
3. Can single-worker and double-harness arms be made genuinely comparable?
4. Which task properties can be observed before execution without using an expensive classifier?
5. Are phase/role boundaries stable enough for routing and skill selection?
6. What information must indexed memory preserve unconditionally?
7. Can project experience be invalidated reliably enough to avoid rot?
8. Should project skills be loaded through standard setting sources or isolated plugins?
9. Does the proposed verification ladder provide sufficient independence?
10. How should routing and coordination overhead be normalized?
11. What sample sizes and repetition counts are realistic given model cost and task variance?
12. Is a contextual bandit warranted, or would periodically fitted rules remain easier to audit?
13. Can shadow outcomes be calibrated without executing too many counterfactual arms?
14. Which proposals duplicate existing Claude Agent SDK behavior?
15. Which optimization poses the greatest risk of improving benchmark scores while reducing real operator value?

