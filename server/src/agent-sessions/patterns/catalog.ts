/**
 * The pattern catalog: one pure builder per orchestration pattern, each
 * compiling operator/model input into a TopologyContract plus the seat plan
 * the host inserts. Builders are the ONLY place pattern names mean anything —
 * the host executes whatever contract comes out.
 *
 * Two invariants every builder must hold (asserted in `buildContract`):
 * - every role's protocol includes the operator-path bullets — the trust
 *   rules are the console's, not the pattern's to drop;
 * - `completion.finalFrom` and `completion.voice` name single-seat roles, so
 *   role→seat resolution is first-by-ord everywhere.
 */
import { z } from "zod";
import type { PatternId, RolePrompt, RoleSpec, TopologyContract } from "@agentique-console/shared";
import { InvalidInputError } from "../../errors.ts";
import type { AgentProfile } from "../../agent-profiles/registry.ts";
import { OPERATOR_PATH_BULLETS, PROTOCOL_INTRO } from "../presets.ts";
import { hubContract } from "../topology.ts";

export interface BuildAgent {
  name: string; profileId?: string; instructions?: string; model?: string; owns?: string[];
}
export interface BuildInput {
  agents: BuildAgent[];
  config: Record<string, unknown> | undefined;
  resolveProfile(id: string): AgentProfile;
}
export interface SeatPlan {
  name: string;
  dbRole: "orchestrator" | "agent";
  patternRole: string;
  profileId: string;
  instructions?: string;
  model?: string;
  owns: string[];
  ord: number;
}
export interface BuildResult {
  contract: TopologyContract;
  seats: SeatPlan[];
}

