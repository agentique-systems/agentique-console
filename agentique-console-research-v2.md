# Agentique Console Research v2: Multi-Agent Coordination — What Actually Degrades, Why, and How to Beat It

**Date:** 2026-08-05
**Repository snapshot:** `2b01b04` — `feat: add AI elements for task queue and task management` (clean tree)
**Supersedes:** `agentique-console-optimization-research.md` (v1, retained for reference)
**Method:** Four independent investigations against v1 (two file:line codebase audits, an industry-practice sweep, an academic citation-verification sweep), an operator interview, and three follow-up research streams on multi-agent coordination (learned coordination, pipeline-composition theory, context-rot quantification).

---

## 1. Executive summary

The central question of this report, set by the operator after reviewing v1: **multi-agent systems degrade sequential tasks by 39–70% under matched compute (Google/MIT, arXiv 2512.08296). Is that fundamental, or an artifact of bad algorithms and architecture — and what would a multi-agent design that beats single-agent look like?**

**The verdict (argued in §4–§6): the operator's intuition is substantially vindicated, with a precise boundary.** The 39–70% figure is a measurement of the *untrained-relay regime* — prompt-coordinated frozen models exchanging unstructured natural-language summaries at ~4,800-token budgets — not a law of multi-agent systems. The degradation decomposes into four loss terms (handoff information loss, error amplification, coordination tax, context fragmentation) plus one offsetting term (context rot, which degrades the *single*-agent baseline too), and the 2026 record shows each loss term is either a design variable or already fixed somewhere with published numbers:

1. **The dominant term — handoff loss — is localized and trainable.** An information-bottleneck result (arXiv 2607.16133) proves multi-agent and single-agent are *equivalent under lossless relay*: the entire gap lives in the handoff encoder. Interventions on that encoder work: outcome-trained summarization cut compaction-induced error ~50% in production (Cursor Composer); learned fold policies gained +8.8% SWE-bench Verified at 10× smaller active context (FoldGRPO); workspace-as-state handoffs are the pattern three production teams independently converged on (Anthropic, Amp, Factory).
2. **Trained coordination reverses the naive deficit — including on strictly sequential tasks.** Dr. MAMR flips multi-agent from below to +3.1–7.5 points above single-agent RL on competition math after fixing a *provable* turn-normalization bias; AT-GRPO takes sequential planning from 14–47% to 96–99.5%; MAKER's gated voting executed a **million-step strictly sequential task at zero errors and log-linear cost** — an existence proof on exactly the task shape the degradation result says multi-agent must lose.
3. **What is genuinely fundamental is narrow and actionable**: information discarded by a handoff stays discarded (DPI — so never hand off less than a sufficient statistic); agents sharing one context provably add nothing (martingale — so multi-agent value requires participants that *observe different things*); coordination cost is never zero (so don't decompose short sequential tasks at all — even Kimi's RL-trained production orchestrator learns to stay single-threaded there).
4. **On long horizons the dichotomy dissolves.** A single frontier agent retains only ~0.75–0.85 of its capability at 512K–1M tokens on retrieval-shaped work (~0.5 on structure-shaped), times a ~0.6–0.9 multi-turn-accumulation factor — and every production harness compacts at 150–200K, the vendors' own revealed estimate. Past that threshold the "single agent" must segment too, and the contest is decided by handoff fidelity. **The console's context rotation is already a sequential multi-agent handoff** (generation *n* → *n+1*); its current encoder — the last 4,000 characters by recency — is a worst-case design, while its durable journal already preserves everything the encoder throws away.
5. **The honest residual**: relay-loss sensitivity *grows* with model capability, no trained-MAS result yet beats a matched frontier single agent on a strictly sequential benchmark, and frontier single agents are being trained up simultaneously. The race is live; the console should build the interfaces both sides reward — externalized state, high-fidelity handoffs, deterministic gates, asymmetric-observation seats.

**What this means for Agentique Console** (§8, ranked): agent-authored handoffs replacing the recency slice; workspace-as-sufficient-statistic as mechanism, not advice; deterministic gates plus one fresh-context reviewer; cache-disciplined persistent seats; a single-seat lane so sequential tasks skip the coordinator hop — routed by an estimable delegate-or-not rule (§5.3). Per the operator's decisions, nothing is implemented now except that the **telemetry upgrade (Appendix A) is fully designed and ready**: without the cache split, model/effort identity, and per-turn latency, every claim in this report is unfalsifiable *on this system*. §2 records the full critique of v1: all seven citations verified (two framing corrections), five ideas dropped with evidence, and the codebase facts v1 missed.

---

## 2. Critique of v1 (what survived verification, what didn't)

### 2.1 Claim verification against the code

| v1 claim | Verdict | Evidence |
|---|---|---|
| SDK mapper collapses plain / cache-write / cache-read input tokens into one number; cache hit rate unmeasurable | **TRUE** | `server/src/sdk/mapping.ts:227-229`, `:249-255`; all three fields exist on the wire type (`sdk/types.ts:49`) and are discarded |
| `usage_samples` too thin for controlled optimization | TRUE — understated | No latency instrumentation anywhere in the server; no `tool_calls`/`turns` tables; model identity, effort, turn trigger, and termination status never recorded (`db/ddl.ts:169-182`) |
| Persistent orchestrator lane; star topology enforced; durable mailbox with acknowledgement; wake coalescing; blocking process reads; oversized payloads become artifacts | TRUE | `orchestrator/runner.ts:329-412`; `agent-sessions/host.ts:291-299` (route assertion), `:338/:405/:420` (delivery FSM); `runner.ts:156-163` (coalescing), `:580-585` (duplicate suppression); `host.ts:448` + `runtime/process-manager.ts:55-64` (`waitMs`); `events/bus.ts:71-86` |
| Rotation at 120k tokens / 30 turns preserving ≤4,000 chars | TRUE — but the memory is a mechanical recency slice, not "structured memory": last ~20 seat-relevant messages, `.slice(-4000)` (`host.ts:517-518`); main uses last ~24 transcript rows (`runner.ts:701-703`) |
| Closing output schema `{message, recipient, category}` | Minor error — the field is `to`, not `recipient` (`host.ts:63-72`) |
| Orchestrator "tool surface is read-only" | Overstated — it is an 11-tool denylist plus a **permissive default**: anything not denied is allowed (`orchestrator/permissions.ts:124-128`) |
| `settingSources: []` — no filesystem skills/CLAUDE.md/hooks | TRUE — all three query sites (`options.ts:66`, `host.ts:368`, `improve.ts:43`) |
| Model/effort overrides exist at global and profile level | TRUE but **unused**: none of the 7 built-in profiles sets `model` or `effort` (`agent-profiles/registry.ts:27-98`). In a default install every participant runs on the SDK default model at default effort. The only routing in the system is the composer rewrite (`claude-sonnet-5` at `effort:"low"`, `compose/improve.ts:49-50`) |

What v1 missed in the code:

- **Unbounded model-facing tool results.** Only event *storage* is artifact-capped (16 KiB, `bus.capture`). What the model receives is uncapped: `read_agent_session` without `limit` returns the entire transcript (`host.ts:191-192`); `task_list` is unbounded; `process_read` results are uncapped (256 KiB ring). `mapping.capJson` is dead code.
- **~380 lines of dead code** from the reverted native-subagent architecture (`spawn-hook.ts`, `presets.ts`, `tasks/hooks.ts`, the `#legacyBindings` seam in `host.ts`), plus a stale comment in `recovery.ts:12-22` describing the reverted design. Commit `7130086` moved to native SDK subagents; HEAD reverted to Console-managed seats.
- **No SDK feature reuse**: compaction, context editing, the memory tool, skills, hooks, and session forking are all unused; context management is hand-rolled.
- **No evaluation infrastructure of any kind**: `scripts/smoke.ts` is the only real-SDK harness and asserts nothing.

### 2.2 Citation check

All seven v1 citations are real. Two framing corrections matter:

| Source | Correction |
|---|---|
| Agent Record & Replay (arXiv 2505.17716) | A framework/position paper — **no empirical results**. v1 cited it as the "technical basis" for experience reuse; it is evidence only that the architecture has been articulated. |
| SWE-Replay (arXiv 2601.22129) | Real and accurately summarized, but gains are modest (≤ +3.8pp, −17.4% cost) and scoped to **repeated attempts at the same task set** (test-time scaling), not general cross-task experience reuse. |
| Google/MIT scaling study (arXiv 2512.08296) | Accurately cited; note the predictive framework's cross-validated R² is ~0.37–0.41 — directional findings are solid, the "predictive science" framing is aspirational. Benchmarks are Finance-Agent, BrowseComp-Plus, PlanCraft, Workbench — **no SWE-bench-style coding task**. |
| ACON (arXiv 2510.00615) | Understated by v1: not just "limited performance loss" — 26–54% peak-token reduction **with accuracy gains up to +46% for smaller models** (less context distraction). Accepted ICML 2026. |

