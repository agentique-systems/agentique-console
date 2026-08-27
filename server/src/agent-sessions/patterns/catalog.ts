/**
 * The pattern catalog: one pure builder per orchestration pattern, each
 * compiling operator/model input into a TopologyContract plus the agent plan
 * the service inserts. Builders are the ONLY place pattern names mean
 * anything — the service executes whatever contract comes out.
 *
 * Two invariants every builder must hold (asserted in `buildContract`):
 * - every role's protocol includes the operator-path bullets — the trust
 *   rules are the console's, not the pattern's to drop;
 * - `completion.finalFrom` and `completion.voice` name single-agent roles, so
 *   role→agent resolution is first-by-ord everywhere.
 */
import { z } from "zod";
import type { PatternId } from "@agentique-console/shared";
import type { RolePrompt, RoleSpec, TopologyContract } from "../topology-contract.ts";
import { InvalidInputError } from "../../errors.ts";
import type { AgentProfile } from "../../agent-profiles/registry.ts";
import { OPERATOR_PATH_BULLETS, PROTOCOL_INTRO, TERMINAL_REPORT_BULLET } from "../presets.ts";
import { hubContract } from "../topology.ts";

export interface BuildAgent {
  name: string; profileId?: string; instructions?: string; model?: string; owns?: string[];
  /** Commission-time skill additions, union'd with the profile's defaults. */
  skills?: string[];
}
export interface BuildInput {
  agents: BuildAgent[];
  config: Record<string, unknown> | undefined;
  resolveProfile(id: string): AgentProfile;
}
export interface AgentPlan {
  name: string;
  /** Contract role binding ("coordinator", "specialist", "mapper", …). */
  role: string;
  profileId: string;
  instructions?: string;
  model?: string;
  /** Extra skills pinned into this seat's profile snapshot at creation. */
  skills?: string[];
  owns: string[];
  ord: number;
}
export interface BuildResult {
  contract: TopologyContract;
  agents: AgentPlan[];
  /** Name of the pattern's dedicated coordination agent, when it seats one. */
  coordinatorName?: string;
}

/**
 * The sole-coordination-authority guard, shared by every door that seats a
 * caller-chosen profile (commission and child creation via `buildContract`,
 * late add_agent). Contract-derived and structural, never nominal: when the
 * contract says the Console seats the coordination authority itself
 * (`autoCoordinatorRole`), a caller-supplied seat must not carry an
 * orchestrator-archetype profile — renaming the seat changes nothing,
 * because the check reads the profile's role archetype. (A live run renamed
 * the coordinator profile to "movelead" past the reserved-NAME check and ran
 * two management layers per hub.) Broad-scope planner/reviewer/explorer
 * profiles pass: intellectual scope is not dispatch authority.
 */
export function assertSoleCoordinationAuthority(
  contract: Pick<TopologyContract, "pattern" | "autoCoordinatorRole">,
  seats: { name: string; profile: AgentProfile }[],
): void {
  const autoRole = contract.autoCoordinatorRole;
  if (autoRole === undefined) return;
  for (const seat of seats) {
    if (seat.profile.role !== "orchestrator") continue;
    throw new InvalidInputError(
      `agent "${seat.name}" uses profile "${seat.profile.id}", an orchestrator-archetype (coordination) profile — but ${contract.pattern} seats its ${autoRole} automatically, so whatever this seat is named it would be a second coordination authority relaying state with the console-seated one instead of producing. Commission a productive specialist instead (implementer / explorer / reviewer / planner — an independent reviewer may cover the whole domain without being a controller), or choose a pattern that expects an explicit controller, like plan_execute.`,
    );
  }
}

