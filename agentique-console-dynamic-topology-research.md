# Agentique Console: Dynamic Topology Research Report

**Date:** 2026-08-05  
**Repository snapshot:** `d07cf02` — `feat: implement agent handoff protocol with comprehensive evaluation and retrieval features`  
**Research question:** Should topology become a more explicit, flexible, or adaptive capability in Agentique Console, and if so, at what level and for what measurable purpose?

## Executive assessment

`Dynamic Topology` is a meaningful subject for Agentique Console, but the phrase is too broad to be an architectural requirement by itself.

The Console does not have only one topology. It currently has several overlapping structures:

- an **authority topology**: operator → main orchestrator → AgentSession coordinator → specialists;
- a **communication topology**: an enforced bidirectional star, `main ↔ coordinator ↔ specialist`;
- an **execution topology**: independently resumable participant lanes scheduled concurrently under global and per-session limits;
- a **task topology**: task ownership plus `blocks`/`blockedBy` dependencies;
- a **context topology**: addressed, typed handoffs, evidence references, provider journals, and context-rotation lineage;
- a **capability topology**: profile-specific tools, permissions, models, effort, sandbox, shell, and browser access;
- a **validation and integration topology**: reviewers are isolated profiles, specialists report inward, coordinators gate completion, and main owns the operator-facing result.

The current star is therefore not merely a messaging convention. It is the Console's control plane. It provides clear responsibility, bounded communication, durable recovery, and an integration point. Removing it casually would also weaken those properties.

At the same time, the star fixes more than is always necessary. Every substantive delegated task pays for a coordinator, specialists cannot exchange a focused handoff directly, the roster and ownership scopes are fixed at AgentSession creation, and no runtime object explains why this structure was selected. At the `UserSession` level, main can create several stars, so the macro-structure is already dynamically composed; inside each AgentSession, however, topology is fixed.

### Main conclusion

The best-supported direction is **not** arbitrary runtime graph generation. It is to make topology an explicit, observable execution decision while keeping a stable authority envelope:

1. Measure the current star before changing it.
2. Distinguish topology selection from ordinary scheduling, routing, context management, and capability assignment.
3. Add only the smallest alternative needed to test a concrete hypothesis—most importantly, whether short sequential work benefits from a direct single-worker lane that avoids the coordinator hop.
4. Select a structure at the **task or workstream** level using inspectable rules and keep it stable through a coherent phase.
5. Permit adaptation only at durable boundaries—task completion, phase transition, failure, material scope discovery, or context rotation—where ownership and context can be transferred explicitly.
6. Consider richer graph composition or learned selection only if controlled local evidence shows that simpler structures leave repeatable value on the table.

This conclusion is moderately supported by external evidence and strongly supported as a low-risk experimental sequence. It is **not yet established** that any alternative topology will outperform the current system on Agentique's actual workload.

---

## 1. Method and evidence discipline

This report uses three labels:

- **Evidence** — directly observed in the repository or reported by a cited primary source.
- **Inference** — a reasoned application of evidence to Agentique Console.
- **Hypothesis** — a falsifiable design idea requiring local experimentation.

Repository source and tests are authoritative for current behavior. The earlier optimization reports are treated as prior analysis, not as proof. External results are weighted by:

1. controlled comparison and budget fairness;
2. similarity to long-running, tool-using software work;
3. publication and reproducibility status;
4. whether the result concerns communication topology, execution workflow, or merely agent count;
5. whether quality, tokens, latency, and failure are measured together.

This distinction matters. Several recent papers optimize communication graphs on reasoning benchmarks. They demonstrate that graph structure can be optimized in those settings; they do not establish that a mutable graph is the right abstraction for a durable software-work console.

---

## 2. What “topology” should mean here

### 2.1 A precise definition

For Agentique Console, topology is:

> The runtime-enforced arrangement of actors and durable state that determines who may observe, decide, delegate, execute, validate, escalate, and integrate work, together with the permitted directions in which tasks, context, authority, and results may move.

That definition is intentionally broader than a graph of chat links. A useful formal view is a typed, time-indexed multigraph:

`T(t) = (N(t), E_comm(t), E_control(t), E_task(t), E_context(t), E_capability(t), E_validation(t), C(t))`

where:

- `N` contains operator, main, coordinators, specialists, durable task/artifact state, and possibly external validators;
- each edge set has a different meaning and should not automatically imply the others;
- `C` contains invariants such as ownership exclusivity, concurrency limits, permission boundaries, finalization gates, and escalation policy;
- `t` matters only if the structure may change during execution.

The multigraph is an analytical model, not a recommendation to implement a generic graph engine.

### 2.2 Topology is not one thing

| Concern | Current representation | Is it topology? | Why |
|---|---|---:|---|
| Who may send a handoff to whom | Route assertion in `AgentSessionHost` | Yes | It is an enforced communication edge. |
| Who has final authority | Prompts, tools, decision flow, finalization checks | Yes | It controls decisions and result ownership. |
| Which tasks depend on others | `blocks` / `blockedBy` | Adjacent | This is a work DAG; it may inform execution topology without being the same graph. |
| Which ready seat runs next | Runtime scheduler and turn caps | Usually no | This is scheduling over a topology. |
| Which tools a participant has | Profile snapshot | Partly | Capability placement changes what work a node can perform. |
| Which history a seat sees | Addressed mailbox, handoff expansion, rotation checkpoint | Yes | Information reachability is structurally important for agent quality. |
| How the main agent chooses a profile | Prompt-guided model decision | Policy | It selects nodes/capabilities but is not itself a topology. |
| Whether an agent session is planning or executing | Session phase | Lifecycle | A phase can be a safe topology boundary. |

