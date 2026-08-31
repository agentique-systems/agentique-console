/**
 * Runtime-minted opaque identifiers. Every canonical object carries a fixed
 * prefix from the glossary; a prefix is never reused for a second kind.
 */

export const ID_PREFIXES = {
  workspace: "ws",
  conversation: "cv",
  conversationMessage: "cvm",
  run: "run",
  planNode: "pn",
  planEdge: "pe",
  requirement: "req",
  requirementRevision: "reqr",
  acceptanceCriterion: "ac",
  decision: "dec",
  task: "task",
  artifact: "art",
  handoff: "ho",
  agentDefinition: "agd",
  agentDefinitionRevision: "agdr",
  invocation: "inv",
  attempt: "att",
  evaluation: "eval",
  gate: "gate",
  snapshot: "snap",
  changeset: "cs",
  publication: "pub",
  capacityLease: "lease",
  budgetReservation: "bres",
  contextManifest: "cm",
  usage: "use",
  approvedToolCallUse: "acu",
  runtimeToolCall: "rtc",
  completionRequest: "crq",
  signoffResolution: "sres",
  budgetIncrease: "binc",
  allocationExtension: "aext",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

export type Id<P extends IdPrefix> = `${P}_${string}`;

export type WorkspaceId = Id<"ws">;
export type ConversationId = Id<"cv">;
export type ConversationMessageId = Id<"cvm">;
export type RunId = Id<"run">;
export type PlanNodeId = Id<"pn">;
export type PlanEdgeId = Id<"pe">;
export type RequirementId = Id<"req">;
export type RequirementRevisionId = Id<"reqr">;
export type AcceptanceCriterionId = Id<"ac">;
export type DecisionId = Id<"dec">;
export type TaskId = Id<"task">;
export type ArtifactId = Id<"art">;
export type HandoffId = Id<"ho">;
export type AgentDefinitionId = Id<"agd">;
export type AgentDefinitionRevisionId = Id<"agdr">;
export type InvocationId = Id<"inv">;
export type AttemptId = Id<"att">;
export type EvaluationId = Id<"eval">;
export type GateId = Id<"gate">;
export type SnapshotId = Id<"snap">;
export type ChangesetId = Id<"cs">;
export type PublicationId = Id<"pub">;
export type CapacityLeaseId = Id<"lease">;
export type BudgetReservationId = Id<"bres">;
export type ContextManifestId = Id<"cm">;
export type UsageId = Id<"use">;
export type ApprovedToolCallUseId = Id<"acu">;
export type RuntimeToolCallId = Id<"rtc">;
export type CompletionRequestId = Id<"crq">;
export type SignoffResolutionId = Id<"sres">;
export type BudgetIncreaseId = Id<"binc">;
export type AllocationExtensionId = Id<"aext">;

const ID_BODY_LENGTH = 24;
const ID_BODY = /^[0-9a-f]{24}$/;

const PREFIX_SET: ReadonlySet<string> = new Set(Object.values(ID_PREFIXES));

export type RandomHex = (length: number) => string;

/** Web Crypto is available in every supported runtime (Node 22+, browsers). */
interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function defaultRandomHex(length: number): string {
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (!source) throw new Error("no cryptographic random source is available");
  const bytes = new Uint8Array(Math.ceil(length / 2));
  source.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out.slice(0, length);
}

/** Mints a fresh id for `kind`. The random source is injectable for tests. */
export function newId<K extends IdKind>(
  kind: K,
  randomHex: RandomHex = defaultRandomHex,
): Id<(typeof ID_PREFIXES)[K]> {
  const body = randomHex(ID_BODY_LENGTH);
  if (!ID_BODY.test(body)) {
    throw new Error(`id random source must return ${ID_BODY_LENGTH} lower-case hex characters`);
  }
  return `${ID_PREFIXES[kind]}_${body}` as Id<(typeof ID_PREFIXES)[K]>;
}

export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  if (typeof value !== "string") return false;
  if (!value.startsWith(`${prefix}_`)) return false;
  return ID_BODY.test(value.slice(prefix.length + 1));
}

export function isIdOfKind<K extends IdKind>(
  kind: K,
  value: unknown,
): value is Id<(typeof ID_PREFIXES)[K]> {
  return isId(ID_PREFIXES[kind], value);
}

/** The prefix of a well-formed id, or `null` when the value is not one. */
export function idPrefixOf(value: unknown): IdPrefix | null {
  if (typeof value !== "string") return null;
  const underscore = value.indexOf("_");
  if (underscore <= 0) return null;
  const prefix = value.slice(0, underscore);
  if (!PREFIX_SET.has(prefix)) return null;
  return ID_BODY.test(value.slice(underscore + 1)) ? (prefix as IdPrefix) : null;
}

export function assertId<P extends IdPrefix>(prefix: P, value: unknown, what = "id"): Id<P> {
  if (!isId(prefix, value)) {
    throw new TypeError(`${what} must be a ${prefix}_ id, got ${JSON.stringify(value)}`);
  }
  return value;
}