export function buildContract(pattern: PatternId, input: BuildInput): BuildResult {
  const built = builderOf(pattern)(input);
  // Structural, before anything downstream spends a resource: a commission
  // into an auto-coordinated contract must not smuggle in a second
  // coordinator under a fresh seat name.
  if (built.contract.autoCoordinatorRole !== undefined) {
    assertSoleCoordinationAuthority(built.contract, input.agents.map((agent) => ({
      name: agent.name, profile: input.resolveProfile(agent.profileId ?? "explorer"),
    })));
  }
  // The terminal-report rule is appended HERE, once, to every role — never
  // restated per pattern. A fresh promptPack object each call: builders may
  // return shared contract singletons (hubContract), which must not mutate.
  const result: BuildResult = {
    ...built,
    contract: {
      ...built.contract,
      promptPack: Object.fromEntries(Object.entries(built.contract.promptPack)
        .map(([role, prompt]) => [role, { ...prompt, protocol: `${prompt.protocol}${TERMINAL_REPORT_BULLET}` }])),
    },
  };
  for (const [role, prompt] of Object.entries(result.contract.promptPack)) {
    if (!prompt.protocol.includes(OPERATOR_PATH_BULLETS)) {
      throw new Error(`pattern ${pattern}: role ${role} drops the operator-path protocol bullets`);
    }
  }
  for (const which of ["finalFrom", "voice"] as const) {
    const role = result.contract.completion[which];
    if (result.contract.roles[role] === undefined || result.contract.roles[role].max !== 1) {
      throw new Error(`pattern ${pattern}: completion.${which} must name a single-agent role, got "${role}"`);
    }
  }
  return result;
}

function builderOf(pattern: PatternId): (input: BuildInput) => BuildResult {
  switch (pattern) {
    case "hub_and_spoke": return buildHub;
    case "pipeline": return buildPipeline;
    case "evaluator_optimizer": return buildEvaluatorOptimizer;
    case "map_reduce": return buildMapReduce;
    case "debate": return buildDebate;
    case "peer_to_peer": return buildPeerToPeer;
    case "plan_execute": return buildPlanExecute;
  }
}

function agentPlans(agents: BuildAgent[], roleOf: (index: number) => string, firstOrd: number): AgentPlan[] {
  return agents.map((agent, index) => ({
    name: agent.name, role: roleOf(index),
    profileId: agent.profileId ?? "explorer",
    ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.skills !== undefined ? { skills: agent.skills } : {}),
    owns: agent.owns ?? [], ord: firstOrd + index,
  }));
}

// ── hub_and_spoke ──────────────────────────────────────────────────────────

function buildHub(input: BuildInput): BuildResult {
  if (input.agents.length < 1 || input.agents.length > 20) throw new InvalidInputError("hub_and_spoke seats 1 to 20 specialists — the Console seats the coordinator itself, so supply at least one productive specialist");
  return {
    contract: hubContract(),
    agents: [
      { name: "coordinator", role: "coordinator", profileId: "coordinator", owns: [], ord: 0 },
      ...agentPlans(input.agents, () => "specialist", 1),
    ],
    coordinatorName: "coordinator",
  };
}

// ── pipeline ───────────────────────────────────────────────────────────────

const PIPELINE_WORK_BULLET = `
- You are one stage in a pipeline: take what the previous stage handed you,
  ADD your stage's work, and pass the FULL augmented result forward with your
  ledger taskId. If your stage has nothing to add, say exactly that and name
  the gap when you pass it on.`;