Conflating these concerns would create an abstraction that is powerful on paper and difficult to reason about in production.

### 2.3 Four meanings of “dynamic”

The literature and agent frameworks use “dynamic topology” for materially different mechanisms:

1. **Selection:** choose one known workflow before execution.
2. **Scheduling:** keep the structure fixed but decide dynamically which ready node runs next.
3. **Composition:** construct a task-specific structure from a small set of primitives.
4. **Reconfiguration:** add/remove nodes or edges, transfer ownership, or change authority during execution.

A fifth, more limited form is **contextual adaptation**: keep authority and communication fixed while changing which evidence, tools, validators, or memory are exposed. This can yield much of the apparent benefit of dynamic topology without changing the collaboration graph.

Agentique already performs dynamic scheduling and contextual adaptation. The open questions concern explicit selection, composition, and reconfiguration.

---

## 3. Current Agentique Console topology

### 3.1 The stable control plane

```text
Human Operator
      ↕
Main Orchestrator
      ↕ durable typed handoff
AgentSession Coordinator
   ↙    ↓    ↘
Specialist seats (1–4)
```

**Evidence — session construction.** `AgentSessionHost.createSession` requires one to four specialists, creates one virtual `orchestrator` participant with the built-in coordinator profile, snapshots every profile and ownership scope, and rejects duplicate non-reviewer ownership.

**Evidence — route enforcement.** `#assertRoute` permits only main→coordinator, coordinator→main or specialist, and specialist→coordinator. The server rejects all other paths rather than relying on prompts.

**Evidence — durable coordination.** Every managed transfer becomes a typed handoff, transcript message, mailbox delivery, and event before the recipient is scheduled. Delivery progresses through queued, delivered, acknowledged, or cancelled states.

**Evidence — authority and integration.** Only the coordinator can request operator decisions. A coordinator cannot send `final` while Console tasks are incomplete, specialists are running, or internal deliveries remain active. Main remains the only operator-facing synthesizer.

### 3.2 The execution structure is less centralized than the communication structure

The coordinator is a communication hub, but it is not a single execution thread. Each participant has an independently resumable provider session. The host may run multiple recipients concurrently, constrained by global and per-AgentSession turn limits. The scheduler starts a seat when it has queued addressed deliveries.

**Inference.** Calling the current implementation a “hierarchical sequential pipeline” would be inaccurate. It is a centralized control topology over concurrent execution lanes.

This distinction matters for experiments. Allowing peer messages might reduce relay cost, but it does not create parallel execution—the Console already has that.

### 3.3 The UserSession already composes topology dynamically

Main may create multiple AgentSessions for coherent workstreams, choose one to four seats in each, select profiles and model overrides, assign disjoint ownership scopes, and send later steering messages. Nothing requires every UserSession to contain the same number of AgentSessions.

Viewed at the UserSession level, the runtime graph is a “star of stars” whose branches are created on demand. Viewed at the AgentSession level, each branch is fixed after creation.

**Established conclusion.** Agentique does not need a wholly new idea to begin topology research. It already has an implicit composition mechanism: create another bounded AgentSession with a purpose-specific roster.

### 3.4 What is fixed today

| Dimension | Fixed scope | Consequence |
|---|---|---|
| Coordinator presence | Every AgentSession | Even one small worker has a coordination hop. |
| Communication edges | AgentSession lifetime | No focused specialist↔specialist transfer. |
| Participant roster | AgentSession creation | Seats cannot join or retire in place. |
| Ownership declarations | Participant creation, with task owner mutable separately | Discovered scope changes require steering or a new session; the two ownership concepts can drift. |
| Profile/capability snapshot | Participant lifetime | Strong reproducibility; capability changes require a new seat/session. |
| Main's role | UserSession lifetime | Main coordinates and synthesizes; it cannot perform substantive write execution. |
| Result integration | Coordinator then main | Two integration boundaries for delegated work. |
| Decision escalation | Coordinator → main → operator | Clear authority, additional latency for blocking choices. |
| Context reachability | Addressed handoffs plus explicit retrieval | Bounded context, possible relay loss. |
| Topology identity and rationale | Not represented | Runs cannot be grouped by structural policy or audited for why a structure was chosen. |

### 3.5 Where the fixed structure provides value

1. **Responsibility is legible.** Main owns operator intent, coordinators own bounded workstreams, and specialists own explicit scopes.
2. **Communication remains bounded.** A full mesh grows possible directed communication paths as `n(n−1)`; a star keeps them linear and makes wake coalescing possible.
3. **Authority is fail-closed.** Specialists cannot treat peer output as operator approval or bypass the coordinator to redefine scope.
4. **Integration has a named owner.** Someone must reconcile conflicts, verify task completion, and decide what reaches main.
5. **Recovery is tractable.** Durable mailboxes, typed handoffs, lineage, profile snapshots, and provider journals identify who owed what to whom.
6. **Permissions and observability are complete.** Native agent messaging is denied so work cannot disappear outside the Console event model.
7. **The structure contains error propagation.** A central checkpoint can reject incomplete or inconsistent results before they spread.

The controlled Google/MIT study of 180 configurations found that centralized systems contained error amplification better than independent systems (reported as 4.4× versus 17.2× in its experiments), while performance depended strongly on task structure. This supports centralized validation as a real benefit, not universal superiority of the star [1].

