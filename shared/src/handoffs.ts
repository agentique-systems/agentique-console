/** Canonical, versioned contract for every agent-to-agent context transfer. */
export type HandoffStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "needs_verification"
  | "completed"
  | "failed";

export type HandoffTrigger =
  | "assignment"
  | "update"
  | "milestone"
  | "decision"
  | "failure"
  | "final"
  | "rotation"
  | "recovery";

export type HandoffRisk = "low" | "medium" | "high";
export type HandoffExtensionKind =
  | "generic"
  | "coordination"
  | "implementation"
  | "investigation"
  | "review";

export interface EvidenceRef {
  kind: "file" | "journal" | "artifact" | "task" | "command" | "url";
  ref: string;
  label?: string;
  digest?: string;
}

export interface HandoffCore {
  schemaVersion: 1;
  taskId: string | null;
  status: HandoffStatus;
  risk: HandoffRisk;
  action: string;
  state: { summary: string; evidence: EvidenceRef[] };
  result: { summary: string | null; artifacts: EvidenceRef[] };
  uncertainty: string[];
  nextAction: string | null;
  requestExpandedContext: boolean;
}

export interface CoordinationHandoffData extends Record<string, unknown> {
  decisions?: { decision: string; rationale: string }[];
  tasks?: { taskId: string; status: HandoffStatus; owner: string | null; dependencies: string[] }[];
  conflicts?: string[];
  operatorDecisions?: string[];
  activeSessions?: string[];
}
export interface ImplementationHandoffData extends Record<string, unknown> {
  changedPaths?: string[];
  validations?: { command: string; status: "passed" | "failed" | "not_run"; evidence: EvidenceRef[] }[];
  failedApproaches?: string[];
  rollbackRisk?: string | null;
  frontendEvidence?: EvidenceRef[];
}
export interface InvestigationHandoffData extends Record<string, unknown> {
  findings?: { finding: string; confidence: "low" | "medium" | "high"; evidence: EvidenceRef[] }[];
  conflicts?: string[];
  sources?: EvidenceRef[];
  unanswered?: string[];
}
export interface ReviewHandoffData extends Record<string, unknown> {
  verdict?: "approved" | "needs_changes" | "blocked";
  defects?: { severity: "low" | "medium" | "high" | "critical"; defect: string; evidence: EvidenceRef[] }[];
  coverageGaps?: string[];
  disposition?: string | null;
}

export type HandoffExtension =
  | { kind: "generic"; data: Record<string, unknown> }
  | { kind: "coordination"; data: CoordinationHandoffData }
  | { kind: "implementation"; data: ImplementationHandoffData }
  | { kind: "investigation"; data: InvestigationHandoffData }
  | { kind: "review"; data: ReviewHandoffData };

export interface HandoffDraft {
  core: HandoffCore;
  extension?: HandoffExtension;
}

/** Server-authored identity and lineage, never accepted from an agent. */
export interface HandoffMetadata {
  id: string;
  userSessionId: string;
  agentSessionId: string | null;
  sender: string;
  recipient: string;
  profileId: string | null;
  generation: number;
  turnId: string | null;
  trigger: HandoffTrigger;
  parentHandoffId: string | null;
  rootHandoffId: string;
  checkpoint: boolean;
  bytes: number;
  softTargetBytes: number;
  overflow: boolean;
  referenceWarnings: string[];
  createdAt: string;
}

export interface HandoffRecord {
  metadata: HandoffMetadata;
  core: HandoffCore;
  extension: HandoffExtension;
}

/** Bounded message payload used by transcripts and compact UI cards. */
export interface HandoffSummary {
  id: string;
  trigger: HandoffTrigger;
  status: HandoffStatus;
  risk: HandoffRisk;
  action: string;
  stateSummary: string;
  resultSummary: string | null;
  nextAction: string | null;
  evidenceCount: number;
  artifactCount: number;
  extensionKind: HandoffExtensionKind;
  overflow: boolean;
  referenceWarnings: string[];
}

export interface HandoffPage {
  handoff: HandoffRecord;
  section: "core" | "extension";
  content: string;
  nextCursor: string | null;
}

/**
 * Advisory size targets, per category. The flag was never a truncation, but it
 * shaped behaviour anyway: db-live-2's `page` milestone ran 6901 bytes and
 * `check`'s final 7439 against a 4KiB target, and `renderer` — after two
 * `send_handoff` parse failures — announced "the handoff payload is getting
 * truncated, sending a more compact version" and shipped a shortened report.
 * The ceiling was editing the findings.
 *
 * A report is where the substance lives, so it gets room; an assignment is a
 * request, so it does not need as much.
 */
export const HANDOFF_SOFT_TARGET_BYTES = 6 * 1024;
export const HANDOFF_REPORT_SOFT_TARGET_BYTES = 12 * 1024;
export const HANDOFF_CHECKPOINT_SOFT_TARGET_BYTES = 12 * 1024;

/** Categories whose whole purpose is to carry findings. */
export const REPORT_TRIGGERS: readonly HandoffTrigger[] = ["milestone", "final", "decision", "failure"];
export const HANDOFF_READ_DEFAULT_BYTES = 8 * 1024;
export const HANDOFF_READ_MAX_BYTES = 32 * 1024;

export function handoffExtensionKindForProfile(profileId: string | null): HandoffExtensionKind {
  if (profileId === "coordinator" || profileId === "main" || profileId === "orchestrator") return "coordination";
  if (profileId?.includes("implementer")) return "implementation";
  if (profileId === "explorer" || profileId === "researcher") return "investigation";
  if (profileId?.includes("reviewer")) return "review";
  return "generic";
}