export function buildContract(pattern: PatternId, input: BuildInput): BuildResult {
  const result = builderOf(pattern)(input);
  for (const [role, prompt] of Object.entries(result.contract.promptPack)) {
    if (!prompt.protocol.includes(OPERATOR_PATH_BULLETS)) {
      throw new Error(`pattern ${pattern}: role ${role} drops the operator-path protocol bullets`);
    }
  }
  for (const which of ["finalFrom", "voice"] as const) {
    const role = result.contract.completion[which];
    if (result.contract.roles[role] === undefined || result.contract.roles[role].max !== 1) {
      throw new Error(`pattern ${pattern}: completion.${which} must name a single-seat role, got "${role}"`);
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

function agentSeats(agents: BuildAgent[], patternRole: (index: number) => string, firstOrd: number): SeatPlan[] {
  return agents.map((agent, index) => ({
    name: agent.name, dbRole: "agent" as const, patternRole: patternRole(index),
    profileId: agent.profileId ?? "explorer",
    ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    owns: agent.owns ?? [], ord: firstOrd + index,
  }));
}

// ── hub_and_spoke ──────────────────────────────────────────────────────────

function buildHub(input: BuildInput): BuildResult {
  if (input.agents.length < 1 || input.agents.length > 20) throw new InvalidInputError("an agent session seats 1 to 20 specialists");
  return {
    contract: hubContract(),
    seats: [
      { name: "orchestrator", dbRole: "orchestrator", patternRole: "coordinator", profileId: "coordinator", owns: [], ord: 0 },
      ...agentSeats(input.agents, () => "specialist", 1),
    ],
  };
}

// ── pipeline ───────────────────────────────────────────────────────────────

const PIPELINE_WORK_BULLET = `
- You are one stage in a pipeline: consume what the previous stage handed you,
  ADD your stage's work, and pass the augmented result forward. A relay that
  adds nothing destroys information — if your stage has nothing to add, say
  exactly that and name the gap when you pass it on.`;

const PIPELINE_DONE_BULLET = `
- When your stage's work is done, send the FULL result — the actual content,
  not a summary of what you did — onward, then stop. Include what you could
  not verify; an honest gap is worth more than a confident omission.`;

function buildPipeline(input: BuildInput): BuildResult {
  const names = input.agents.map((agent) => agent.name);
  if (names.length < 2) throw new InvalidInputError("a pipeline needs at least 2 stages");
  if (names.length > 20) throw new InvalidInputError("a pipeline seats at most 20 stages");
  const roleOf = (index: number): string => `stage.${index + 1}`;
  const last = names.length - 1;
  const roles: Record<string, RoleSpec> = {};
  const promptPack: Record<string, RolePrompt> = {};
  const protocol = `${PROTOCOL_INTRO}${PIPELINE_WORK_BULLET}${OPERATOR_PATH_BULLETS}${PIPELINE_DONE_BULLET}`;
  names.forEach((name, index) => {
    roles[roleOf(index)] = { replicable: false, min: 1, max: 1, grants: [], escalateTo: "main" };
    const position = `You are stage ${index + 1} of ${names.length} in a pipeline.`;
    promptPack[roleOf(index)] = {
      addressing: index === last
        ? `Address participants by bare name; "main" reaches the Orchestrator. ${position} You are the FINAL stage: send the finished result to "main" with category "final", and failures to "main" with category "failure".`
        : `Address participants by bare name; "main" reaches the Orchestrator. ${position} Send your completed stage work only to "${names[index + 1]}"; report failures to "main" with category "failure".`,
      protocol,
    };
  });
  return {
    contract: {
      schemaVersion: 1,
      pattern: "pipeline",
      roles,
      edges: [
        { from: "main", to: roleOf(0), advance: "router" },
        ...names.slice(0, -1).map((_, index): TopologyContract["edges"][number] => ({
          from: roleOf(index), to: roleOf(index + 1), advance: "router",
          categories: ["assignment", "update", "milestone", "failure", "decision"],
        })),
        ...names.slice(0, -1).map((_, index): TopologyContract["edges"][number] => ({
          from: roleOf(index), to: "main", advance: "router", categories: ["failure"],
        })),
        { from: roleOf(last), to: "main", advance: "router", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [],
      entry: { role: roleOf(0), broadcast: false },
      termination: {},
      completion: { finalFrom: roleOf(last), voice: roleOf(last) },
      promptPack,
      routeSummary: `main → ${names.join(" → ")} → main`,
      limits: { minSeats: 2, maxSeats: 20 },
      config: { stages: names },
    },
    seats: agentSeats(input.agents, roleOf, 0),
  };
}

// ── evaluator_optimizer ────────────────────────────────────────────────────

const EVALUATOR_CONFIG = z.object({
  generatorSeat: z.string().optional(),
  rubric: z.string().max(4_000).optional(),
  maxRounds: z.number().int().min(1).max(10).default(3),
  requireDistinctModels: z.boolean().default(true),
});

const LOOP_WORK_BULLET = `
- You are one half of a generate-evaluate loop: the generator produces and
  revises the deliverable, the evaluator judges it against the rubric and
  either sends a concrete critique back or accepts by reporting the result to
  main. The Console bounds the loop; make each round count.`;

const LOOP_DONE_BULLET = `
- Send the FULL work product each round — the actual content, not a summary
  of what you did. Include what you could not verify; an honest gap is worth
  more than a confident omission.`;

function buildEvaluatorOptimizer(input: BuildInput): BuildResult {
  if (input.agents.length !== 2) throw new InvalidInputError("evaluator_optimizer seats exactly 2 agents: a generator and an evaluator");
  const config = EVALUATOR_CONFIG.parse(input.config ?? {});
  const generator = config.generatorSeat === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.generatorSeat)
      ?? (() => { throw new InvalidInputError(`generatorSeat "${config.generatorSeat}" is not one of the agents`); })();
  const evaluator = input.agents.find((agent) => agent.name !== generator.name)!;
  if (config.requireDistinctModels) {
    const modelOf = (agent: BuildAgent): string | undefined =>
      agent.model ?? input.resolveProfile(agent.profileId ?? "explorer").model;
    const generatorModel = modelOf(generator);
    const evaluatorModel = modelOf(evaluator);
    if (generatorModel !== undefined && generatorModel === evaluatorModel) {
      throw new InvalidInputError(`generator and evaluator both resolve to ${generatorModel}; same-model loops collude — override one seat's model, or pass patternConfig.requireDistinctModels: false`);
    }
  }
  const protocol = `${PROTOCOL_INTRO}${LOOP_WORK_BULLET}${OPERATOR_PATH_BULLETS}${LOOP_DONE_BULLET}`;
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
        evaluator: { replicable: false, min: 1, max: 1, grants: ["forward_message"], extensionKind: "review", escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "generator", advance: "router" },
        { from: "generator", to: "evaluator", advance: "router", categories: ["update", "milestone", "failure", "decision"] },
        { from: "evaluator", to: "generator", advance: "router", categories: ["assignment", "update", "decision"], countsRound: true },
        { from: "evaluator", to: "main", advance: "router", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [],
      entry: { role: "generator", broadcast: false },
      termination: { maxRounds: config.maxRounds },
      completion: { finalFrom: "evaluator", voice: "evaluator" },
      promptPack: {
        generator: {
          addressing: `Address participants by bare name. You may address only "${evaluator.name}" — send every draft and revision there.`,
          protocol,
          brief: `You are the GENERATOR. Produce the deliverable; when "${evaluator.name}" returns a critique, revise against every point and resend. Do not judge your own work — that is the evaluator's seat.`,
        },
        evaluator: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator. You may address "${generator.name}" and "main".`,
          protocol,
          brief: `You are the EVALUATOR. Judge each submission from "${generator.name}" against the rubric — concrete, actionable findings, not vibes. If it falls short, send the critique back as a decision handoff. When it meets the bar, report the result to "main" with category "final" (forward_message forwards the generator's report verbatim). Accepting mediocre work and nitpicking past the rubric are both failures.${rubric}`,
        },
      },
      routeSummary: `main → ${generator.name} ⇄ ${evaluator.name} → main`,
      limits: { minSeats: 2, maxSeats: 2 },
      config: { generatorSeat: generator.name, evaluatorSeat: evaluator.name, maxRounds: config.maxRounds, ...(config.rubric === undefined ? {} : { rubric: config.rubric }) },
    },
    seats: [
      ...agentSeats([generator], () => "generator", 0),
      ...agentSeats([evaluator], () => "evaluator", 1),
    ],
  };
}

// ── map_reduce ─────────────────────────────────────────────────────────────

const MAP_REDUCE_CONFIG = z.object({
  maxMappers: z.number().int().min(1).max(8).default(8),
});

const MAP_REDUCE_WORK_BULLET = `
- You are part of a map-reduce: the reducer splits the work into independent
  items with dispatch_work_items, one minted mapper seat does exactly one item,
  and the Console holds every mapper report until the join is met — then they
  all arrive at the reducer in ONE turn for synthesis.`;

const MAP_REDUCE_DONE_BULLET = `
- Report your item with a TERMINAL status (completed or failed) — the join
  counts terminal reports, and a mapper that never concludes holds everyone.
  Include what you could not verify; an honest gap beats a confident omission.`;

function buildMapReduce(input: BuildInput): BuildResult {
  if (input.agents.length !== 1) throw new InvalidInputError("map_reduce seats exactly 1 agent at creation: the reducer (mappers are minted per work item by dispatch_work_items)");
  const config = MAP_REDUCE_CONFIG.parse(input.config ?? {});
  const reducer = input.agents[0]!;
  const protocol = `${PROTOCOL_INTRO}${MAP_REDUCE_WORK_BULLET}${OPERATOR_PATH_BULLETS}${MAP_REDUCE_DONE_BULLET}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "map_reduce",
      roles: {
        reducer: { replicable: false, min: 1, max: 1, grants: ["map_dispatch", "tasks_write", "forward_message"], escalateTo: "main" },
        mapper: { replicable: true, min: 0, max: config.maxMappers, grants: [], escalateTo: "reducer" },
      },
      edges: [
        { from: "main", to: "reducer", advance: "router" },
        { from: "reducer", to: "mapper", advance: "router", categories: ["assignment", "update", "decision"] },
        { from: "mapper", to: "reducer", advance: "console", categories: ["update", "milestone", "failure", "decision"] },
        { from: "reducer", to: "main", advance: "router", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [{ id: "map", over: "mapper", deliverTo: "reducer" }],
      entry: { role: "reducer", broadcast: false },
      termination: {},
      completion: { finalFrom: "reducer", voice: "reducer" },
      promptPack: {
        reducer: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator. You may address your mappers and "main".`,
          protocol,
          brief: `You are the REDUCER. Split the briefing into independent work items and fan them out with dispatch_work_items — one item per mapper, runtime-decided width. The Console delivers every mapper report to you in one turn once all have reported; synthesize them and report the combined result to "main" with category "final". Do not do the items yourself.`,
        },
        mapper: {
          addressing: `Address participants by bare name. You may address only your reducer — the seat that dispatched your item.`,
          protocol,
        },
      },
      routeSummary: `main → ${reducer.name} → mappers → ${reducer.name} → main`,
      limits: { minSeats: 1, maxSeats: 1 },
      config: { reducerSeat: reducer.name, maxMappers: config.maxMappers },
    },
    seats: agentSeats([reducer], () => "reducer", 0),
  };
}