### 3.6 Where it may impose avoidable cost

1. **Mandatory double harness.** Main and the AgentSession coordinator both spend tokens interpreting, decomposing, and integrating a small delegated task.
2. **Relay loss.** A specialist's result is compressed into a handoff, interpreted by the coordinator, then compressed or synthesized again for main.
3. **Coordinator bottleneck.** Cross-cutting discoveries must wait for a coordinator turn even when a direct, typed notification could unblock another specialist.
4. **Static roster.** Early uncertainty encourages either over-seating “just in case” or creating another session later.
5. **Weak fit for tightly reciprocal work.** Two specialists whose outputs continuously constrain each other cannot mutually adjust directly; the coordinator must relay each revision.
6. **Topology is invisible to evaluation.** Usage is attributed to session and participant, but not to a named structural policy, selection decision, or transition.
7. **Task ownership has two layers.** Immutable seat `ownership` and mutable task `owner` are useful but not reconciled as one authority model.

These are plausible costs, not measured local regressions.

### 3.7 Smaller changes may address much of the problem

Before introducing generic topology, Agentique can test narrower interventions:

- add topology/strategy identity and decision telemetry without changing behavior;
- provide a direct single-worker AgentSession mode while retaining main, durable handoffs, profiles, tasks, and events;
- allow the coordinator to forward one canonical handoff reference instead of re-summarizing it;
- use task dependencies to schedule work without changing communication authority;
- add a narrowly scoped “notify affected owner” path whose payload remains typed and visible, while decisions still flow through the coordinator;
- create reviewer seats only when risk warrants independence;
- create a new AgentSession when scope changes rather than mutating a live one.

Each change isolates one hypothesis. A generic graph would change all of them at once and make causal evaluation harder.

---

## 4. What adjacent research establishes—and does not

### 4.1 Task structure dominates agent count

The Google/MIT scaling study compared single-agent, independent, centralized, decentralized, and hybrid architectures across agentic benchmarks. Centralized multi-agent execution improved the parallelizable finance task by 80.9%, while every multi-agent variant degraded the sequential planning task by 39–70%. Tool density also increased coordination cost. A task-feature model using decomposability and tool count selected the best tested architecture for 87% of unseen configurations, although its reported `R² = 0.513` shows substantial unexplained variance [1].

**Evidence-supported conclusion:** no fixed multi-agent structure is uniformly best across task regimes.

**Uncertainty:** the benchmarks are not Agentique coding sessions, and “best architecture among five experimental templates” is narrower than reliable production routing.

Anthropic's production research system offers convergent but domain-specific evidence. Its orchestrator-worker structure is effective for wide, parallel web research, yet the company reports multi-agent runs at roughly 15× chat token use and explicitly says highly dependent work and much coding are poorer fits. It found token use alone explained much of BrowseComp variance, meaning some gains came from spending more compute rather than superior coordination [2].

### 4.2 Communication is an information bottleneck

Yu et al. formalize multi-agent execution as isolated contexts connected by bounded relay messages. With an unbounded relay, a multi-agent system can reproduce a single agent's context flow; practical differences arise when compression removes redundant context or loses downstream-relevant information. Their controlled experiments find benefits when relays are near-sufficient and reversals when relay loss dominates, particularly for stronger models [3].

This maps closely to Agentique's typed handoffs:

- typed cores, evidence pointers, optional expanded extensions, and durable artifacts reduce relay loss;
- the 4 KiB ordinary soft target and separate provider contexts impose a deliberate information bottleneck;
- coordinator and main hops can filter noise or discard necessary nuance;
- retrieving canonical handoffs by id is safer than serial re-summarization.

**Inference:** topology and context policy cannot be evaluated independently. A peer edge carrying a poor summary may be worse than a coordinator edge carrying a lossless evidence reference.

### 4.3 Distributed-systems concepts are useful when the analogy is bounded

“Language Model Teams as Distributed Systems” studies teams through task graphs, critical paths, communication overhead, centralized scheduling, and self-coordination. The useful transfer is not that agents are processors; LLM agents are stochastic, context-sensitive, and may misunderstand the task. The useful transfer is to distinguish:

- the work DAG from the worker network;
- total work from critical-path latency;
- parallel fraction from coordination overhead;
- scheduling from authority;
- local recovery from replaying the entire job [4].

Agentique already has durable state suitable for localized recovery: task rows, mailbox deliveries, handoff lineage, provider entries, artifacts, and participant generations.

**Inference:** task-graph-aware scheduling and failure recovery are likely lower-risk opportunities than dynamic communication edges.

### 4.4 Organizational theory explains why one topology cannot fit every dependency

Galbraith's information-processing view links task uncertainty to organizational form: as uncertainty increases, an organization must either reduce the need for coordination or increase its capacity to process information [5]. Thompson's classic distinction among pooled, sequential, and reciprocal interdependence provides a useful diagnostic:

- **pooled:** independent contributions combine at the end—parallel specialists plus centralized synthesis fit well;
- **sequential:** one output becomes the next input—a single persistent worker or explicit pipeline avoids repeated re-briefing;
- **reciprocal:** participants repeatedly adjust to each other's evolving work—mutual communication can help, but also raises chatter, conflict, and authority costs [6].

These are analytical categories, not proof that human organization charts transfer directly to LLM agents. They are useful because Agentique can estimate dependency shape from tasks and ownership scopes.

