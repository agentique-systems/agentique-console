import { BotIcon, GaugeIcon, ListChecksIcon, ListIcon, MessageCircleQuestionMarkIcon, RocketIcon, ShieldCheckIcon, WalletIcon, WorkflowIcon, type LucideIcon } from "lucide-react";
import type { RunOverview } from "@agentique-console/core";

export const RUN_TABS = ["overview", "requirements", "plan", "tasks", "decisions", "verification", "publish", "usage", "agents"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export interface RunSection {
  id: RunTab;
  label: string;
  Icon: LucideIcon;
  description: string;
  /** How many things in the section need the operator now. */
  needsOperator: (overview: RunOverview) => number;
}

/** The sections of a Run, in the order the work flows: agree what, plan how, do it, prove it, sign it off, ship it. */
export const RUN_SECTIONS: readonly RunSection[] = [
  { id: "overview", label: "Overview", Icon: GaugeIcon, description: "What is happening and what needs you", needsOperator: () => 0 },
  { id: "requirements", label: "Requirements", Icon: ListChecksIcon, description: "What the Run must achieve, and the Orchestrator's proposals", needsOperator: (o) => (o.openProposal !== null ? 1 : 0) },
  { id: "plan", label: "Plan", Icon: WorkflowIcon, description: "The execution graph, its nodes, Invocations and Attempts", needsOperator: () => 0 },
  { id: "tasks", label: "Tasks", Icon: ListIcon, description: "The bounded units of work and their evidence", needsOperator: () => 0 },
  { id: "decisions", label: "Decisions", Icon: MessageCircleQuestionMarkIcon, description: "Questions the Run asked; the open ones block work", needsOperator: (o) => o.openDecisions.length },
  { id: "verification", label: "Verification", Icon: ShieldCheckIcon, description: "Gates, Evaluations, Changesets, and the final report", needsOperator: () => 0 },
  { id: "publish", label: "Signoff & publish", Icon: RocketIcon, description: "Accept the verified result, then publish it to the Target", needsOperator: (o) => (o.phase === "awaiting_signoff" || o.phase === "completed_unpublished" || o.phase === "publish_failed" || o.publication.openDecisionId !== null ? 1 : 0) },
  { id: "usage", label: "Budget & usage", Icon: WalletIcon, description: "What the Run may spend and what it has spent", needsOperator: (o) => (o.phase === "waiting_budget" ? 1 : 0) },
  { id: "agents", label: "Agents", Icon: BotIcon, description: "The Agent Definitions available to this Workspace", needsOperator: () => 0 },
];

export function isRunTab(value: string | undefined): value is RunTab {
  return (RUN_TABS as readonly string[]).includes(value ?? "");
}