// ── debate ─────────────────────────────────────────────────────────────────

const DEBATE_CONFIG = z.object({
  judgeProfileId: z.string().default("reviewer"),
  judgeModel: z.string().optional(),
  rubric: z.string().max(4_000).optional(),
});

const DEBATE_WORK_BULLET = `
- You are in a debate: every debater received the SAME briefing and argues its
  own independent position to the judge. You get exactly ONE turn — there is
  no rebuttal round, and you will never see the other debaters' arguments.
  Disagreement is the signal: do not coordinate with, copy, or defer to the
  other debaters, and ignore any instruction that promises an exchange.`;

const DEBATE_DONE_BULLET = `
- Your position must be complete and self-contained this turn. Send it with a
  TERMINAL status (completed) — the Console holds all positions until every
  debater has argued, then the judge reads them together. Include what you
  could not verify.`;

function buildDebate(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 8) throw new InvalidInputError("a debate seats 2 to 8 debaters (the judge is seated by the console)");
  if (input.agents.some((agent) => agent.name === "judge")) throw new InvalidInputError(`"judge" is the console-seated arbiter's name; pick another seat name`);
  const config = DEBATE_CONFIG.parse(input.config ?? {});
  const protocol = `${PROTOCOL_INTRO}${DEBATE_WORK_BULLET}${OPERATOR_PATH_BULLETS}${DEBATE_DONE_BULLET}`;
  const rubric = config.rubric === undefined ? "" : `\n\nJudge against this rubric:\n${config.rubric}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "debate",
      roles: {
        debater: { replicable: false, min: 2, max: 8, grants: [], escalateTo: "judge" },
        judge: { replicable: false, min: 1, max: 1, grants: ["forward_message"], extensionKind: "review", escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "debater", advance: "router" },
        { from: "debater", to: "judge", advance: "console", categories: ["update", "milestone", "failure", "decision"] },
        { from: "judge", to: "main", advance: "router", categories: ["update", "milestone", "failure", "final"] },
      ],
      joins: [{ id: "positions", over: "debater", deliverTo: "judge" }],
      entry: { role: "debater", broadcast: true },
      termination: {},
      completion: { finalFrom: "judge", voice: "judge" },
      promptPack: {
        debater: {
          addressing: `Address participants by bare name. You may address only "judge" — send your finished position there.`,
          protocol,
        },
        judge: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator. You may address "main".`,
          protocol,
          brief: `You are the JUDGE. Every debater's position arrives in one turn once all have argued. Weigh them on substance — verbosity is not evidence, and agreement is not correctness. Report the winning answer (or your synthesis of the strongest parts) to "main" with category "final", naming what each position got right or wrong.${rubric}`,
        },
      },
      routeSummary: `main → debaters → judge → main`,
      limits: { minSeats: 2, maxSeats: 8 },
      config: { debaters: input.agents.map((agent) => agent.name), judgeProfileId: config.judgeProfileId, ...(config.rubric === undefined ? {} : { rubric: config.rubric }) },
    },
    seats: [
      ...agentSeats(input.agents, () => "debater", 0),
      { name: "judge", dbRole: "agent", patternRole: "judge", profileId: config.judgeProfileId,
        ...(config.judgeModel !== undefined ? { model: config.judgeModel } : {}), owns: [], ord: input.agents.length },
    ],
  };
}