### 4.5 Dynamic graph research proves feasibility, not local necessity

Peer-reviewed work now explores several kinds of adaptation:

- **AgentDropout** learns to remove redundant agents and communication edges across rounds, reporting lower prompt and completion token use with a small average task-performance gain [7].
- **Guided Topology Diffusion** generates sparse task-conditioned communication graphs guided by a multi-objective proxy for accuracy, utility, cost, and robustness [8].
- **LLM-as-Scheduler** chooses among workflows using a lightweight gate plus an LLM scheduler, reporting 43% fewer tokens and more than 36% lower latency for at most a 1.4-point accuracy loss against its strong fixed workflow [9].
- **TacoMAS**, currently a preprint, adapts capabilities quickly and topology more slowly; its own premise is that topology needs stability while task capabilities respond faster [10].

The strongest transferable point is that **adaptation has several time scales** and that sparse/selective execution can remove unnecessary work. The weakest transfer is the assumption that Agentique should generate arbitrary adjacency matrices. These systems generally optimize benchmark-specific graphs with reward signals and training or proxy models that Agentique does not currently possess.

### 4.6 Existing frameworks favor small orchestration primitives

OpenAI's Agents SDK distinguishes manager-style “agents as tools,” where one agent retains final control, from handoffs, where control transfers to a specialist. LangGraph distinguishes subagents, handoffs, routers, skills, and custom workflows. AutoGen offers round-robin, model-selected group chat, and handoff-based swarm patterns [11–13].

These are implementation examples, not comparative evidence. Their relevant lesson is architectural: complex workflows can be composed from a few explicit control-transfer and invocation primitives. Agentique should not introduce a universal graph type merely because other frameworks can express one.

---

## 5. A useful taxonomy for Agentique

| Level | Meaning | Current support | Expected value | Main risk |
|---|---|---:|---|---|
| **T0 — Implicit fixed topology** | Current behavior encoded across code and prompts | Yes | Simplicity and strong invariants | Hard to evaluate or extend deliberately |
| **T1 — Explicit fixed topology** | Name/version the current star and record why it was used | No | Observability and reproducibility | Small schema/event cost |
| **T2 — Task-level selection** | Choose among a very small set of known structures before work | Partly, via creating different rosters | Avoid needless coordination | Misclassification and policy drift |
| **T3 — Primitive composition** | Build a workstream from manager, worker, reviewer, join, and escalation primitives | Partly implicit | Better task fit without arbitrary edges | More lifecycle states and integration cases |
| **T4 — Boundary reconfiguration** | Change roster/edges at phase, failure, or scope-discovery checkpoints | New | Recover from incorrect initial assumptions | Ownership/context transfer failures |
| **T5 — Continuous self-reconfiguration** | Agents add/remove nodes and edges during turns | No | Potential adaptation to unforeseen work | Instability, unbounded cost, weak auditability |
| **T6 — Learned topology policy** | Train a selector or graph generator from outcome data | No | Possible long-run optimization | Insufficient local data and reward quality |

**Assessment:** T1 is justified now as measurement infrastructure. T2 is the first behavior worth testing. T3 and T4 are contingent options. T5 and T6 are research ideas without a current Agentique-scale evidence base.

---

## 6. At what unit should topology operate?

### 6.1 UserSession: stable authority envelope

The `UserSession` should retain one stable operator-facing authority model:

- the operator communicates with main;
- main owns interpretation, user decisions, and final response;
- all delegated execution remains durable and observable;
- permissions cannot be expanded by an agent message;
- topology changes cannot bypass approval or recovery invariants.

Changing this layer mid-session would confuse responsibility and user expectations. There is no evidence that doing so would improve value per token.

### 6.2 Task or coherent workstream: primary selection unit

This is the strongest candidate for topology selection. A task/workstream has a bounded goal, estimated dependencies, ownership, tool needs, risk, and acceptance checks. Main already creates AgentSessions at this level.

Candidate decisions include:

- execute directly in one profile-bound worker lane;
- use the current coordinator plus one worker when integration or operator escalation is likely;
- use parallel, disjoint specialists with centralized synthesis;
- append one isolated reviewer after deterministic checks;
- keep work in one long-running seat and rotate context rather than distribute it spatially.

### 6.3 Phase: safe adaptation boundary

Planning, exploration, implementation, verification, and recovery need different information and capabilities. A structure may remain stable within a phase while changing at the boundary:

```text
explore (parallel reads) → integrate decision → implement (single owner)
→ deterministic validation → independent review if residual risk is high
```

The Console already has phases, structured closing handoffs, task status, and context checkpoints. Those provide safe points to change execution structure without silently invalidating in-flight work.

### 6.4 Turn: scheduling and context, not topology by default

Turn-level decisions should normally cover which queued seat runs, which handoff expansion is needed, which tool is exposed, or whether a validator should fire. Editing authority or ownership edges every turn would make recovery and attribution substantially harder.

**Conclusion:** one system can require decisions at multiple levels, but they should have different stability guarantees:

| Level | Appropriate decision | Stability |
|---|---|---|
| UserSession | authority, operator interface, global safety envelope | Stable |
| Task/workstream | execution strategy and initial roster | Stable by default |
| Phase/checkpoint | reviewer addition, handoff, split/join, recovery | Change only with recorded transition |
| Turn | scheduling, context retrieval, tool choice | Freely adaptive within policy |

---

## 7. How topology should be selected

### 7.1 Explicit operator selection