function buildPipeline(input: BuildInput): BuildResult {
  const names = input.agents.map((agent) => agent.name);
  if (names.length < 2) throw new InvalidInputError("a pipeline needs at least 2 stages");
  if (names.length > 20) throw new InvalidInputError("a pipeline seats at most 20 stages");
  const roleOf = (index: number): string => `stage.${index + 1}`;
  const last = names.length - 1;
  const roles: Record<string, RoleSpec> = {};
  const promptPack: Record<string, RolePrompt> = {};
  const protocol = `${PROTOCOL_INTRO}${PIPELINE_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  names.forEach((name, index) => {
    // tasks_write: the evaluator learned this the hard way (a live run ended
    // with both its units still pending — see the evaluator's grant comment);
    // the same hole then bit a pipeline run. Every stage owns a unit.
    roles[roleOf(index)] = { replicable: false, min: 1, max: 1, grants: ["tasks_write"], escalateTo: "main" };
    const position = `You are stage ${index + 1} of ${names.length} in a pipeline.`;
    promptPack[roleOf(index)] = {
      addressing: index === last
        ? `Address participants by bare name; "main" reaches the Orchestrator. ${position} You are the FINAL stage: send the finished result to "main"; failures go to "main" too.`
        : `Address participants by bare name; "main" reaches the Orchestrator. ${position} Send your completed stage work to "${names[index + 1]}"; failures go to "main".`,
      protocol,
    };
  });
  return {
    contract: {
      schemaVersion: 1,
      pattern: "pipeline",
      roles,
      edges: [
        { from: "main", to: roleOf(0), advance: "immediate" },
        // Corrections stop being smuggled through stage 1: main can steer ANY
        // stage directly, update-only — assignments keep one front door. The
        // roguelike run's "FOR STAGE 3 (ui)" addressed to stage 1 (the only
        // legal recipient) woke a finished agent that misapplied it.
        ...names.slice(1).map((_, index): TopologyContract["edges"][number] => ({
          from: "main", to: roleOf(index + 1), advance: "immediate", categories: ["update"],
        })),
        ...names.slice(0, -1).map((_, index): TopologyContract["edges"][number] => ({
          from: roleOf(index), to: roleOf(index + 1), advance: "immediate",
          categories: ["assignment", "update", "milestone", "failure", "decision"],
        })),
        ...names.slice(0, -1).map((_, index): TopologyContract["edges"][number] => ({
          from: roleOf(index), to: "main", advance: "immediate", categories: ["failure"],
        })),
        { from: roleOf(last), to: "main", advance: "immediate", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [],
      entry: { role: roleOf(0), broadcast: false },
      termination: {},
      completion: { finalFrom: roleOf(last), voice: roleOf(last) },
      promptPack,
      routeSummary: `main → ${names.join(" → ")} → main`,
      limits: { minAgents: 2, maxAgents: 20 },
      config: { stages: names },
    },
    agents: agentPlans(input.agents, roleOf, 0),
  };
}

// ── evaluator_optimizer ────────────────────────────────────────────────────

const EVALUATOR_CONFIG = z.object({
  generatorAgent: z.string().optional(),
  rubric: z.string().max(4_000).optional(),
  // Default 5, not 3: a live run's architecture loop tripped at round 3 with
  // a real defect unreported — the evaluator had found it, the loop died
  // before the fix round.
  maxRounds: z.number().int().min(1).max(10).default(5),
  requireDistinctModels: z.boolean().default(true),
});

const LOOP_WORK_BULLET = `
- You are one half of a generate-evaluate loop: the generator produces and
  revises the deliverable, the evaluator judges it against the rubric and
  either sends a concrete critique back or accepts by reporting the result to
  main. Send the FULL work product each round. The Console bounds the loop;
  make each round count.`;

function buildEvaluatorOptimizer(input: BuildInput): BuildResult {
  if (input.agents.length !== 2) throw new InvalidInputError("evaluator_optimizer seats exactly 2 agents: a generator and an evaluator");
  const config = EVALUATOR_CONFIG.parse(input.config ?? {});
  const generator = config.generatorAgent === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.generatorAgent)
      ?? (() => { throw new InvalidInputError(`generatorAgent "${config.generatorAgent}" is not one of the agents`); })();
  const evaluator = input.agents.find((agent) => agent.name !== generator.name)!;
  if (config.requireDistinctModels) {
    const modelOf = (agent: BuildAgent): string | undefined =>
      agent.model ?? input.resolveProfile(agent.profileId ?? "explorer").model;
    const generatorModel = modelOf(generator);
    const evaluatorModel = modelOf(evaluator);
    if (generatorModel !== undefined && generatorModel === evaluatorModel) {
      throw new InvalidInputError(`generator and evaluator both resolve to ${generatorModel}; same-model loops collude — override one agent's model, or pass patternConfig.requireDistinctModels: false`);
    }
  }
  const protocol = `${PROTOCOL_INTRO}${LOOP_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  const rubric = config.rubric === undefined ? "" : `\n\nRubric to judge against:\n${config.rubric}`;
  return buildEvaluatorContract(input, generator, evaluator, config, protocol, rubric);
}

function buildEvaluatorContract(input: BuildInput, generator: BuildAgent, evaluator: BuildAgent,
  config: z.infer<typeof EVALUATOR_CONFIG>, protocol: string, rubric: string): BuildResult {
  return {
    contract: {
      schemaVersion: 1,
      pattern: "evaluator_optimizer",
      roles: {
        generator: { replicable: false, min: 1, max: 1, grants: [], escalateTo: "evaluator" },
        // `tasks_write`: the evaluator is this session's reporting agent, and a
        // loop with no ledger-writing seat cannot close a single unit main
        // opened for it — a live run ended with both of its tasks still
        // `pending` because neither role held this grant.
        evaluator: { replicable: false, min: 1, max: 1, grants: ["forward_message", "tasks_write"], extensionKind: "review", escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "generator", advance: "immediate" },
        { from: "main", to: "evaluator", advance: "immediate", categories: ["update"] },
        { from: "generator", to: "evaluator", advance: "immediate", categories: ["update", "milestone", "failure", "decision"] },
        { from: "evaluator", to: "generator", advance: "immediate", categories: ["assignment", "update", "decision"], countsRound: true },
        { from: "evaluator", to: "main", advance: "immediate", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [],
      entry: { role: "generator", broadcast: false },
      termination: { maxRounds: config.maxRounds },
      completion: { finalFrom: "evaluator", voice: "evaluator" },
      promptPack: {
        generator: {
          addressing: `Address participants by bare name. Send every draft and revision to "${evaluator.name}".`,
          protocol,
          brief: `You are the GENERATOR. Produce the deliverable; when "${evaluator.name}" returns a critique, revise against every point and resend. Judging is the evaluator's job.`,
        },
        evaluator: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator.`,
          protocol,
          brief: `You are the EVALUATOR. Judge each submission from "${generator.name}" against the rubric with concrete, actionable findings. If it falls short, send the critique back as a decision handoff; when it meets the bar, report the result to "main" (forward_message forwards the generator's report verbatim). Hold the bar exactly where the rubric puts it.${rubric}`,
        },
      },
      routeSummary: `main → ${generator.name} ⇄ ${evaluator.name} → main`,
      limits: { minAgents: 2, maxAgents: 2 },
      config: { generatorAgent: generator.name, evaluatorAgent: evaluator.name, maxRounds: config.maxRounds, ...(config.rubric === undefined ? {} : { rubric: config.rubric }) },
    },
    agents: [
      ...agentPlans([generator], () => "generator", 0),
      ...agentPlans([evaluator], () => "evaluator", 1),
    ],
  };
}

