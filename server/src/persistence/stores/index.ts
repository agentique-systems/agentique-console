import type { PlanLimits } from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { AgentDefinitionStore } from "./agents.ts";
import { ApprovedToolCallUseStore } from "./approved-tool-call-uses.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BudgetReservationStore } from "./budgets.ts";
import { CapacityLeaseStore } from "./capacity.ts";
import { ProviderContinuationStore } from "./continuations.ts";
import { ConversationStore } from "./conversations.ts";
import { DecisionStore } from "./decisions.ts";
import { HandoffStore } from "./handoffs.ts";
import { InvocationStore } from "./invocations.ts";
import { ExecutionPlanStore } from "./plans.ts";
import { RequirementStore } from "./requirements.ts";
import { RunStore } from "./runs.ts";
import { TaskStore } from "./tasks.ts";
import { UsageStore } from "./usage.ts";
import { EvaluationStore, GateStore } from "./verification.ts";
import { ChangesetStore, PublicationStore, SnapshotStore } from "./workspace-state.ts";
import { WorkspaceStore } from "./workspaces.ts";

export interface Stores {
  workspaces: WorkspaceStore;
  conversations: ConversationStore;
  runs: RunStore;
  plans: ExecutionPlanStore;
  requirements: RequirementStore;
  decisions: DecisionStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  handoffs: HandoffStore;
  agents: AgentDefinitionStore;
  invocations: InvocationStore;
  approvedToolCallUses: ApprovedToolCallUseStore;
  continuations: ProviderContinuationStore;
  evaluations: EvaluationStore;
  gates: GateStore;
  snapshots: SnapshotStore;
  changesets: ChangesetStore;
  publications: PublicationStore;
  leases: CapacityLeaseStore;
  reservations: BudgetReservationStore;
  usage: UsageStore;
}

/** Wires every store over one context; stores that compose others receive them here. */
export function createStores(ctx: PersistenceContext, options: { planLimits?: PlanLimits } = {}): Stores {
  const usage = new UsageStore(ctx);
  const reservations = new BudgetReservationStore(ctx, usage);
  const conversations = new ConversationStore(ctx);
  const plans = new ExecutionPlanStore(ctx, reservations, usage, options.planLimits);
  return {
    workspaces: new WorkspaceStore(ctx),
    conversations,
    runs: new RunStore(ctx, conversations),
    plans,
    requirements: new RequirementStore(ctx),
    decisions: new DecisionStore(ctx),
    tasks: new TaskStore(ctx, plans),
    artifacts: new ArtifactStore(ctx),
    handoffs: new HandoffStore(ctx),
    agents: new AgentDefinitionStore(ctx),
    invocations: new InvocationStore(ctx, reservations, usage),
    approvedToolCallUses: new ApprovedToolCallUseStore(ctx),
    continuations: new ProviderContinuationStore(ctx),
    evaluations: new EvaluationStore(ctx),
    gates: new GateStore(ctx),
    snapshots: new SnapshotStore(ctx),
    changesets: new ChangesetStore(ctx),
    publications: new PublicationStore(ctx),
    leases: new CapacityLeaseStore(ctx),
    reservations,
    usage,
  };
}

export {
  AgentDefinitionStore,
  ApprovedToolCallUseStore,
  ArtifactStore,
  BudgetReservationStore,
  CapacityLeaseStore,
  ChangesetStore,
  ConversationStore,
  DecisionStore,
  EvaluationStore,
  ExecutionPlanStore,
  GateStore,
  HandoffStore,
  InvocationStore,
  ProviderContinuationStore,
  PublicationStore,
  RequirementStore,
  RunStore,
  SnapshotStore,
  TaskStore,
  UsageStore,
  WorkspaceStore,
};