Useful for experimentation, debugging, and exceptional high-stakes work; poor as the everyday default because it exposes implementation detail and asks the operator to predict runtime behavior.

### 7.2 Inspectable rule policy

The best first production candidate. Rules can be versioned, logged, overridden, and evaluated. They should default to the least expensive structure expected to meet the quality/risk requirement.

An initial hypothesis—not a validated policy—is:

```text
single worker
  unless independent scopes can proceed in parallel,
  or expected context exceeds one healthy worker generation,
  or integration/decision load justifies a coordinator,
  or residual write risk justifies an isolated reviewer.
```

### 7.3 Model-inferred selection

Main already implicitly judges decomposition and roster size. Turning that judgment into a typed decision could improve observability, but the model should return features and rationale into a constrained policy rather than invent an unrestricted graph.

### 7.4 Negotiation during execution

A seat may discover that scope is larger, dependencies are reciprocal, or its capability is insufficient. It should be able to request a structural change, but not enact authority changes unilaterally. The coordinator or main can approve the request at a durable boundary.

This separates **discovery** (local and agentic) from **authorization** (central and auditable).

### 7.5 Learned selection

A contextual bandit or learned router requires many representative decisions, stable arm definitions, reliable delayed rewards, and enough exploration to estimate counterfactual value. Agentique currently has none of these at useful scale. A learned policy should be deferred until a simple rule policy has a substantial, diverse outcome dataset and demonstrable residual regret.

---

## 8. Information required for reliable decisions

### 8.1 Pre-execution features

- estimated task length and context footprint;
- number of independent deliverables and dependency depth;
- pooled, sequential, or reciprocal interdependence;
- expected file/component ownership overlap;
- required profiles, tools, and permissions;
- availability of deterministic acceptance checks;
- reversibility and failure impact;
- ambiguity and likelihood of operator decisions;
- expected integration burden;
- latency sensitivity and token/cost budget.

### 8.2 Trajectory signals

- newly discovered scope or dependencies;
- repeated handoff retrieval or discrepancy reports;
- duplicate file/tool exploration across seats;
- coordinator queue delay and blocked work;
- context growth and rotation proximity;
- failed turns, retries, and reassignment;
- conflicting claims or write scopes;
- deterministic validation failures;
- task progress relative to tokens and elapsed time.

### 8.3 Decision confidence and abstention

The policy must be able to say “insufficient evidence; retain the current structure.” Structural changes have switching costs: checkpoint generation, context transfer, scheduler churn, cache loss, new failure states, and additional messages. Adaptation should require expected benefit greater than both the switching cost and uncertainty margin.

A conceptual trigger is:

`change iff E[quality/efficiency gain | evidence] > switch_cost + uncertainty_margin`

Agentique cannot estimate this expression reliably today. The first implementation should record its components rather than pretend to compute a precise score.

### 8.4 Signals that complexity is probably harmful

- one clear sequential owner;
- short predicted duration;
- high shared-context requirement;
- low-risk reversible change with strong deterministic checks;
- no independent evidence partitions;
- coordinator work would merely restate the same assignment;
- expected communication and briefing tokens approach task-work tokens;
- no reliable selector or validator for parallel alternatives.

### 8.5 Signals that more structure may help

- genuinely independent scopes with low merge conflict;
- breadth/search tasks where coverage matters;
- one workstream would exceed healthy context limits;
- heterogeneous tools or permissions must be isolated;
- high-risk output benefits from an independent verifier;
- a failure can be retried locally without invalidating other branches;
- substantial latent parallelism lies off the critical path.

These conditions are hypotheses to test locally, not automatic spawn rules.

---

## 9. Domain and runtime representation

### 9.1 Do not start with a generic graph

If the only tested alternatives are “direct worker” and “coordinator star,” an enum-like execution strategy plus a versioned decision record is sufficient. A generic node/edge schema becomes justified only after several production-worthy structures require composition.

The minimum useful conceptual records are:

```ts
type ExecutionStrategy =
  | "coordinator_star_v1"
  | "direct_worker_v1";

interface TopologyDecision {
  id: string;
  userSessionId: string;
  taskId: string | null;
  strategy: ExecutionStrategy;
  policyVersion: string;
  source: "operator" | "rule" | "model_proposal" | "recovery";
  features: Record<string, string | number | boolean | null>;
  rationale: string;
  confidence: number | null;
  budget: { tokenLimit?: number; timeLimitMs?: number };
  createdAt: string;
}
```

This is a research sketch, not a committed API.

### 9.2 If composition later becomes necessary

Prefer typed primitives over arbitrary edges:

- `delegate` — transfer a bounded owned task;
- `report` — return a result or milestone;
- `notify` — share evidence without transferring authority;
- `validate` — independently check an artifact/claim;
- `escalate` — request a higher-authority decision;
- `join` — integrate several completed branches;
- `checkpoint` — transfer recoverable context at a phase/generation boundary.

Every transition should identify the owner before and after, canonical handoff, pending deliveries, tasks affected, and rollback/recovery behavior.

### 9.3 Interaction with existing concepts