// ── map_reduce ─────────────────────────────────────────────────────────────

const MAP_REDUCE_CONFIG = z.object({
  maxMappers: z.number().int().min(1).max(8).default(8),
});

const MAP_REDUCE_WORK_BULLET = `
- You are part of a map-reduce: the reducer splits the work into independent
  items with dispatch_work_items, one minted mapper agent does exactly one item,
  and the Console holds every mapper report until the join is met — the join
  counts terminal reports, then they all arrive at the reducer in ONE turn
  for synthesis.`;

function buildMapReduce(input: BuildInput): BuildResult {
  if (input.agents.length !== 1) throw new InvalidInputError("map_reduce seats exactly 1 agent at creation: the reducer (mappers are minted per work item by dispatch_work_items)");
  const config = MAP_REDUCE_CONFIG.parse(input.config ?? {});
  const reducer = input.agents[0]!;
  const protocol = `${PROTOCOL_INTRO}${MAP_REDUCE_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "map_reduce",
      roles: {
        reducer: { replicable: false, min: 1, max: 1, grants: ["map_dispatch", "tasks_write", "forward_message"], escalateTo: "main" },
        mapper: { replicable: true, min: 0, max: config.maxMappers, grants: [], escalateTo: "reducer" },
      },
      edges: [
        { from: "main", to: "reducer", advance: "immediate" },
        { from: "main", to: "mapper", advance: "immediate", categories: ["update"] },
        { from: "reducer", to: "mapper", advance: "immediate", categories: ["assignment", "update", "decision"] },
        { from: "mapper", to: "reducer", advance: "join", categories: ["update", "milestone", "failure", "decision"] },
        { from: "reducer", to: "main", advance: "immediate", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [{ id: "map", over: "mapper", deliverTo: "reducer" }],
      entry: { role: "reducer", broadcast: false },
      termination: {},
      completion: { finalFrom: "reducer", voice: "reducer" },
      promptPack: {
        reducer: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator.`,
          protocol,
          brief: `You are the REDUCER. Split the briefing into independent work items and fan them out with dispatch_work_items — one item per mapper, width decided by the work. The Console delivers every mapper report to you in one turn once all have reported; synthesize them and report the combined result to "main". The mappers do the items; you own the split and the synthesis.`,
        },
        mapper: {
          addressing: `Address participants by bare name. Your report goes to your reducer — the agent that dispatched your item.`,
          protocol,
        },
      },
      routeSummary: `main → ${reducer.name} → mappers → ${reducer.name} → main`,
      limits: { minAgents: 1, maxAgents: 1 },
      config: { reducerAgent: reducer.name, maxMappers: config.maxMappers },
    },
    agents: agentPlans([reducer], () => "reducer", 0),
  };
}