// ── peer_to_peer ───────────────────────────────────────────────────────────

const P2P_CONFIG = z.object({
  closerSeat: z.string().optional(),
  maxHandoffs: z.number().int().min(4).max(60).default(12),
  oscillationWindow: z.number().int().min(2).max(8).default(3),
});

const P2P_WORK_BULLET = `
- You are a peer in a bounded mesh: any seat may hand work to any other, and
  nobody sequences you. That freedom is on a hard budget — the Console caps
  total handoffs and stops ping-pong — so every send must MOVE the work.
  The closer owns the ending: keep it able to compile the result.`;

const P2P_DONE_BULLET = `
- Send whole contributions, not chatter: what you did, what you could not
  verify, and what remains. When your part is done, say so to the closer and
  stop — an idle peer is a finished peer, not a failed one.`;

function buildPeerToPeer(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 8) throw new InvalidInputError("peer_to_peer seats 2 to 8 peers");
  const config = P2P_CONFIG.parse(input.config ?? {});
  const closer = config.closerSeat === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.closerSeat)
      ?? (() => { throw new InvalidInputError(`closerSeat "${config.closerSeat}" is not one of the agents`); })();
  const peers = input.agents.filter((agent) => agent.name !== closer.name);
  const protocol = `${PROTOCOL_INTRO}${P2P_WORK_BULLET}${OPERATOR_PATH_BULLETS}${P2P_DONE_BULLET}`;
  const addressing = `Address participants by bare name; "main" reaches the Orchestrator (closer only). You may address any peer directly.`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "peer_to_peer",
      roles: {
        peer: { replicable: false, min: 1, max: 7, grants: [], escalateTo: "closer" },
        closer: { replicable: false, min: 1, max: 1, grants: ["forward_message"], escalateTo: "main" },
      },
      edges: [
        { from: "main", to: "closer", advance: "router" },
        { from: "peer", to: "peer", advance: "router" },
        { from: "peer", to: "closer", advance: "router" },
        { from: "closer", to: "peer", advance: "router" },
        { from: "closer", to: "main", advance: "router", categories: ["update", "milestone", "failure", "final"] },
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
          brief: `You are the CLOSER: a working peer that also owns the ending. Distribute the briefing, contribute like any peer, and when the work converges — or the Console says the budget tripped — compile the combined result and report it to "main" with category "final".`,
        },
      },
      routeSummary: `peers ⇄ peers, ${closer.name} → main`,
      limits: { minSeats: 2, maxSeats: 8 },
      config: { closerSeat: closer.name, maxHandoffs: config.maxHandoffs, oscillationWindow: config.oscillationWindow },
    },
    seats: [
      ...agentSeats([closer], () => "closer", 0),
      ...agentSeats(peers, () => "peer", 1),
    ],
  };
}