| Existing concept | Topology implication |
|---|---|
| `UserSession` | Owns the stable authority envelope and global policy defaults. |
| `AgentSession` | Becomes one topology instance or workstream, not necessarily synonymous with a star forever. |
| Participant/profile | Defines a node's snapshotted capability and permission boundary. |
| Task | Supplies selection features, ownership, dependencies, and evaluation unit. |
| Mailbox/message | Remains the durable transport for every permitted communication edge. |
| Handoff | Remains the canonical context-transfer protocol across edges and transitions. |
| Routing | Enforces the active topology; it should not infer it ad hoc. |
| Context management | Decides information payload/retrieval independently of authority edges. |
| Observability/event spine | Records topology decision, activation, transition, rejection, and outcome attribution. |
| Execution state | Must prevent transition while turns, writes, or deliveries make ownership ambiguous. |

### 9.4 Required invariants for any future topology

1. Exactly one operator-facing authority owns the response.
2. Every mutable scope has at most one active writer unless an explicit merge protocol exists.
3. Every communication edge uses durable Console transport.
4. Tool and permission authority comes from snapshotted policy, never from messages.
5. Every task has an attributable owner and terminal condition.
6. Every join identifies who validates and integrates results.
7. Reconfiguration occurs only after in-flight state is quiescent or explicitly transferred.
8. Recovery can reconstruct topology, ownership, pending work, and latest canonical context from SQLite.
9. Limits bound participants, messages, transitions, tokens, time, and retries.
10. The UI can explain the active structure and why it changed.

---

## 10. Design directions, ranked by evidence and complexity

### Direction A — Make the current topology observable

**Status:** strongest immediate direction.  
**Change:** record strategy/policy identity, selection rationale, task features, and topology-attributed outcomes while preserving the current star.  
**Hypothesis:** explicit attribution will reveal which task regimes pay disproportionate coordination cost or benefit from centralized containment.  
**Value:** enables every later experiment; negligible behavioral risk.  
**Risk:** telemetry without a quality corpus can still encourage optimizing easy cost metrics.

### Direction B — Add one fair single-worker lane

**Status:** strongest behavioral experiment.  
**Change:** one profile-bound worker communicates durably with main without an obligatory AgentSession coordinator; tasks, handoffs, permissions, recovery, and events remain Console-owned.  
**Hypothesis:** short sequential, low-integration tasks preserve quality with fewer coordination tokens and lower latency.  
**Do not infer:** main should gain write tools, or all coordinators are waste.  
**Risk:** main absorbs integration/decision load, so the lane may only move rather than remove cost.

### Direction C — Selective independent validation

**Status:** well-supported pattern, orthogonal to worker count.  
**Change:** add a fresh-context reviewer after deterministic checks only when risk and unverifiable residual properties justify it.  
**Hypothesis:** independent review improves reliability per token more consistently than adding collaborating peers.  
**Risk:** reviewers can duplicate deterministic work or rubber-stamp claims; review quality must be measured.

### Direction D — Phase-specific composition using current primitives

**Status:** promising after A–C.  
**Change:** create separate bounded AgentSessions or seats for exploration, implementation, and review, joined by canonical handoffs and tasks.  
**Hypothesis:** broad exploration benefits from parallelism while implementation retains one writer and review retains independence.  
**Risk:** each phase boundary creates relay and cache-cold costs.

### Direction E — Narrow peer notification

**Status:** conditional.  
**Change:** allow a specialist to send a typed, non-authoritative evidence notification to an affected owner while coordinator remains visible and responsible.  
**Hypothesis:** reciprocal or cross-cutting discoveries unblock work faster without full mesh coordination.  
**Risk:** increased context, interruptions, duplicate action, and ambiguous response obligations.  
**Gate:** test only after traces show coordinator relay delay is a repeated material bottleneck.

### Direction F — Boundary reconfiguration

**Status:** research option.  
**Change:** add/retire a seat or split/join a workstream at explicit checkpoints.  
**Hypothesis:** runtime scope discovery makes initial task-level selection insufficient.  
**Risk:** ownership transfer, recovery, and UI state become substantially more complex.  
**Gate:** require evidence that creating a new AgentSession cannot solve the same cases adequately.

### Direction G — Learned or generated topology

**Status:** defer.  
**Hypothesis:** a trained selector outperforms inspectable rules on a stable family of frequent tasks.  
**Missing prerequisites:** representative volume, stable arms, reliable outcome rewards, safe exploration, drift monitoring, and a reason generic graphs beat small primitives.

---

## 11. Evaluation framework

### 11.1 Primary objective

Do not collapse the goal into one opaque score. Use a quality-constrained Pareto analysis:

1. establish task success and quality non-inferiority;
2. among acceptable-quality runs, compare tokens, latency, reliability, and operator effort;
3. report variance and tail failures, not only means.

### 11.2 Experimental fairness

Every topology comparison must hold constant or explicitly report:

- model and effort;
- total token and turn budgets;
- tools and permissions needed for the task;
- workspace snapshot and starting context;
- acceptance checks and grader;
- retry policy and timeout;
- degree of parallel wall-clock capacity;
- whether main/coordinator synthesis tokens are included;
- provider caching conditions.

The current main cannot implement, so a “single agent” baseline must be a profile-bound worker with equivalent tools—not an artificially weakened read-only main.

### 11.3 Task strata

| Stratum | Structural prediction to test |
|---|---|
| Short sequential diagnosis/fix | Direct worker should avoid unnecessary relay cost. |
| Long sequential implementation | One persistent worker may win until context degradation makes checkpointing valuable. |
| Independent repository exploration | Parallel specialists may improve coverage and latency. |
| Cross-component change with disjoint ownership | Centralized parallel execution may help if integration is bounded. |
| Tightly coupled shared-file change | Multiple writers or frequent relays may harm quality. |
| High-risk change with deterministic tests | Deterministic gates first; reviewer adds value only for residual risk. |
| Subjective UI/research output | Independent review may help where deterministic checks are weak. |
| Injected participant/coordinator failure | Durable centralized state should enable localized recovery. |
| Scope-discovery task | Tests whether boundary adaptation beats starting a new workstream. |