### 2.3 Rulings on the v1 portfolio (operator decisions recorded)

**Kept, sharpened:** the measurement diagnosis (scoped down from an "experiment kernel" to a telemetry fix — operator chose telemetry-only, deferring even the eval suite); bounded/task-shaped tools (now with the concrete targets above); caching (promoted from "one of three mechanisms" to the top cost lever — see §3.5); deterministic-first verification (collapsed from a 7-rung ladder to deterministic gates + one fresh-context reviewer; per current-model guidance, instructed self-verification scaffolding should be *removed*, not added); native SDK skills (deferred); rolling planning (folded into prompt guidance — plan/execute phases already exist).

**Dropped outright (operator confirmed, no deferred tracks):**

| v1 idea | Why it died |
|---|---|
| §5.1 Quality-anchored routing (task characterizer → versioned policy → contextual bandit) | No model/effort assignment exists at all yet; learned routing needs fleet-scale data (Cursor's router — the only shipped learned router — trained on 600k+ live requests); 2026 evidence (SWE-Router, arXiv 2607.00053) shows routing must condition on the **live trajectory**, not prompt-level task characterization, invalidating the design; a contextual bandit cannot converge at single-operator traffic volume |
| §5.2 Adaptive test-time compute economy | Rebuilds what the API ships (`effort`, task budgets); per-call thinking plateaus fast on coding (67.3/68.4/68.7% at 8k/16k/32k thinking budgets — Confucius Code Agent, arXiv 2512.10398); extended reasoning can flip correct answers wrong (arXiv 2604.10739) |
| §5.3 Indexed working memory + context manifests | The typed-state store and per-phase manifest logs are token-funded bureaucracy; the industry converged on a simpler mechanism that works (§8.1) |
| §5.4 Project experience memory with anti-rot controls | 2026 evidence is net-negative for exactly this feature class: "Beyond pass@1" (arXiv 2603.29231, 10 models, 23,392 episodes) — memory scaffolds **universally hurt** long-horizon performance; CTIM-Rover (arXiv 2505.23422) — episodic memory adds noise to SWE agents; AgentLongBench — memory augmentations don't reliably beat base context |
| §5.7 Five-arm equal-budget topology study | Unaffordable without an eval harness and mostly answered by the literature; replaced by the one comparison that matters (§8.5) |
| §5.10 Selective trajectory branching | Deferred — modest measured gains, needs eval infra first; SDK session forking keeps it cheap to try later |
| §5.12 Typed evidence-bearing handoffs (full schema) | Over-structured; v1 itself flagged the rigidity risk. A minimal extension (`taskId`, `status`) survives inside §8.1 |
| §5.13 Offline prompt optimization (MIPRO/GEPA) | GEPA is real and strong (ICLR 2026 oral; >10% over MIPROv2, ~6% over RL at 35× fewer rollouts) but requires the eval corpus that doesn't exist; no published evidence it beats expert hand-tuning of a *full agent harness*. Manual prompt audit first |
| §5.14 Shadow counterfactuals | v1's weakest idea: shadow-routing a router that doesn't exist, at a volume that can't train it, against ground truth that isn't collected |

---

## 3. The evidence, read precisely

Before modeling, the record — with token accounting made explicit, because it decides what each study actually shows.

### 3.1 The degradation result

**Google Research + DeepMind + MIT, "Towards a Science of Scaling Agent Systems" (arXiv 2512.08296, Dec 2025; blog Jan 28 2026).** ~180–260 configurations, 5 architectures, 3 model families, standardized tools/prompts/compute. Findings:

- Centralized coordination: **+80.9%** on parallelizable/decomposable tasks (financial reasoning).
- **Every multi-agent variant degraded sequential-reasoning tasks by 39–70%** (PlanCraft).
- Error amplification: **17.2×** for independent (uncoordinated) agents vs **4.4×** for centralized coordination.
- Tool-coordination overhead grows disproportionately past ~16 tools; the paper's own rule of thumb: "switch to multi-agent only if the task decomposes AND single-agent success <45%."
- Caveats that bound what the number means: no SWE-bench-style coding benchmark; the predictive model's headline R² is 0.513 (cross-validated 0.37–0.41); **all coordination in the study was prompt-based over frozen models — there is no trained-coordination arm**; and the matched budgets averaged only ~4,800 reasoning tokens per trial, so the coordination tax is proportionally enormous relative to production budgets of 50k+. No formal replication or author follow-up exists as of Aug 2026; the 43-paper citation wave (§3.6) decomposes the mechanism rather than attacking the result.

### 3.2 The matched-budget result

**Tran & Kiela (arXiv 2604.02460, Apr 2026).** Under *matched reasoning-token budgets*, single-agent matches or beats multi-agent on multi-hop reasoning across Qwen3, R1-Distill, Gemini 2.5. The argument is grounded in the Data Processing Inequality; the authors conclude that "many reported advantages of multi-agent systems are better explained by unaccounted computation and context effects." This is the cleanest statement of the null hypothesis this report must answer.

### 3.3 The successes, with their price tags

- **Anthropic multi-agent research system (June 2025):** orchestrator + 3–5 parallel subagents beat single-agent Opus 4 by 90.2% on internal research evals — a breadth-first, parallelizable task shape — at **~15× chat-level token cost**, with token spend explaining ~80% of performance variance. Multi-agent won partly *by spending more*.
- **Cognition (June 2025 → April 2026):** from "Don't build multi-agents" (context fragmentation, conflicting implicit decisions) to a measured revision: **writes stay single-threaded; additional agents contribute intelligence, not actions.** The robust wins: fresh-context read-only reviewer (avg 2 bugs/PR, 58% severe — and *isolation is why it works*: less context rot than the author's own polluted context); strong-model escalation ("smart friend"); structured manager delegation. Still failing in 2026: unstructured swarms, free-form agent-to-agent negotiation.
- **Anthropic harness-cost table (Mar 2026):** the same small app cost **$9 solo vs $200 under a heavy three-agent harness**; a simplified harness landed at $124.70. Harness scaffolding is a cost multiplier that must shrink as models improve.
- **Claude Opus 5 migration guidance (mid-2026):** the model now *over*-delegates by default and self-verifies without instruction — vendors are actively telling harness authors to delete delegation-encouragement and verification scaffolding.

### 3.4 The context-management convergence

Three independent production teams abandoned in-place summarization for **resets with structured handoff state**: Anthropic's long-running-harness posts (fresh context per feature + `claude-progress.txt` + machine-readable feature lists + git as memory), Amp (retired compaction for `/handoff` — a goal-directed extract seeding a fresh thread), and Factory (anchored iterative summarization with merge-not-regenerate, evaluated on 36,000 real session messages). OpenAI's counter-move — GPT-5.1-Codex-Max trained *natively* to work across context windows via compaction — confirms the same diagnosis from the training side: handoff quality is the bottleneck, so train it.

### 3.5 The economics floor

Agent workloads run ~100:1 input:output (Manus); cache reads cost ~0.1× base input, writes 1.25–2×; Claude Code measures **92.7% of prompt tokens read from cache** (Galileo, 2026). Cache discipline — stable prefixes, append-only context, no mid-session tool-set or model changes — is the single largest cost lever in any harness comparison, and any multi-agent design that re-establishes context per subtask pays the uncached price repeatedly. The 2026 API additions (mid-conversation system messages, `tool_addition`/`tool_removal` blocks, deferred tool loading) exist specifically to preserve cache across behavior changes.

### 3.6 The trained-coordination record (the evidence v1 and the Google study both lacked)

The 2025–2026 literature that *trains* the coordination instead of prompting it changes the picture materially:

**The handoff channel is trainable, with large measured gains.**
- **Cursor Composer self-summarization** (Mar 2026, shipped): the final task reward is applied to every token in the chain *including mid-rollout summaries*, so summaries that drop load-bearing information are downweighted by outcome. Result: **~50% reduction in compaction-induced error** vs a highly tuned prompted-summarization baseline, at ~1,000-token summaries vs 5,000+; solved a 170-turn task compressing >100k tokens to ~1k.
- **Context-Folding/FoldGRPO** (ByteDance, Oct 2025): learns branch-into-subtrajectory-then-fold-to-summary end-to-end; +8.8% on SWE-Bench Verified while matching ReAct with a **10× smaller active context**.
- **MEM1** (ICLR 2026): RL-trained constant-size memory state — 3.5× performance at 3.7× lower memory than a 2× larger instruct model.
- **ACON** (Microsoft): the guideline-optimization loop is gradient-free — diagnose paired success/failure trajectories, rewrite the compression guideline — so the optimized artifact is *plain text*, model-agnostic, and importable by API-only harnesses.
- **Learned channels beyond text**: Cache-to-Cache (ICLR 2026) — a learned KV-cache projection between models beats text communication by +3.0–5.0% at 2× lower latency, the most direct evidence that **the text handoff itself is a lossy bottleneck a learned channel can beat**; Optima (ACL 2025) — pricing tokens in the reward teaches agents a terser protocol (up to 88.5% token reduction, performance maintained).

**The coordination policy is trainable, and training reverses the naive deficit — including on sequential tasks.**
- **MAPoRL** (ACL 2025): co-trained small models improve monotonically with collaboration turns while frozen models plateau or decline; the skill is specifically *learned collaboration* (co-trained models tested alone perform like untrained ones) and transfers across domains and model pairs.
- **Dr. MAMR** (Nov 2025) — the cleanest sequential counter-example: on competition math (nothing to parallelize), the *untrained* multi-agent baseline underperforms single-agent GRPO (reproducing the Google pattern), and trained coordination **flips it**: +3.1 to +7.5 points over single-agent GRPO at 7B. The lazy-agent failure was traced to a provable turn-normalization bias in multi-turn GRPO — a fixable algorithm bug, not physics.
- **AT-GRPO** (Oct 2025): sequential long-horizon planning from a 14–47% single-agent-RL baseline to **96.0–99.5%** via role-specialized trained coordination — the largest trained-coordination delta on record (preprint).
- **M-GRPO** (Nov 2025): jointly trained planner+executors beat both single-agent GRPO *and* frozen-sub-agent MAS — the frozen-sub-agent configuration leaves gains on the table.
- **Kimi K2.5 Agent Swarm** (Feb 2026, production): the first shipped *trained orchestrator* (PARL over frozen sub-agents): +17.8pp over its own single agent on BrowseComp — on parallelizable wide-search. Its reward explicitly penalizes decorative parallelism, and the trained orchestrator **learns to stay single-threaded on sequential tasks** — production ML agreeing with the task-structure law rather than refuting it.

**The mechanism decomposition converged on the relay.** "When Do Multi-Agent Systems Help? An Information Bottleneck Perspective" (arXiv 2607.16133, Jul 2026) proves MAS and single-agent are **equivalent under infinite relay bandwidth** — the entire degradation lives in bounded lossy relay compression, with gain = upstream-context-reduction − β·relay-information-loss, and **β grows with model capability**: weaker models *benefit* from lossy compression (distraction removal), stronger models are hurt by it. "Faithful, Not Corrective" (Jun 2026): strong relay models are near-lossless over 6 hops (recall ≥0.973) while weak relays degrade format-dependently — and injected errors persist at 83–100% through every message format, so **verification, not format, is the missing correction mechanism**. Meanwhile the harsher-than-original results ("The Illusion of Multi-Agent Advantage": six automated MAS frameworks lose to self-consistency at ~10× cost; the Ringelmann effect: 30 debating agents produce no more diversity than one) all target *untrained, prompt-assembled* systems.

**The residual on the other side.** No published result shows trained multi-agent coordination beating a matched-compute *frontier* single agent on a strictly sequential benchmark; the trained wins are at ≤32B against same-scale baselines. The frontier single-agent baseline is itself being trained up (Kimi K2 Thinking: 200–300 sequential tool calls without derailing; GPT-5.1-Codex-Max: native cross-window compaction; Chain-of-Agents/AFM: distilling multi-agent trajectories *into one model* reaches SOTA). Production practice — Cursor compressing within one agent, Kimi parallelizing only when the task allows — is betting the trained-MAS advantage on sequential work is small.

---

## 4. Mechanistic decomposition: where the 39–70% comes from

The degradation is not one phenomenon. It decomposes into four loss terms and one offsetting term — each with different physics, different remedies, and different "fundamental vs algorithmic" status.

**L1 — Handoff information loss.** Every inter-agent message or context reset compresses the sender's state. Implicit decisions, dead-end knowledge ("I already tried X"), and soft constraints are the first casualties — they are exactly what unstructured summaries drop. Cognition's original critique (conflicting implicit decisions between parallel workers) and the console's own recorded incident (`spawn-hook.ts:8-11`: a nested identifier "lost 11 times out of 11" across message hops until the harness re-derived it deterministically) are both L1 events.

**L2 — Error amplification.** In a dependent chain, an undetected upstream error corrupts every downstream step. Uncoordinated systems amplify 17.2×; a centralized coordinator cuts that to 4.4× by acting as an error-correcting supervisor (detection + containment + retry). L2 is also why *parallel* uncoordinated writes fail: conflicting outputs merge without an arbiter.

**L3 — Coordination token tax.** Spawning, briefing, re-establishing context, message round-trips, and the coordinator re-reading reports all consume budget that a single agent would spend on the task. At matched budgets this is a direct subtraction from task compute (Tran & Kiela's "unaccounted computation"). Cache economics multiply it: a fresh subagent context is a cache-cold context.

**L4 — Context fragmentation.** Distinct from L1: even with perfect messages, *no single participant holds the whole picture*, so cross-cutting constraints are enforced by nobody. Goal drift and self-preferential bias (each agent optimizes its local instruction) are L4 phenomena; Anthropic's dynamic-workflows post names exactly these as what context isolation must be designed around.

**G1 — The offsetting term: context rot.** The single-agent baseline is not lossless. Attention over a long, tool-result-polluted history degrades — ACON measured up to +46% accuracy for smaller models *from removing context* (distraction, not just capacity); "Beyond pass@1" measured SWE-domain graceful-degradation scores falling 0.90 → 0.44 as task duration grows, with frontier models showing meltdown rates up to 19%. G1 grows with task length. Every reset/handoff trades L1 against G1 — that trade is the entire game.

This decomposition makes the console's architecture legible: the star topology + typed mailbox + wake coalescing attack L2 and L3 (centralized supervision, batched communication); ownership scopes at seat creation (`host.ts:99-109`) attack L4; the durable journal means L1 is *recoverable in principle* (nothing is truly lost, only absent from context); and rotation is a G1 defense whose current encoder (a 4,000-char recency slice) maximizes L1.

---

## 5. Mathematical analysis

Assumptions are labeled **[A]**; measured anchors are labeled **[M]** with sources. The models are deliberately simple — their job is to make the trade-offs estimable from the console's own telemetry, not to be a theory of intelligence.

### 5.1 Handoffs as a chain of lossy channels (what is actually fundamental)

Let S be the task-relevant state after some work — everything a continuation needs to finish correctly (requirements, decisions and their reasons, discovered constraints, failed approaches, current artifact state). Let X be the full interaction record that produced it, and let a handoff produce a bounded message M = f(X) (summary, closing report, rotation memory).

S → X → M is a Markov chain, so the **Data Processing Inequality** gives:

> I(S; M) ≤ I(S; X) — no post-processing of the record can add task-relevant information.

This is not just this report's framing — it is literally the formal content of the single-agent-supremacy position. Tran & Kiela (arXiv 2604.02460, §3) prove exactly: for answer Y, context C, inter-agent messages M with Y ↔ C ↔ M, "I(Y;C) ≥ I(Y;M)", hence **Pe(C) ≤ Pe(M)** — the minimum achievable error of a predictor observing only messages is at least that of one observing the full context. Three qualifications determine how much that theorem actually decides:

1. **It bounds idealized observers, not architectures.** Real LLMs are not Bayes-optimal on either C or M; the theorem says nothing about which system's *actual* predictor sits closer to its own bound.
2. **The authors themselves flag the escape** (their §3.1): under degraded effective context C̃α, "once effective single-agent context utilization deteriorates sufficiently, a well-designed MAS may recover task-relevant information," and "carefully structured MAS pipelines may occasionally surpass SAS by imposing useful factorization, filtering, or verification structure."
3. **The DPI is applied asymmetrically in the paper**: context degradation is tested only *artificially* (deletion, masking, distractors), never the organic long-context loss the same literature documents. The single agent's attention over a long C is itself a lossy channel Y ↔ C ↔ C̃α — the inequality cuts both ways. And a message can carry *results of computation* (a verified sub-answer); DPI bounds information, not usable computation.

**[A]** Continuation quality is monotone in I(S; context) — an agent missing state bits fails, retries, or re-derives at token cost (a Fano-style link between conditional entropy H(S | context) and error probability). Under this assumption, any handoff whose output is *not* sufficient for S strictly lowers the ceiling on continuation success. This is the fundamental core of the sequential-task degradation, and Tran & Kiela's matched-budget result is its empirical face **[M]**.

Two escapes — this is where "algorithmic" enters:

1. **Sufficiency.** If M is a sufficient statistic for S — I(S; M) = I(S; X) — the bound costs nothing. Sufficiency is achievable when state is *externalized*: if the workspace W (files, git history, feature lists, the console's durable journal) carries S, the message only needs a pointer and a delta. The handoff channel is then `(M, W)`, and W is lossless. This is precisely the pattern the production convergence found (§3.4): `claude-progress.txt` + git + machine-readable state files are an engineered sufficient statistic.
2. **Learned encoders.** A summarizer trained so that the *outcome* rewards the summary (Cursor Composer's RL-trained self-summarization **[M]**) is directly optimizing I(S; M) under a length budget — a learned approximation to minimal sufficiency. ACON's optimized compression guidelines are the prompt-space version.

And one honesty requirement: the single agent's channel is not the identity. Carrying X forward through attention over a growing window is itself lossy — call its retention curve ρ(ℓ) at context length ℓ (quantified in §5.4). The real comparison is:

> **explicit compression** I(S; M) vs **implicit degradation** I(S; X) · ρ(ℓ)

Neither is 1. For short tasks, ρ ≈ 1 and any lossy M loses — the degradation is fundamental there. For long tasks, ρ falls, and a well-engineered M can *exceed* what a rotted long context effectively delivers. The crossover point is measurable.

**Unification (the console's own architecture proves the point).** Context rotation at 120k tokens / 30 turns is a handoff from generation *n* to generation *n+1*. The console is *already* a sequential multi-agent system over time; its current encoder is `recentMessages.slice(-4000)` — selection by recency, the opposite of sufficiency (decisions and constraints are old; chatter is recent). Single-vs-multi is not the fork in the road. **Handoff fidelity is.**

### 5.2 Error propagation and the value of gates

**[A]** n dependent steps, per-step error rate ε, errors undetected and unrecoverable: success ≈ (1−ε)ⁿ — multiplicative decay. Uncorrected pipelines therefore amplify: an error at step k contaminates all n−k descendants, and cross-agent propagation adds contamination paths. The Google 17.2× (uncoordinated) vs 4.4× (centralized) amplification **[M]** fits a supervision model: a coordinator that detects a fraction d of incoming errors before forwarding reduces the effective per-hop error to ε(1−d) and cuts contamination paths from O(k²) (peer) to O(k) (star).

**Gates change the geometry — and this is now a theorem, not a heuristic.** **MAKER** (arXiv 2511.09030, Nov 2025) gives the complete formal model: decompose an s-step task into subtasks of m steps, run first-to-ahead-by-k voting per step (a Gambler's-ruin race between candidate answers). Per-step reliability becomes

> p(step correct) = 1 / (1 + ((1−p)/p)^k),  and full-task success p_full = (1 + ((1−p)/p)^k)^(−s/m)

With maximal decomposition (m = 1) and k growing like ln s, expected cost is **Θ(p⁻¹·s·ln s) — log-linear in steps — while un-gated execution fails exponentially**. Demonstrated empirically at the extreme: a 20-disk Towers of Hanoi run of 1,048,575 dependent sequential steps completed with **zero errors** (measured per-step error rates ~0.002 for strong models; k=3 votes sufficed). Assumptions, stated by the authors: p > 0.5 per step, near-independent step errors ("red-flagging" — discarding over-long/malformed responses — attacks the correlated part), and the decomposition given a priori. This is the strongest existence proof on the "algorithmic" side of this report's question: **a massively-decomposed, gated multi-(sub)agent system beat any plausible single-context execution of a strictly sequential million-step task.**

With an *imperfect* verifier the production-grade version (arXiv 2607.17044, Jul 2026) is: per-step base success p, verifier catch rate c, fix rate r, false-alarm rate f, breakage rate b → gated rate **p′ = p(1−fb) + (1−p)cr**, compounding as (p′)ⁿ; the gate helps iff **(1−p)cr > pfb**. Their measured attribution is sobering and useful: scaffolding/structure gave +11pp, the verification loop only +1.5pp — but positionally decisive; and **swapping the independent verifier for the generating model cut rescued tasks from 6 to 2**: the loop's value depends on who observes.

The console's cost asymmetry follows:

- **Deterministic gates** (types, tests, lint, schema checks): s ≈ 1 for the error classes they cover, at near-zero marginal token cost. This is why deterministic-first verification survives from v1.
- **Model gates**: an *actor's self-review* has errors correlated with its generation errors — P(miss ∧ miss) ≫ ε², weak independence. A **fresh-context reviewer** decorrelates: P(both miss) ≈ ε·ε_r. This is why the isolated reviewer is the one multi-agent pattern that robustly survives 2026 evidence **[M]** (Cognition: 2 bugs/PR, 58% severe, isolation the stated cause; the Leni measurement above making verifier independence empirically decisive).

**The boundary between coordination-as-theater and coordination-that-adds is also now a theorem.** Homogeneous multi-agent debate — identical inputs, shared evidence — behaves as a **martingale whose expected accuracy does not improve over rounds** (Choi et al. 2026, via arXiv 2607.01661): agents re-reading the same context in different costumes provably gain nothing. The same work's diversity result shows the loophole precisely: **splitting evidence across agents monotonically decorrelates their errors** (correlation 0.5 at a 50/50 evidence split vs 1.0 under shared input), and rationale-sharing then genuinely increases information over rounds. A multi-agent system earns its keep exactly when its participants *observe different things* — different evidence partitions, different rollouts, an independent verifier — never when they share one context.

### 5.3 The matched-budget frontier (when delegation pays)

Total budget B. A k-seat delegation spends C_coord = spawn/brief + context re-establishment (cache-cold, §3.5) + messages + coordinator re-reading. Define the parallelizable fraction f of the task (Amdahl) **[A]**.

Delegation buys exactly three things:

- **(i) Breadth** on the parallelizable fraction: wall-clock ≤ 1/((1−f) + f/k) — and Amdahl's law is now *validated on LLM teams*, not assumed: Princeton's "Language Model Teams as Distributed Systems" (arXiv 2603.12229, Mar 2026) measures centralized pre-assigned teams at 1.36× median speedup vs **0.88× — a slowdown — for self-coordinating teams**, with serial-dependency tasks yielding 1.13× speedup for **5.83× token cost**; teams pay only at parallelizable fraction ≳ 0.9 **[M]**. Breadth also buys *coverage* for selection: the Best-of-Majority theorem (arXiv 2510.03199) makes parallel-rollout value precise — minimax regret O(ε_opt + √(ε_RM²·C*/k)), i.e. selection is verifier-error-limited and coverage-limited, and naive best-of-N provably *degrades* as N grows under reward error. Parallel sampling pays when failures decorrelate across rollouts and the verifier is good; serial refinement pays when all rollouts share a misconception;
- **(ii) Isolation**: each worker operates in the high-ρ region of its own fresh context instead of the low-ρ tail of one long context — worth ~(ρ(ℓ_short) − ρ(ℓ_long)) per step, growing with task length (§5.4). The information-bottleneck decomposition (§3.6) prices this exactly: gain = upstream-context-reduction − β·relay-loss, with β growing with model capability — isolation is worth *more* for weaker/distracted models and *less* for frontier models with strong long-context behavior;
- **(iii) Independence**: decorrelated verification (§5.2) — available only from participants that observe different things (the martingale boundary).

It always pays **L1** (handoff insufficiency, §5.1) and **C_coord/B** (the tax). So:

> **Delegate iff** gain(i)·f + gain(ii)·(task length beyond rot threshold) + gain(iii)·(write-risk) > L1 + C_coord/B

Predictions, checked against evidence:

- Short sequential task (f≈0, short ℓ, low risk): every gain term ≈ 0, both loss terms > 0 → multi-agent strictly loses. **Matches Google's 39–70%** — and marks it as *fundamental for that regime*.
- Parallelizable task: gain(i) dominates → centralized multi-agent wins big. **Matches +80.9%.**
- Long-horizon sequential task: gain(ii) grows with ℓ while L1 is a *design variable* (drivable toward 0 via workspace-as-state) → segmented execution with high-fidelity handoffs beats one rotting context. **Matches the reset-over-compaction convergence** — and marks the long regime as *algorithmic*.
- High-stakes write: gain(iii) alone justifies exactly one fresh-context reviewer — not a swarm. **Matches Cognition.**

**Console decision rule** (implementable, no ML): route to a **single seat** unless (a) the task partitions into independent scopes (the `owns` field already expresses this), or (b) predicted context exceeds the rotation threshold (long-horizon), or (c) the change is risky enough to warrant the independent reviewer. Estimable from task family + file-span before execution; validated by telemetry after Appendix A lands.

### 5.4 The single-agent decay curve ρ(ℓ) — measured

The §5.1 crossover argument needs ρ to be a number, not a metaphor. The 2025–2026 record gives a usable, honestly-uncertain model. Anthropic's own documentation now concedes the phenomenon by name ("as token count grows, accuracy and recall degrade, a phenomenon known as context rot").

**Token-based retention** (fraction of short-context performance retained; best-in-class 2026 models — Opus 4.6 / GPT-5.5 class — on multi-needle retrieval proxies) **[M]**:

| Context length | Retention ρ(ℓ) | Anchor |
|---|---|---|
| ≤8K | 1.00 | baseline |
| 32K | 0.95–1.0 lexical; **0.50–0.85 non-lexical** | NoLiMa (arXiv 2502.05167): effective length at ≥85%-of-base was as low as 4–16K for pre-2026 models on non-lexical association; unmeasured publicly for current models |
| 128–256K | 0.85–0.95 | MRCR v2 compilations (Mar–May 2026) |
| 512K | 0.75–0.85 (best tier only) | GPT-5.5 81.5%, Opus 4.6-class |
| 1M | 0.74–0.78 (only the top two); 0.25–0.40 for everything else | Opus 4.6 76%, GPT-5.5 74% MRCR v2 @1M; Gemini 3.1 Pro 26.3% |

Task-shape multipliers **[M]**: single-fact retrieval ≈ 1.0× (near-solved to 1M); **multi-hop latent structure ≈ 0.55–0.6×** (Graphwalks BFS 40–45% @1M even for the best models); sustained vigilance over an *agent transcript* ≈ 0.7× at 800K (needle-detection recall 99.7% @100K → 69% @800K, arXiv 2605.12366 — the best frontier-model measurement in an agentic setting).

**Turn-based decay, partially independent of tokens** — the agentic term that matters most for the console **[M]**:

- Multi-turn accumulation *itself* costs ≈ **0.61×** vs a fully-specified single turn (−39% across 15 models, 200k+ simulated conversations, arXiv 2505.06120) — and the controlled comparison isolates the cause: concatenating the same information into one turn retains 95%, so the loss is accumulation dynamics (premature commitment, non-recovery from wrong early turns), not capacity.
- Long-horizon reliability: SE-domain graceful degradation 0.90 → 0.44 as task duration grows ≤5min → ≥120min ("Beyond pass@1"; open-weight models — frontier likely better, no public equivalent).
- Realistic conversational-history retrieval: full history is **30–60 points worse** than a focused context at only ~113K tokens (LongMemEval condition of Chroma's report) — the single strongest measurement that an agent carrying everything is very lossy relative to a curated context.
- ACON's +46% accuracy for smaller models *from removing context* shows accumulated agentic history is partly negative-value signal (distraction), not just unused capacity.

**Revealed preferences agree with the measurements.** Anthropic's server-side compaction default triggers at **150K tokens** — 15% of the 1M window it sells; Claude Code auto-compacts at ~83.5% of window and the team recommends proactive compaction at **50–60%**; practitioners voluntarily shrink Claude Code to 200K for output quality. The industry's operating consensus is "real working set ≤150–200K; hand off before the curve bites."

**Console anchor:** the rotation threshold of 120K tokens / 30 turns sits squarely in that consensus band — the *trigger* is defensible. What the evidence indicts is the *encoder*: at the moment the industry says "write a structured handoff," the console writes `.slice(-4000)`.

**Implication for §5.1/§5.3:** ρ(ℓ) falling to ~0.75–0.85 by the 128–512K range on retrieval-shaped work — and to ~0.5–0.6 on structure-shaped work, times a ~0.6–0.9 multi-turn factor — means the single-agent baseline loses 15–50% of its own capability exactly where long-horizon tasks live. A handoff that preserves even ~90% of task-relevant information therefore *beats* carrying the raw context beyond the crossover. The uncertainty is real (no clean R(tokens, turns) surface exists; non-lexical curves for current models are unmeasured; 1M numbers are vendor-friendly synthetics) — but the qualitative shape is confirmed from five independent directions, including the vendors' own defaults.

### 5.5 Topology costs

Star with coordinator: O(k) messages per round; the coordinator serializes decisions (an L2 defense) but accumulates every report in its own context (its own G1) and adds one hop to every path. Peer-to-peer: O(k²) message complexity and 17.2× amplification — dominated; the console rightly forbids it. The console's mandatory 3-hop path (main → coordinator → specialist) means even a 1-specialist sequential task pays **two** lossy channels and two round-trip taxes per exchange where one would do — the concrete case for the single-seat lane (§8.5).

Two 2026 measurements sharpen the coordinator's role. First, **orchestrators are the dominant failure source in current MAS: 67.7% of failures vs 32.3% for executors** (arXiv 2606.01351) — and heavy-reasoning models make *worse* orchestrators ("reasoning trap": they over-plan the coordination itself). The coordinator seat's prompt and model choice deserve more design attention than any specialist's. Second, self-coordination is where the Princeton slowdown (0.88×) came from — pre-assigned structure (which the console's profiles, ownership scopes, and enforced star already provide) is what made the 1.36× centralized speedup possible. The console's fixed topology is an asset here, not a limitation; the missing piece is only the degenerate single-seat case.

---

## 6. Fundamental vs algorithmic — the answer

The theorems from §5 and the trained-coordination record from §3.6 combine into a precise, non-slogan verdict. First the frame the theory stream established: *multi-agent structures cannot add information, but they can add computation, error decorrelation, and independent verification; single agents cannot lose information in principle, but they lose it in practice through context degradation no one can yet predict.* Every formal result delegates its verdict to a handful of empirical parameters — and essentially all live disagreement between the single-agent-supremacy camp (Tran & Kiela) and the gated-decomposition camp (MAKER) is disagreement about those parameters' values on real tasks, not about the math.

**Fundamental (no design escapes it):**
- **The DPI bound**: task-relevant bits discarded by a handoff cannot be un-discarded downstream (§5.1). What is escapable is discarding them in the first place — the bound is on lossy encoders, not on multi-agency. The information-bottleneck equivalence result (§3.6) states this exactly: at sufficient relay fidelity, MAS ≥ SAS *by construction*.
- **The martingale bound**: participants sharing identical context provably add nothing over rounds (§5.2). Multi-agent value requires asymmetric observation — different evidence, different rollouts, an independent verifier. "More agents on the same context" is theater, permanently.
- **Coordination cost > 0**: spawn, brief, transport, re-read. Reducible several-fold (cache discipline, pointer messages, coalescing), never zero.
- **The short-sequential regime**: with nothing for breadth, isolation, or independence to buy — short context (ρ≈1), no partitions, low stakes — both loss terms are positive and all gain terms are ~0. Google's degradation in that regime is real physics. Kimi's *trained* orchestrator independently confirms it: given an outcome reward, it learns to stay single-threaded on sequential tasks.

**Algorithmic (current designs lose it; better designs measurably don't):**
- **Handoff insufficiency (L1) — the dominant term, and the most fixable.** The IB decomposition localizes the entire MAS-vs-SAS gap in the relay; the 39–70% figure was measured over prompt-coordinated frozen models with untrained natural-language handoffs at ~4,800-token budgets. Every intervention on the relay works: workspace-as-state and structured progress contracts (production convergence, §3.4); outcome-trained summarization (Cursor: −50% compaction-induced error); learned fold policies (FoldGRPO: +8.8% SWE-bench Verified at 10× smaller active context); even bypassing text entirely (Cache-to-Cache: +3–5% over text messaging). ACON's optimized guidelines are plain text and importable today.
- **Coordination policy (L2/L3)**: every study that reproduces the naive-MAS deficit and then *trains* the coordination reverses it — including on strictly sequential math (Dr. MAMR: +3.1–7.5 over single-agent GRPO after fixing a provable turn-normalization bias) and sequential planning (AT-GRPO: 14–47% → 96–99.5%). The lazy-agent and consensus-collapse failures have named, fixed causes. MAKER shows the ceiling: gated maximal decomposition executed a million dependent steps at zero errors, log-linear cost — on exactly the task shape the degradation result says multi-agent must lose.
- **Verification structure**: the gate inequality (1−p)cr > pfb and verifier independence (6→2 rescued tasks when the generator grades itself) are design variables, not constants. Error persistence through hops (83–100%, format-independent) means the fix is gates, not message schemas.
- **The single-agent baseline dissolves the dichotomy on long horizons**: past the rot threshold (§5.4 — retention 0.75–0.85 at 512K–1M on retrieval, ~0.5 on structure, ×0.6–0.9 multi-turn factor), the "single agent" must segment too — rotation, compaction, handoff — at which point it faces the identical encoder-design problem. The design axis that remains is *information-retention policy*, and the console's rotation is already on it.

**The honest residual.** Three things keep this from being a full vindication of "it's just bad algorithms": (1) β grows with capability — the stronger the model, the more it loses from any lossy relay and the less it gains from context reduction, so the algorithmic headroom *shrinks* as frontier long-context behavior improves; (2) no published result yet shows trained multi-agent coordination beating a matched-compute *frontier* single agent on a strictly sequential benchmark — the trained wins are ≤32B against same-scale baselines; (3) the frontier single agent is being trained up simultaneously (K2 Thinking's 200–300 sequential tool calls; Codex-Max's native compaction; Chain-of-Agents distilling multi-agent structure *into one model*). The race between trained relays and trained long context is live, and production practice is currently betting on the single-writer side for sequential work.

**Bottom line for the operator's intuition: substantially vindicated, with a precise boundary.** The measured 39–70% is a property of the untrained-relay regime, not a law of multi-agent systems — the mechanisms are identified, fixable, and in several cases already fixed with published numbers. What survives as fundamental is narrower and actionable: never share one context among deliberators (martingale), never hand off less than a sufficient statistic (DPI), never skip independent verification (gates), and don't decompose short sequential tasks at all (all gain terms vanish). On the tasks Agentique exists for — long-horizon, partially-decomposable, verification-heavy software work — a coordinated system with high-fidelity handoffs, deterministic gates, and asymmetric-observation seats has a genuine, evidence-backed path to beating any single rotting context.

---

## 7. Machine-learning methods, assessed at console scale

The operator asked specifically about ML methods. The 2026 record now contains a full menu — the honest assessment is what each *requires* versus what a single-operator console *has*:

| Method class | Best published result | Needs | Feasible for the console? |
|---|---|---|---|
| Learned request/step routing (Cursor Router; SWE-Router) | 60% cost saving at frontier quality (vendor A/B); +12–15pp Route-AUC from trajectory conditioning | 10⁵–10⁶ labeled live requests | **No** — import conclusions, not the method. Static tiering + escalation rules capture most of the value at this volume |
| Multi-agent RL / co-trained coordination (MAPoRL, Dr. MAMR, AT-GRPO, M-GRPO, PARL) | Reverses the naive-MAS deficit on sequential math/planning; K2.5 +17.8pp in production | Weight access, fleet-scale sandboxed RL, careful credit assignment | **No** locally — arrives through model vendors. The console's job is to expose the interfaces trained models exploit (structured handoffs, isolated sub-contexts, verification gates) |
| Outcome-trained summarization / folding (Composer, FoldGRPO, MEM1) | −50% compaction-induced error; +8.8% SWE-bench V at 10× smaller context | RL on the serving model | **No** locally — same vendor channel. But its *lesson* is directly actionable: the handoff is the highest-leverage step, so engineer it (§8.1) even without training it |
| Optimized compression guidelines (ACON) | 26–54% peak-token cut; +46% small-model accuracy | One-time gradient-free optimization; artifact is plain text | **Yes, now** — the published guidelines are model-agnostic text, importable as the console's handoff-prompt template. The optimization loop itself (diagnose paired success/failure trajectories → rewrite guideline) is also runnable locally once telemetry lands |
| GEPA-style prompt evolution | >10% over MIPROv2; ~6% over RL at 35× fewer rollouts (ICLR 2026 oral) | An eval suite + rollout budget | **Later** — gated on the deferred eval suite |
| Learned inter-agent channels (Cache-to-Cache, Interlat, Optima) | +3–5% over text at 2× lower latency | Weight access, shared serving stack | **No** — API-only harness. Watch: if vendors productize KV-passing between sessions, adopt |
| Telemetry-driven rule fitting (§5.3 thresholds) | — | Appendix A telemetry + weeks of real usage | **Yes — this is the console's native learning loop**: measure the delegation-frontier inputs (task family, file span, rotation counts, cache fractions, gate outcomes), fit the route-to-single-seat/star/reviewer thresholds, freeze them as inspectable rules, re-fit quarterly |

Two structural takeaways. First, everything trainable-at-fleet-scale reaches the console *through the model vendor* — the console's leverage is to be the harness whose interfaces (externalized state, structured handoffs, independent verification, asymmetric evidence splits) let trained models express those skills, rather than fighting them with prescriptive scaffolding. Second, the two methods feasible *today* (imported compression guidelines; telemetry-fitted rules) both depend on Appendix A landing first — which is why the operator's telemetry-first decision is the right order.

---

## 8. Architecture directions for Agentique Console (ranked)

Each direction states its mechanism in the §4/§5 vocabulary and the telemetry that would validate it. None is an implementation commitment (operator decision: research only).

### 8.1 Agent-authored handoffs (attacks L1; operator-selected)
Replace the 4,000-char recency slice: before rotation (and at seat close-out on long tasks), the participant writes a structured handoff — objective, decisions with reasons, hard constraints, done/remaining, failed approaches, next action, file/journal pointers — and *that* becomes the next generation's memory. The closing-output schema gains only `taskId` and `status` (the surviving fragment of v1's typed-handoff idea). The durable journal already guarantees nothing is lost; the handoff's job is selection, not storage. **Validation:** rotation-adjacent failure/re-derivation rate; tokens spent re-reading post-rotation; task completion across rotations.

### 8.2 Workspace-as-sufficient-statistic (attacks L1 structurally)
Make externalized state the norm, not the exception: coordinators maintain a progress/decision file per session; messages carry pointers + deltas. The `DELEGATION_BRIEF` already gestures at this ("belongs in a file in the workspace, not only in messages") — promote it from advice to mechanism (e.g., a conventional `PROGRESS.md` the prompt envelope references). **Validation:** message sizes, repeat-explanation tokens, L1 incident rate.

### 8.3 Deterministic gates + one fresh-context reviewer (attacks L2 at minimal cost)
Keep verification deterministic-first; the only model-based verification is a single isolated reviewer seat on risky writes (the one robust multi-agent win). Remove instructed self-verification from prompts (current-model guidance: it causes over-verification). **Validation:** defects caught per reviewer token; regression rate with/without.

### 8.4 Cache-disciplined persistent seats (attacks L3)
The console already resumes seats across turns — measure and protect that: stable system prompts (memory injected only at generation boundaries, which already holds), no mid-session model/tool changes, artifact pointers instead of re-inlined payloads. Blocked on Appendix A (cache split is currently invisible). **Validation:** cache-read fraction per seat-turn (target: Claude-Code-like >90% on continuing seats).

### 8.5 Dynamic topology: single-seat lane + star (attacks L3/L1 for sequential work; operator-selected)
Let main run a 1-seat session reporting directly to it (no coordinator hop) and route by the §5.3 rule: single seat for sequential/short work, star for partitionable or long-horizon work, reviewer added by risk. This is the two-arm comparison that replaces v1's five-arm study. **Validation:** tokens/latency/completion vs the mandatory star on comparable tasks.

### 8.6 Model/effort tiering + escalation (value-per-token, orthogonal to topology)
Static per-profile model and effort assignment (nothing is assigned today) with one rule: failure or rotation escalates the next generation one tier. Effort is the cheapest quality-per-token lever on current models. Not selected for wave 1 by the operator; recorded here because the telemetry (Appendix A) makes it a one-line-per-profile experiment whenever desired.

---

## 9. Recommended sequencing (not an implementation plan)

1. **Telemetry first** (operator decision) — Appendix A is the complete, ready-to-execute design. Until the cache split, model/effort identity, and per-turn latency are recorded, every claim in §5 is unfalsifiable *on this system*.
2. **Observe** real usage for the §5.3 inputs: per-task token totals by participant, rotation frequency, cache-read fractions, coordination-message share.
3. **Then** the operator-selected experiments in evidence order: agent-authored handoffs (§8.1), single-seat lane (§8.5) — each a before/after on the same telemetry.
4. The deferred eval suite (design preserved in Appendix A §B) becomes worthwhile the moment any §8 change needs a controlled comparison.

---

## Appendix A — Telemetry upgrade: complete implementation design (ready to execute)

*(Design produced and validated against the codebase this session; recorded verbatim so implementation can start without re-derivation. No code has been changed.)*

### A.0 Verified mechanics

- Migration machinery exists: `server/src/db/client.ts` runs `sqlite.exec(DDL)` (CREATE TABLE IF NOT EXISTS) then `migrateAdditiveColumns()` with `pragma table_info` + `ALTER TABLE ... ADD COLUMN` guards. Adding a `usage_samples` block there (plus columns in `ddl.ts` for fresh DBs and `schema.ts` for types) is the entire migration story.
- The real SDK wire already carries everything needed: result messages have `duration_ms`, `duration_api_ms`, `stop_reason`, `usage` (all four token fields), and `modelUsage: Record<modelId, {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}>`; the init message carries `model`. Effort is not echoed — record the *requested* effort.
- `Repo.insertUsage` takes the `$inferSelect` type, so new columns compile-check every writer.
- The fake SDK needs zero changes (`successMessage(output, extra)` accepts `Partial<SdkMessage>`); all 13 existing test files pass if new mapped fields are conditionally included only when present on the wire.
- Known risks: `runner.test.ts:36-48` asserts event *order* (enrich payloads, never reorder); the steer-minted follow-up turn (`runner.ts:481-502`) needs its own `startedAt`; turns settled by the turn-idle backstop produce no usage sample (mitigation: stamp console-measured `durationMs` on the `turn.settled` events, covering every settle path); `modelUsage` can be multi-model per turn (persist the dominant-by-output-tokens key); web folds read `payload.inputTokens` as the sum (keep sum semantics); `server/tsconfig.json` includes only `["src","scripts"]`.

### A.1 Schema (additive columns on `usage_samples`; `input_tokens` keeps sum semantics — it feeds rotation)

| column | type | meaning |
|---|---|---|
| `uncached_input_tokens` | INTEGER NOT NULL DEFAULT 0 | wire `input_tokens` |
| `cache_read_tokens` | INTEGER NOT NULL DEFAULT 0 | wire `cache_read_input_tokens` |
| `cache_write_tokens` | INTEGER NOT NULL DEFAULT 0 | wire `cache_creation_input_tokens` |
| `model` | TEXT | dominant `modelUsage` key; fallback init `model`; fallback configured model |
| `effort` | TEXT | requested effort (config/profile) |
| `trigger` | TEXT | `operator` \| `wake` \| `answer` (main) / `delivery` (seats) |
| `duration_ms` | INTEGER | console wall-clock, turn start → sample write |
| `api_duration_ms` | INTEGER | wire `duration_api_ms` |
| `status` | TEXT | `completed` \| `error` \| `aborted` |
| `stop_reason` | TEXT | wire `stop_reason` |

### A.2 Changes by file

1. **`server/src/sdk/types.ts`** — add optional `model`, `duration_ms`, `duration_api_ms`, `stop_reason`, `modelUsage` to `SdkMessage`.
2. **`server/src/sdk/mapping.ts`** — `resume` gains `model?`; `result`/`error` gain conditional `usage: {uncachedInputTokens, cacheReadTokens, cacheWriteTokens}`, `modelId?`, `apiDurationMs?`, `sdkDurationMs?`, `stopReason?`. **`inputTokens` stays the three-way sum** (rotation feed at `runner.ts:641` / `host.ts:398` untouched).
3. **`server/src/db/ddl.ts` + `schema.ts` + `client.ts`** — columns above; third `migrateAdditiveColumns` block.
4. **`server/src/orchestrator/runner.ts`** — `ActiveTurn.startedAt` (set in `#runTurn` *and* the steer-minted follow-up); `Lane.modelId` (from enriched `resume`) and `Lane.toolStarts: Map<callId, number>`; populate new sample fields in the `result`/`error` cases; `durationMs` on `user_session.turn.settled`; stamp `durationMs`/`bytes` on `tool.result` payloads.
5. **`server/src/agent-sessions/host.ts`** — per-turn `startedAt` + `toolStarts` in `#runTurn`; stamp tool payloads (lines 394-395); `durationMs` on `agent_session.turn.settled`; extend `#recordUsage` with trigger `"delivery"`, model (`event.modelId ?? seat.model ?? config.model`), effort (`profile.effort ?? config.effort`), split/duration/status/stopReason.
6. **`shared/src/events.ts`** — all-additive optional fields on `UsageRecordedPayload` (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `model`, `effort`, `trigger`, `durationMs`, `apiDurationMs`, `status`), `ToolResultPayload` (`durationMs`, `bytes`), and both `TurnSettledPayload`s (`durationMs`). `inputTokens`/`outputTokens` stay required with sum semantics — old journal rows replay fine, web folds untouched.
7. **`server/src/events/bus.ts`** — `captureSized(value, scope): {value, bytes}`; `capture` becomes a wrapper (single serialization).
8. **`server/src/api/routes/user-sessions.ts`** — telemetry totals gain the three split fields; raw rows flow automatically.
9. **Tests** — new mapping cases (usage/modelUsage/durations; init model); one runner test asserting sample columns + the rotation invariant (`contextTokens` still equals the sum); a `migrate.test.ts` reopening an old-shape DB; one host-side assertion (`trigger:"delivery"`, populated `profileId`/`effort`/`model`).

**Acceptance:** `npm run verify` green with the 13 existing test files unmodified; fresh and pre-existing DBs boot; rotation thresholds fire identically; `tool.result` events carry `durationMs` + `bytes`; zero behavior change when wire fields are absent.

### A.B Deferred eval-harness design (preserved for when it's wanted)

`server/eval/` with TypeScript task specs (`{id, family, prompt, files, checks[]}` — checks are trusted code: `fileExists`/`fileContains`/`exec` against the rep's tmpdir workspace); a runner extracted from the `smoke.ts` wiring (`bootStack(config)`), one config arm per process invocation via env bundles; fresh DB per rep; auto-answer + quiet/timeout loop; metrics read from the rep DB (`usage_samples` by participant × token category, turn counts, rotations, settled durations); JSONL per rep + summary (pass rate, pass^k, cost-per-solved, tokens-per-solved); baselines committed as JSON. ~12 tasks across explore/bugfix/feature/crossfile/review/research families; estimated $15–35 per full 3-rep baseline on a Sonnet-class default, 3–5× on Opus-class. Add `"eval"` to `server/tsconfig.json` include; gitignore `reports/runs/`.

---

## Appendix B — Sources

| Source | Date | Role |
|---|---|---|
| Google/MIT, "Towards a Science of Scaling Agent Systems", arXiv 2512.08296 + research.google blog | Dec 2025 / Jan 2026 | The degradation + amplification numbers |
| Tran & Kiela, arXiv 2604.02460 | Apr 2026 | Matched-budget single-vs-multi parity; DPI framing |
| Anthropic, "How we built our multi-agent research system" | Jun 2025 | +90.2% on parallel research at ~15× tokens |
| Cognition, "Don't build multi-agents" / "Multi-agents: what's actually working" | Jun 2025 / Apr 2026 | Single-writer doctrine; fresh-context reviewer (2 bugs/PR, 58% severe) |
| Anthropic, "Effective context engineering" / "Effective harnesses for long-running agents" / "Harness design for long-running apps" | Sep 2025 / Nov 2025 / Mar 2026 | Reset-over-compaction; structured handoff files; harness-cost table ($9 vs $200) |
| Amp manual + coverage of `/handoff` | early 2026 | Compaction retired for handoffs in production |
| Manus, "Context Engineering for AI Agents" | Jul 2025 | KV-cache-first discipline; 100:1 input:output |
| Factory, "Evaluating Context Compression" / "Deferred Context Engine" | early 2026 / May 2026 | Anchored summarization on 36k real messages; JIT tool schemas (−15.1% avg input tokens) |
| Cursor, "Composer" / "Introducing Cursor Router" | Oct 2025 / Jul 2026 | RL-trained self-summarization; learned router on 600k+ requests |
| Cognition, "SWE-grep" | Oct 2025 | RL-trained retrieval submodel shipped in Windsurf |
| ACON, arXiv 2510.00615 (ICML 2026) | Oct 2025 | 26–54% peak-token reduction; +46% small-model accuracy |
| CaT/SWE-Compressor, ACL Findings 2026 | 2026 | 57.6% SWE-bench Verified under bounded context |
| "Beyond pass@1", arXiv 2603.29231 | Mar 2026 | Memory scaffolds universally hurt; GDS 0.90→0.44; reliability metrics |
| CTIM-Rover, arXiv 2505.23422 | 2025 | Episodic memory degrades SWE agents |
| Confucius Code Agent, arXiv 2512.10398 | Dec 2025 | Thinking-budget plateau (67.3/68.4/68.7%) |
| "When More Thinking Hurts", arXiv 2604.10739 | Apr 2026 | Overthinking flips correct answers |
| "Scaling Test-Time Compute for Agentic Coding", arXiv 2604.16529 | Apr 2026 | Rollouts+selection: 70.9→77.6% SWE-bench Verified |
| SWE-Router, arXiv 2607.00053; TwinRouterBench, arXiv 2605.18859; RouteLLM, arXiv 2406.18665 | 2024–2026 | Routing evidence chain |
| GEPA, arXiv 2507.19457 (ICLR 2026 oral) | 2025 | Reflective prompt evolution beats MIPROv2/GRPO |
| SWE-Replay, arXiv 2601.22129; AgentRR, arXiv 2505.17716 | 2025–2026 | Trajectory reuse (modest); framework-only |
| Judge reliability: arXiv 2606.19544, arXiv 2604.16790 | 2026 | Judges are not correctness oracles |
| Anthropic/Claude platform docs (prompt caching, effort, task budgets, compaction, context editing, advisor tool) | current | Vendor-native mechanisms |
| Galileo, "The 2026 Caching Playbook for Agents" | 2026 | Claude Code 92.7% cache-read measurement |
| Chroma Research, "Context Rot" | Jul 2025 | 18 models; 30–50% drops before limits; LongMemEval 30–60pt full-vs-focused gap; distractor amplification |
| NoLiMa, arXiv 2502.05167 (Adobe) | 2025 | Non-lexical effective context as low as 4–16K at ≥85%-of-base (pre-2026 models) |
| "LLMs Get Lost in Multi-Turn Conversation", arXiv 2505.06120 (Microsoft/Salesforce) | May 2025 | −39% from multi-turn accumulation; concat control isolates the mechanism |
| Classifier Context Rot, arXiv 2605.12366 | May 2026 | Frontier-model agent-transcript vigilance: recall 99.7% @100K → 69% @800K |
| MRCR v2 / Graphwalks compilations (yage.ai Mar 2026; CodingFleet May 2026) | 2026 | Frontier retention 0.74–0.78 @1M (best two); structure-shaped ~0.4–0.45; effective ≈ 50–70% of nominal |
| Michelangelo, arXiv 2409.12640 (DeepMind); LongBench v2 leaderboard | 2024–2026 | Latent-structure decay; hard long-context reasoning unsaturated (leader 63.2%) |
| Compaction-trigger documentation (Anthropic `compact_20260112` default 150K; Claude Code ~83.5% auto / 50–60% recommended; Codex CLI window−13K) | 2026 | Vendors' revealed estimates of where context quality decays |
| **Theory of composition** | | |
| Tran & Kiela, arXiv 2604.02460 (full-text extraction) | Apr 2026 | Pe(C) ≤ Pe(M) under Markov + perfect utilization; authors' own §3.1 escape hatch; asymmetric DPI application |
| MAKER, arXiv 2511.09030 (Cognizant AI Lab) | Nov 2025 | Gated voting: p_full = (1+((1−p)/p)^k)^(−s/m); Θ(p⁻¹·s·ln s) cost; million-step zero-error run |
| "Where Does Agent Reliability Come From?", arXiv 2607.17044 (Leni) | Jul 2026 | Gate model p′ = p(1−fb)+(1−p)cr; verifier independence decisive (6→2 rescued tasks) |
| Choi et al. 2026 via Li et al., arXiv 2607.01661 (CMU) | Jul 2026 | Martingale no-gain for homogeneous debate; diversity-induced error decorrelation |
| Best-of-Majority, arXiv 2510.03199 (UCLA) | Oct 2025 | Minimax-optimal selection: regret O(ε_opt + √(ε_RM²C*/k)); naive BoN degrades with N |
| Weaver, arXiv 2506.18203 (ICML 2025, Stanford) | 2025 | Generation-verification gap; weak-verifier ensembling at ~1/3000th verification compute |
| "Fundamental Limits of Prompt Compression", arXiv 2407.15504 (NeurIPS 2024) | 2024 | Rate-distortion LP for prompt compression; query-aware ≫ query-agnostic |
| "LM Teams as Distributed Systems", arXiv 2603.12229 (Princeton) | Mar 2026 | Amdahl validated: centralized 1.36× vs self-coordinating 0.88×; serial tasks 1.13× speedup at 5.83× token cost |
| "Recognize Your Orchestrator", arXiv 2606.01351 | May 2026 | Orchestrators cause 67.7% of MAS failures; reasoning-trap effect |
| Ord, "Half-Life of AI Agent Success", arXiv 2505.05115 + METR time horizons | May 2025 | Constant-hazard exponential survival fit for agent task length |
| ACONIC, arXiv 2510.07772 (Columbia); "On the Design and Analysis of LLM-Based Algorithms", arXiv 2407.14788 (TMLR); AgentsNet, arXiv 2507.08616 | 2024–2026 | Decomposability measurement; LLM-algorithm analysis; LOCAL-model benchmarks |
| Prompt-compression RCT, arXiv 2603.23525 | Mar 2026 | Moderate compression −27.9% cost; aggressive compression +1.8% (output expansion) |
| **Learned coordination** | | |
| "When Do Multi-Agent Systems Help? An Information Bottleneck Perspective", arXiv 2607.16133 | Jul 2026 | MAS ≡ SAS under lossless relay; gain = context-reduction − β·relay-loss; β grows with capability |
| "Faithful, Not Corrective", arXiv 2607.09678 | Jun 2026 | Strong relays near-lossless over 6 hops; errors persist 83–100% regardless of format |
| Cursor, "Self-summarization" blog + Composer 2 report, arXiv 2603.24477 | Mar 2026 | Outcome-rewarded compaction: −50% compaction-induced error, shipped |
| Context-Folding/FoldGRPO, arXiv 2510.11967 (ByteDance); MEM1, arXiv 2506.15841 (ICLR 2026) | 2025 | Learned fold/memory policies: +8.8% SWE-bench V at 10× smaller context; constant-size RL memory |
| MAPoRL, arXiv 2502.18439 (ACL 2025); MARFT, arXiv 2504.16129; AT-GRPO, arXiv 2510.11062; Dr. MAMR, arXiv 2511.02303; M-GRPO, arXiv 2511.13288; MHGPO, arXiv 2506.02718 (ACL 2026); "When Does MARL Improve LLM Workflows?", arXiv 2605.24202 | 2025–2026 | The multi-agent RL record: co-training reverses naive-MAS deficits, incl. sequential math/planning |
| Kimi K2 / K2 Thinking / K2.5 (PARL Agent Swarm), arXiv 2507.20534, arXiv 2602.02276 | 2025–2026 | Production trained orchestrator: +17.8pp on wide search; learns single-threading on sequential tasks |
| Cache-to-Cache, arXiv 2510.03215 (ICLR 2026); Interlat, arXiv 2511.09149 (ACL 2026); Optima, arXiv 2410.08115 (ACL 2025); "Beyond Tokens" survey, arXiv 2606.05711 | 2024–2026 | Learned inter-agent channels beat text; token-priced communication training |
| "The Illusion of Multi-Agent Advantage", arXiv 2606.13003; Ringelmann effect, arXiv 2606.02646; "How Task Structure Limits Multi-Agent Success", arXiv 2606.13733; MAS-PromptBench, arXiv 2606.23664 | Jun 2026 | The critique wave: untrained MAS frameworks lose to self-consistency at ~10× cost; min-cut bounds; prompting alone doesn't close the gap |
| Chain-of-Agents/AFM, arXiv 2508.13167 (OPPO) | Aug 2025 | Multi-agent structure distilled into a single model reaches SOTA — coordination as training data |