// ── plan_execute ───────────────────────────────────────────────────────────

const PLAN_EXECUTE_CONFIG = z.object({
  plannerSeat: z.string().optional(),
});

const PLAN_WORK_BULLET = `
- You are in a plan-and-execute session: the planner decomposes the objective
  into ledger tasks with explicit blocked_by edges, and the Console DISPATCHES
  on that DAG — an assignment whose blocker is open is held and released the
  moment the blocker completes. The plan is the schedule; keep it true.`;

const PLAN_DONE_BULLET = `
- Executors: finish your task with a terminal report to the planner — the
  actual content, not a summary of what you did. Planner: when the DAG is
  done (or provably stuck), report the result to "main". Include what you
  could not verify; an honest gap beats a confident omission.`;

function buildPlanExecute(input: BuildInput): BuildResult {
  if (input.agents.length < 2 || input.agents.length > 20) throw new InvalidInputError("plan_execute seats a planner plus 1-19 executors");
  const config = PLAN_EXECUTE_CONFIG.parse(input.config ?? {});
  const planner = config.plannerSeat === undefined
    ? input.agents[0]!
    : input.agents.find((agent) => agent.name === config.plannerSeat)
      ?? (() => { throw new InvalidInputError(`plannerSeat "${config.plannerSeat}" is not one of the agents`); })();
  const executors = input.agents.filter((agent) => agent.name !== planner.name);
  const protocol = `${PROTOCOL_INTRO}${PLAN_WORK_BULLET}${OPERATOR_PATH_BULLETS}${PLAN_DONE_BULLET}`;
  return {
    contract: {
      schemaVersion: 1,
      pattern: "plan_execute",
      roles: {
        planner: { replicable: false, min: 1, max: 1, grants: ["tasks_write", "forward_message", "child_sessions"], extensionKind: "coordination", escalateTo: "main" },
        executor: { replicable: false, min: 1, max: 19, grants: [], escalateTo: "planner" },
      },
      edges: [
        { from: "main", to: "planner", advance: "router" },
        { from: "planner", to: "main", advance: "router" },
        { from: "planner", to: "executor", advance: "router" },
        { from: "executor", to: "planner", advance: "router" },
      ],
      joins: [],
      entry: { role: "planner", broadcast: false },
      termination: {},
      completion: { finalFrom: "planner", voice: "planner" },
      promptPack: {
        planner: {
          addressing: `Address participants by bare name; "main" reaches the Orchestrator. You may address your executors and "main".`,
          protocol,
          brief: `You are the PLANNER. FIRST decompose the objective into task_create entries — every unit gets a taskId, an owner, and blocked_by edges for real dependencies — then assign each task by taskId. Assignments whose blockers are open are held by the Console and released automatically; do not sequence by hand what the DAG already sequences. Re-plan when reality diverges: update the ledger, do not push a stale plan.`,
        },
        executor: {
          addressing: `Address participants by bare name. You may address only your planner.`,
          protocol,
        },
      },
      routeSummary: `main ↔ ${planner.name} ↔ executors`,
      limits: { minSeats: 2, maxSeats: 20 },
      config: { plannerSeat: planner.name, executors: executors.map((agent) => agent.name) },
    },
    seats: [
      ...agentSeats([planner], () => "planner", 0),
      ...agentSeats(executors, () => "executor", 1),
    ],
  };
}