### 11.4 Metrics

#### Output quality and completion

- deterministic acceptance pass/fail;
- task completion and honest terminal state;
- blinded pairwise or rubric score for non-deterministic properties;
- regression, rollback, and rework rate;
- operator correction/intervention count.

#### Value per token

- total, uncached input, cache creation/read, and output tokens;
- cost per successful run;
- tokens per accepted artifact/change;
- quality at matched token budget;
- success at matched cost.

“Useful work per token” should be reported as a family of ratios after quality gating, not one universal scalar.

#### Coordination overhead

- briefing, handoff, coordinator, synthesis, and topology-decision tokens;
- coordination turns divided by all turns;
- message count, bytes, retrievals, and relay depth;
- duplicate commands, overlapping reads/searches, and repeated evidence discovery;
- time waiting for coordinator, join, decision, or ownership release.

#### Latency and parallelism

- end-to-end latency;
- provider/tool/queue time;
- critical-path duration;
- total active agent-seconds;
- realized concurrency and idle time;
- time-to-first-useful-artifact.

#### Reliability and recovery

- turn/delivery/task failure rates;
- propagated versus contained defects;
- contradictory handoff claims and discrepancy reports;
- retry and reassignment success;
- recovery time and tokens;
- orphaned tasks/deliveries;
- variance and worst-decile quality.

#### Implementation complexity

- number of new persistent states and transitions;
- number of routing/authority invariants;
- migration and recovery branches;
- test matrix size;
- operator-visible concepts;
- incidents attributable to topology selection or transition.

### 11.5 Missing telemetry

Agentique already records participant-level token/cache/cost usage, mailbox transitions, handoff size/lineage/retrieval, task changes, context rotations, and failures. It still needs, for topology experiments:

- topology strategy, policy version, instance id, and selection source;
- selection features, rationale, confidence, rejected alternatives, and override;
- topology activation/transition timestamps and switching cost;
- per-turn queue/provider/tool/end-to-end durations;
- explicit coordination-work classification;
- experiment/arm/replicate identity;
- task outcome, acceptance results, and quality grade;
- retry/rework/rollback and operator intervention attribution.

### 11.6 Experimental sequence and stop conditions

#### E0 — Retrospective baseline

Instrument the unchanged current star. Build a task corpus and measure coordination share, latency, success, and failures by task stratum.

**Stop if:** task outcomes cannot be graded reliably. Fix evaluation before topology.

#### E1 — One-worker ablation

Compare a direct profile-bound worker with current star-plus-one-worker on paired short sequential tasks.

**Advance if:** quality is non-inferior and token or latency reduction is repeatable; otherwise retain the star.

#### E2 — Parallelism and review factorization

Separately test worker count, centralized synthesis, and isolated review on parallel, coupled, and high-risk strata.

**Stop an arm if:** it adds cost without a quality, coverage, latency, or reliability benefit in its target stratum.

#### E3 — Frozen rule selector

Use pre-execution features to select only among arms that already proved useful. Compare the selector with each fixed arm and an oracle chosen retrospectively.

Measure selection accuracy, regret, abstention, and calibration—not only end quality.

#### E4 — Boundary adaptation

Inject late scope discoveries, validator failures, participant loss, and context pressure. Compare keeping the initial structure, creating a new AgentSession, and explicit phase-bound reconfiguration.

**Advance if:** reconfiguration improves recovery or quality beyond the simpler “new workstream” mechanism after switching cost is included.

#### E5 — Learned policy

Consider only after a frozen rule policy accumulates enough diverse, stable, graded decisions to justify training and held-out validation.

No experiment should begin with unrestricted peer mesh or continuous graph mutation; neither has a specific unresolved Agentique failure hypothesis today.

---

## 12. Risks and unresolved questions

### Architectural risks

- A generic topology domain may duplicate tasks, profiles, sessions, and routing rather than unify them.
- Dynamic ownership can create split-brain writers or ambiguous responsibility.
- More edges increase prompt-injection and authority-confusion surfaces.
- Reconfiguration can invalidate provider caches and discard context.
- A central selector becomes a new failure and bias point.
- A model may choose complexity because it appears diligent, not because it adds value.
- UI explanations and recovery logic may lag runtime flexibility.

### Evaluation risks

- Better outcomes from multi-agent arms may simply reflect larger token or parallel-compute budgets.
- Deterministic checks cover only known properties; model judges can share the actors' biases.
- Task strata may be misclassified, especially before exploration.
- Repository tasks are few and heterogeneous; aggregate averages can hide regime-specific reversals.
- Online learning at single-operator volume is unlikely to overcome delayed, noisy rewards.
- Topology changes are rare events, making tail reliability hard to estimate.

### Unresolved empirical questions

1. What fraction of real Agentique work is short and sequential enough to avoid a coordinator?
2. How many coordinator tokens are integration that main would otherwise spend anyway?
3. Does the typed handoff protocol make the second relay effectively lossless enough that the star's cost is small?
4. How often do specialists become blocked specifically by the no-peer rule?
5. Do ownership scopes predict decomposability and merge conflict accurately?
6. When context rotation occurs, is a fresh generation within one seat better than spatial delegation to another seat?
7. Does isolated review find defects after deterministic checks often enough to justify its cost?
8. Is creating a new AgentSession an adequate substitute for live roster mutation?
9. Can main select a structure reliably before exploration, or should it begin minimally and escalate at a checkpoint?
10. Which quality signal is reliable enough to train or even tune a selector?

