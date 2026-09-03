import type { PlanLimits } from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { AgentDefinitionStore } from "./agents.ts";
import { AllocationExtensionStore } from "./allocation-extensions.ts";
import { ApprovedToolCallUseStore } from "./approved-tool-call-uses.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BudgetIncreaseStore } from "./budget-increases.ts";
import { BudgetReservationStore } from "./budgets.ts";
import { CapacityLeaseStore } from "./capacity.ts";
import { CompletionRequestStore } from "./completion-requests.ts";
import { ProviderContinuationStore } from "./continuations.ts";
import { ConversationStore } from "./conversations.ts";
import { DecisionStore } from "./decisions.ts";
import { HandoffStore } from "./handoffs.ts";
import { InvocationStore } from "./invocations.ts";
import { OrchestratorInputStore } from "./orchestrator-inputs.ts";
import { ExecutionPlanStore } from "./plans.ts";
import { PublicationStore } from "./publications.ts";
import { RequirementProposalStore } from "./requirement-proposals.ts";
import { RequirementStore } from "./requirements.ts";
import { RunStore } from "./runs.ts";
import { RuntimeToolCallStore } from "./runtime-tool-calls.ts";
import { SignoffResolutionStore } from "./signoff-resolutions.ts";
import { TaskStore } from "./tasks.ts";
import { UsageStore } from "./usage.ts";
import { EvaluationStore, GateStore } from "./verification.ts";
import { ChangesetStore, SnapshotStore } from "./workspace-state.ts";
import { WorkspaceStore } from "./workspaces.ts";

export interface Stores {
  workspaces: WorkspaceStore;
  conversations: ConversationStore;
  runs: RunStore;
  plans: ExecutionPlanStore;
  requirements: RequirementStore;
  /** The Orchestrator's Requirement proposals awaiting or resolved by the operator (execution-model §8.1). */
  requirementProposals: RequirementProposalStore;
  decisions: DecisionStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  handoffs: HandoffStore;
  agents: AgentDefinitionStore;
  invocations: InvocationStore;
  approvedToolCallUses: ApprovedToolCallUseStore;
  runtimeToolCalls: RuntimeToolCallStore;
  /** The queued typed inputs of the Orchestrator's next logical turn (execution-model §4.6). */
  orchestratorInputs: OrchestratorInputStore;
  continuations: ProviderContinuationStore;
  evaluations: EvaluationStore;
  gates: GateStore;
  completionRequests: CompletionRequestStore;
  signoffResolutions: SignoffResolutionStore;
  snapshots: SnapshotStore;
  changesets: ChangesetStore;
  publications: PublicationStore;
  leases: CapacityLeaseStore;
  reservations: BudgetReservationStore;
  /** The append-only operator-approved Budget Increases (execution-model §7.6). */
  budgetIncreases: BudgetIncreaseStore;
  /** The append-only deterministic Allocation Extensions (execution-model §7.6). */
  allocationExtensions: AllocationExtensionStore;
  usage: UsageStore;
}

/** Wires every store over one context; stores that compose others receive them here. */
export function createStores(ctx: PersistenceContext, options: { planLimits?: PlanLimits } = {}): Stores {
  const usage = new UsageStore(ctx);
  const budgetIncreases = new BudgetIncreaseStore(ctx);
  // An extension is checked against the Run's effective ordinary availability, which the reservation store derives; the
  // reservation store in turn reads the extensions to charge effective reserved allocations. The closure resolves the cycle.
  let reservations!: BudgetReservationStore;
  const allocationExtensions = new AllocationExtensionStore(ctx, { ordinaryAvailable: (runId) => reservations.runCapacity(runId).ordinary.effectiveAvailable });
  reservations = new BudgetReservationStore(ctx, usage, budgetIncreases, allocationExtensions);
  const conversations = new ConversationStore(ctx);
  const plans = new ExecutionPlanStore(ctx, reservations, usage, options.planLimits);
  return {
    workspaces: new WorkspaceStore(ctx),
    conversations,
    runs: new RunStore(ctx, conversations),
    plans,
    requirements: new RequirementStore(ctx),
    requirementProposals: new RequirementProposalStore(ctx),
    decisions: new DecisionStore(ctx),
    tasks: new TaskStore(ctx, plans),
    artifacts: new ArtifactStore(ctx),
    handoffs: new HandoffStore(ctx),
    agents: new AgentDefinitionStore(ctx),
    invocations: new InvocationStore(ctx, reservations, usage),
    approvedToolCallUses: new ApprovedToolCallUseStore(ctx),
    runtimeToolCalls: new RuntimeToolCallStore(ctx),
    orchestratorInputs: new OrchestratorInputStore(ctx),
    continuations: new ProviderContinuationStore(ctx),
    evaluations: new EvaluationStore(ctx),
    gates: new GateStore(ctx),
    completionRequests: new CompletionRequestStore(ctx),
    signoffResolutions: new SignoffResolutionStore(ctx),
    snapshots: new SnapshotStore(ctx),
    changesets: new ChangesetStore(ctx),
    publications: new PublicationStore(ctx),
    leases: new CapacityLeaseStore(ctx),
    reservations,
    budgetIncreases,
    allocationExtensions,
    usage,
  };
}

export {
  AgentDefinitionStore,
  AllocationExtensionStore,
  ApprovedToolCallUseStore,
  ArtifactStore,
  BudgetIncreaseStore,
  BudgetReservationStore,
  CapacityLeaseStore,
  ChangesetStore,
  CompletionRequestStore,
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
  RuntimeToolCallStore,
  SignoffResolutionStore,
  SnapshotStore,
  TaskStore,
  UsageStore,
  WorkspaceStore,
};