// ── debate ─────────────────────────────────────────────────────────────────

/** The console-seated arbiter's reserved name in a debate. */
const ARBITER_NAME = "judge";

const DEBATE_CONFIG = z.object({
  judgeProfileId: z.string().default("reviewer"),
  judgeModel: z.string().optional(),
  rubric: z.string().max(4_000).optional(),
});

const DEBATE_WORK_BULLET = `
- You are in a debate: every debater received the SAME briefing and argues its
  own independent position to the judge in exactly ONE turn — one blind round,
  no rebuttal, and the other positions stay unseen. Make your position complete
  and self-contained this turn; the Console holds every position until all
  have argued, then the judge reads them together. Independent disagreement
  is the signal the judge needs.`;

function buildDebate(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 8) throw new InvalidInputError("a debate seats 2 to 8 debaters (the judge is seated by the console)");
  if (input.agents.some((agent) => agent.name === ARBITER_NAME)) throw new InvalidInputError(`"${ARBITER_NAME}" is the console-seated arbiter's name; pick another agent name`);
  const config = DEBATE_CONFIG.parse(input.config ?? {});
  const protocol = `${PROTOCOL_INTRO}${DEBATE_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  const rubric = config.rubric === undefined ? "" : `\n\nJudge against this rubric:\n${config.rubric}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "debate",
      roles: {
        debater: { replicable: false, min: 2, max: 8, grants: [], escalateTo: "judge" },
        judge: { replicable: false, min: 1, max: 1, grants: ["forward_message", "tasks_write"], extensionKind: "review", escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "debater", advance: "immediate" },
        { from: "main", to: "judge", advance: "immediate", categories: ["update"] },
        { from: "debater", to: "judge", advance: "join", categories: ["update", "milestone", "failure", "decision"] },
        { from: "judge", to: "main", advance: "immediate", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [{ id: "positions", over: "debater", deliverTo: "judge" }],
      entry: { role: "debater", broadcast: true },
      termination: {},
      completion: { finalFrom: "judge", voice: "judge" },
      promptPack: {
        debater: {
          addressing: `Address participants by bare name. Send your finished position to "judge".`,
          protocol,
        },
        judge: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator.`,
          protocol,
          brief: `You are the JUDGE. Every debater's position arrives in one turn once all have argued. Weigh them on substance — evidence over length, correctness over agreement. Report the winning answer (or your synthesis of the strongest parts) to "main", naming what each position got right or wrong.${rubric}`,
        },
      },
      routeSummary: `main → debaters → judge → main`,
      limits: { minAgents: 2, maxAgents: 8 },
      config: { debaters: input.agents.map((agent) => agent.name), judgeProfileId: config.judgeProfileId, ...(config.rubric === undefined ? {} : { rubric: config.rubric }) },
    },
    agents: [
      ...agentPlans(input.agents, () => "debater", 0),
      { name: ARBITER_NAME, role: ARBITER_NAME, profileId: config.judgeProfileId,
        ...(config.judgeModel !== undefined ? { model: config.judgeModel } : {}), owns: [], ord: input.agents.length },
    ],
  };
}

// ── peer_to_peer ───────────────────────────────────────────────────────────

const P2P_CONFIG = z.object({
  closerAgent: z.string().optional(),
  maxHandoffs: z.number().int().min(4).max(60).default(12),
  oscillationWindow: z.number().int().min(2).max(8).default(3),
});

const P2P_WORK_BULLET = `
- You are a peer in a bounded mesh: any agent may hand work to any other, and
  nobody sequences you. The Console caps total handoffs and stops ping-pong,
  so every send should MOVE the work. The closer owns the ending: keep it able
  to compile the result, and tell it when your part is done — an idle peer is
  a finished peer.`;