---

## 13. Final conclusions

### Established from the repository

- Agentique's topology spans authority, context, capabilities, task ownership, validation, escalation, and integration—not only messages.
- The current star is fixed inside each AgentSession but dynamically composed across a UserSession through on-demand AgentSessions.
- The control topology is centralized while execution is already concurrent.
- Strong durability, permission, recovery, and finalization invariants depend on the current structure.
- Topology identity, selection rationale, transitions, and topology-attributed quality are not represented.

### Supported by external evidence

- Task decomposability, sequential dependency, relay sufficiency, tool density, and validation structure materially affect whether multi-agent coordination helps.
- Centralized coordination can contain errors and integrate parallel work, but sequential or highly shared-context tasks can lose quality and efficiency.
- Workflow selection and sparse execution can reduce unnecessary token and latency cost in tested domains.
- Communication graphs can be optimized, but published benchmark results do not establish that arbitrary runtime graph mutation is valuable for Agentique.

### Strongest design interpretation

`Dynamic Topology` should initially mean:

> An explicit, versioned, observable choice of execution/coordination strategy for a task or coherent workstream, operating inside a stable UserSession authority envelope, with any later structural change restricted to durable phase or recovery boundaries.

This interpretation is meaningful, testable, and compatible with the Console's existing strengths.

### Ideas requiring experimentation

- a direct single-worker lane;
- rule-based task-level selection;
- selective independent review;
- phase-specific composition;
- narrow peer notification;
- live roster/edge reconfiguration;
- learned topology selection.

The first four have clear value hypotheses. The latter three should not be implemented until traces identify a specific failure that smaller changes cannot solve.

### Neutral recommendation

Do not commit Agentique Console to “multiple topologies” or “dynamic graph selection” as product abstractions yet. Commit instead to **making structural decisions measurable**. If the current star remains on the quality/value Pareto frontier after fair comparisons, explicit topology will still have paid for itself through reproducibility and evidence. If it does not, the same instrumentation will show exactly which smaller alternative earns a place.

---

## References

1. Kim et al., [“Towards a Science of Scaling Agent Systems: When and Why Agent Systems Work”](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), Google Research/MIT, 2026; paper linked from the article.
2. Anthropic, [“How we built our multi-agent research system”](https://www.anthropic.com/engineering/multi-agent-research-system), 2025.
3. Yu et al., [“When Do Multi-Agent Systems Help? An Information Bottleneck Perspective”](https://arxiv.org/abs/2607.16133), arXiv:2607.16133, 2026 preprint.
4. Chen et al., [“Language Model Teams as Distributed Systems”](https://arxiv.org/abs/2603.12229), arXiv:2603.12229, 2026 preprint.
5. Galbraith, [“Organization Design: An Information Processing View”](https://doi.org/10.1287/inte.4.3.28), *Interfaces* 4(3), 1974.
6. Thompson, [*Organizations in Action*](https://books.google.com/books?id=YhHo7aHmBGMC), 1967. The pooled/sequential/reciprocal framework is used only as an analytical analogy.
7. Wang et al., [“AgentDropout: Dynamic Agent Elimination for Token-Efficient and High-Performance LLM-Based Multi-Agent Collaboration”](https://aclanthology.org/2025.acl-long.1170/), ACL 2025.
8. Jiang et al., [“Dynamic Generation of Multi LLM Agents Communication Topologies with Graph Diffusion Models”](https://aclanthology.org/2026.acl-long.1764/), ACL 2026.
9. Xiang et al., [“LLM-as-Scheduler: Agentic Workflow Dynamic Scheduling”](https://aclanthology.org/2026.acl-long.581/), ACL 2026.
10. Xu et al., [“TacoMAS: Test-Time Co-Evolution of Topology and Capability in LLM-based Multi-Agent Systems”](https://arxiv.org/abs/2605.09539), arXiv:2605.09539, 2026 preprint.
11. OpenAI, [Agents SDK: Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/), current documentation.
12. LangChain, [LangGraph multi-agent patterns](https://langchain-ai.github.io/langgraph/tutorials/multi_agent/multi-agent-collaboration/), current documentation.
13. Microsoft, [AutoGen teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html) and [handoffs](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/design-patterns/handoffs.html), current documentation.

## Repository anchors

- `README.md` — intended execution model and enforced star.
- `shared/src/domain.ts` — UserSession, AgentSession, participant summaries, and tasks.
- `shared/src/handoffs.ts` — canonical context-transfer contract and lineage.
- `shared/src/events.ts` — mailbox, usage, context rotation, task, and handoff observability.
- `server/src/agent-sessions/host.ts` — session creation, routing, scheduling, tools, finalization, and recovery.
- `server/src/orchestrator/runner.ts` — serialized main turns, wake coalescing, usage, and rotation.
- `server/src/orchestrator/tools.ts` — managed delegation and task interfaces.
- `server/src/agent-profiles/registry.ts` — snapshotted capability and permission profiles.
- `server/src/tasks/service.ts` — cross-session task attribution and dependencies.
- `server/src/db/schema.ts` — durable participants, mailboxes, tasks, events, usage, and handoffs.