function buildPeerToPeer(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 8) throw new InvalidInputError("peer_to_peer seats 2 to 8 peers");
  const config = P2P_CONFIG.parse(input.config ?? {});
  const closer = config.closerAgent === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.closerAgent)
      ?? (() => { throw new InvalidInputError(`closerAgent "${config.closerAgent}" is not one of the agents`); })();
  const peers = input.agents.filter((agent) => agent.name !== closer.name);
  const protocol = `${PROTOCOL_INTRO}${P2P_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  const addressing = `Address participants by bare name; "main" reaches the Orchestrator (closer only).`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "peer_to_peer",
      roles: {
        peer: { replicable: false, min: 1, max: 7, grants: [], escalateTo: "closer" },
        closer: { replicable: false, min: 1, max: 1, grants: ["forward_message", "tasks_write"], escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "closer", advance: "immediate" },
        { from: "main", to: "peer", advance: "immediate", categories: ["update"] },
        { from: "peer", to: "peer", advance: "immediate" },
        { from: "peer", to: "closer", advance: "immediate" },
        { from: "closer", to: "peer", advance: "immediate" },
        { from: "closer", to: "main", advance: "immediate", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [],
      entry: { role: "closer", broadcast: false },
      termination: { maxHandoffs: config.maxHandoffs, oscillationWindow: config.oscillationWindow },
      completion: { finalFrom: "closer", voice: "closer" },
      promptPack: {
        peer: { addressing, protocol },
        closer: {
          addressing,
          protocol,
          brief: `You are the CLOSER: a working peer that also owns the ending. Distribute the briefing, contribute like any peer, and when the work converges — or the Console says the budget tripped — compile the combined result and report it to "main".`,
        },
      },
      routeSummary: `peers ⇄ peers, ${closer.name} → main`,
      limits: { minAgents: 2, maxAgents: 8 },
      config: { closerAgent: closer.name, maxHandoffs: config.maxHandoffs, oscillationWindow: config.oscillationWindow },
    },
    agents: [
      ...agentPlans([closer], () => "closer", 0),
      ...agentPlans(peers, () => "peer", 1),
    ],
  };
}

// ── plan_execute ───────────────────────────────────────────────────────────

const PLAN_EXECUTE_CONFIG = z.object({
  plannerAgent: z.string().optional(),
});

const PLAN_WORK_BULLET = `
- You are in a plan-and-execute session: the planner decomposes the objective
  into ledger tasks (dependencies as blockedBy at task_create) and assigns
  every task by taskId immediately; the Console dispatches on the DAG, holding
  an assignment whose dependencies are incomplete ({scheduled: true}) until
  they complete. Keep the ledger true as reality diverges.`;

function buildPlanExecute(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 20) throw new InvalidInputError("plan_execute seats a planner plus 1-19 executors");
  const config = PLAN_EXECUTE_CONFIG.parse(input.config ?? {});
  const planner = config.plannerAgent === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.plannerAgent)
      ?? (() => { throw new InvalidInputError(`plannerAgent "${config.plannerAgent}" is not one of the agents`); })();
  const executors = input.agents.filter((agent) => agent.name !== planner.name);
  const protocol = `${PROTOCOL_INTRO}${PLAN_WORK_BULLET}${OPERATOR_PATH_BULLETS}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "plan_execute",
      roles: {
        planner: { replicable: false, min: 1, max: 1, grants: ["tasks_write", "forward_message", "child_sessions", "requirements_report"], extensionKind: "coordination", escalateTo: "main" },
        executor: { replicable: false, min: 1, max: 19, grants: [], escalateTo: "planner" },
      },
      edges: [
        { from: "main", to: "planner", advance: "immediate" },
        { from: "main", to: "executor", advance: "immediate", categories: ["update"] },
        { from: "planner", to: "main", advance: "immediate" },
        { from: "planner", to: "executor", advance: "immediate" },
        { from: "executor", to: "planner", advance: "immediate" },
      ],
      joins: [],
      entry: { role: "planner", broadcast: false },
      termination: {},
      completion: { finalFrom: "planner", voice: "planner" },
      promptPack: {
        planner: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator.`,
          protocol,
          brief: `You are the PLANNER. First decompose the objective into task_create entries — every unit gets a taskId, an owner, and blockedBy naming its real dependencies (forward references are fine) — then assign EVERY task by taskId immediately with send_handoff category "assignment". When reality diverges, re-plan by updating the ledger. When the DAG is done (or provably stuck), report the result to "main".`,
        },
        executor: {
          addressing: `Address participants by bare name. Your reports go to your planner.`,
          protocol,
        },
      },
      routeSummary: `main ↔ ${planner.name} ↔ executors`,
      limits: { minAgents: 2, maxAgents: 20 },
      config: { plannerAgent: planner.name, executors: executors.map((agent) => agent.name) },
    },
    agents: [
      ...agentPlans([planner], () => "planner", 0),
      ...agentPlans(executors, () => "executor", 1),
    ],
  };
}
