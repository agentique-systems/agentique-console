/**
 * Governance middleware for the native SendMessage tool.
 *
 * Seats and the orchestrator lane speak over the machine peer mesh; this
 * PreToolUse/PostToolUse pair is where the console's guarantees live now that
 * the mailbox is a journal instead of the transport:
 *
 *   PreToolUse   resolve address → assert the star topology → parse the typed
 *                handoff envelope → journal (idempotent) → wake + hold the
 *                recipient → rewrite the tool input to the canonical peer name
 *                and the tagged, normalized envelope body.
 *   PostToolUse  settle the journal row: native success (msg_id) → delivered;
 *                anything else → still queued, console redelivery takes over.
 *
 * Fail-closed: any middleware exception denies the send with the error text.
 * A denial is never silent loss — nothing is journaled before validation
 * passes, and once journaled the row survives every downstream failure.
 *
 * Spike-verified behaviours this encodes (scripts/peer-spike.ts):
 * - First cross-session contact fails with a ref demand and the model re-sends
 *   as "name [ref]" — journal() must therefore be idempotent for an identical
 *   unacknowledged send, and the parsed ref is preserved in updatedInput.
 * - The tool reports failure as a SUCCESSFUL call returning {"success":false}
 *   — PostToolUse must parse the payload, not trust the call's success.
 */
import { z } from "zod";
import type { HandoffDraft } from "@agentique-console/shared";
import { HandoffDraftSchema } from "../handoffs/schema.ts";
import type { SdkHookInput, SdkHookOutput, SdkHooksFragment } from "../sdk/types.ts";
import { parsePeerAddress } from "./peer-names.ts";

export type SenderIdentity =
  | { kind: "main"; userSessionId: string }
  | { kind: "seat"; agentSessionId: string; seat: string };

export interface ResolvedRecipient {
  scope: "main" | "seat";
  /** Set for seat recipients. */
  agentSessionId?: string;
  seat?: string;
  /** The canonical registry address updatedInput rewrites `to` into. */
  peerName: string;
}

/** What the model wrote in `message`, validated. */
export interface SendEnvelope {
  handoff: HandoffDraft;
  category: "assignment" | "update" | "milestone" | "failure" | "final" | "decision";
  dedupeKey?: string;
  checkpointReadiness?: "stable" | "defer";
}

export const SendEnvelopeSchema = z.object({
  handoff: HandoffDraftSchema,
  category: z.enum(["assignment", "update", "milestone", "failure", "final", "decision"]).default("update"),
  dedupeKey: z.string().optional(),
  checkpointReadiness: z.enum(["stable", "defer"]).optional(),
});

export interface JournalResult {
  deliveryId: string;
  handoffId: string;
  /** The normalized body the recipient reads; the tag prefix is added here. */
  renderedBody: string;
  /** One-line summary for the tool's `summary` field. */
  summary: string;
  /** True when this send reuses an earlier unacknowledged journal row. */
  reused: boolean;
}

/**
 * The console side of the middleware — implemented by AgentSessionHost (and,
 * for main recipients, backed by the orchestrator runner). Kept narrow so the
 * middleware is unit-testable against stubs.
 */
export interface SendGovernor {
  /** Address → recipient, scoped to what `identity` may know about. */
  resolve(identity: SenderIdentity, name: string): ResolvedRecipient | { error: string };
  /** Route + category gates. Returns a denial reason, or null to proceed. */
  assertSendAllowed(identity: SenderIdentity, recipient: ResolvedRecipient, envelope: SendEnvelope): string | null;
  /**
   * Persist the handoff + journal row (events included). MUST be idempotent:
   * an identical unacknowledged send from the same sender returns the existing
   * row with reused=true — that is the ref-confirmation retry.
   */
  journal(identity: SenderIdentity, recipient: ResolvedRecipient, envelope: SendEnvelope, rawMessage: string): JournalResult;
  /**
   * Spawn or unpark the recipient so its inbox socket exists, and pin it live.
   * Resolves to a hold releaser, or null when the recipient cannot be made
   * addressable inside the timeout (the journal row stays queued).
   */
  ensureLive(recipient: ResolvedRecipient, timeoutMs: number): Promise<(() => void) | null>;
  /** Native carry succeeded (msg_id is the socket receipt). */
  markDelivered(deliveryId: string, msgId: string | null): void;
  /** Native carry failed; row stays queued and console redelivery owns it. */
  markCarryFailed(deliveryId: string, reason: string): void;
}

/** Why a send was denied; `wake_timeout` alone is post-journal (queued receipt). */
export type SendDenialKind =
  | "missing_to" | "unknown_recipient" | "invalid_json" | "invalid_envelope"
  | "route" | "wake_timeout" | "middleware_error";

const TAG_RE = /^\[handoff (handoff_[A-Za-z0-9_-]+) delivery (delivery_[A-Za-z0-9_-]+)\]/;

/** The `[handoff … delivery …]` prefix a carried body starts with. */
export function deliveryTagOf(body: string): { handoffId: string; deliveryId: string } | null {
  const match = TAG_RE.exec(body);
  return match ? { handoffId: match[1] as string, deliveryId: match[2] as string } : null;
}

function deny(reason: string): SdkHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

const ENVELOPE_CONTRACT =
  `The message field must be a JSON object: {"handoff": <HandoffDraft>, "category"?: ` +
  `"assignment"|"update"|"milestone"|"failure"|"final"|"decision", "dedupeKey"?: string, ` +
  `"checkpointReadiness"?: "stable"|"defer"}. The handoff core requires schemaVersion 1, taskId, ` +
  `status, risk, action, state{summary, evidence[]}, result{summary, artifacts[]}, uncertainty[], ` +
  `nextAction, requestExpandedContext.`;

export function buildSendMessageMiddleware(deps: {
  identity: SenderIdentity;
  governor: SendGovernor;
  sendWakeTimeoutMs: number;
  deliveryHoldLeaseMs: number;
  /** Persistent denial telemetry; exceptions here never affect the decision. */
  onDenied?: (denial: { kind: SendDenialKind; to: string; reason: string }) => void;
}): SdkHooksFragment {
  const { identity, governor } = deps;
  /** toolUseId → journal row + hold releaser, settled by PostToolUse or lease expiry. */
  const inFlight = new Map<string, { deliveryId: string; release: () => void; lease: NodeJS.Timeout }>();

  const denied = (kind: SendDenialKind, to: string, reason: string): SdkHookOutput => {
    try { deps.onDenied?.({ kind, to, reason }); } catch { /* telemetry must not decide */ }
    return deny(reason);
  };

  const pre = async (input: SdkHookInput, toolUseId: string | undefined): Promise<SdkHookOutput> => {
    const toolInput = (input.tool_input ?? {}) as { to?: unknown; message?: unknown; summary?: unknown };
    const rawTo = typeof toolInput.to === "string" ? toolInput.to : "";
    try {
      const rawMessage = typeof toolInput.message === "string" ? toolInput.message : "";
      if (rawTo === "") return denied("missing_to", rawTo, "SendMessage requires a `to` address.");

      const address = parsePeerAddress(rawTo);
      const resolved = governor.resolve(identity, address.name);
      if ("error" in resolved) return denied("unknown_recipient", rawTo, resolved.error);

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(stripDeliveryTag(rawMessage));
      } catch {
        return denied("invalid_json", rawTo, `SendMessage message must be JSON. ${ENVELOPE_CONTRACT}`);
      }
      const envelope = SendEnvelopeSchema.safeParse(parsedJson);
      if (!envelope.success) {
        const issues = envelope.error.issues.slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
        return denied("invalid_envelope", rawTo, `Invalid handoff envelope — ${issues}. ${ENVELOPE_CONTRACT}`);
      }

      const routeError = governor.assertSendAllowed(identity, resolved, envelope.data);
      if (routeError !== null) return denied("route", rawTo, routeError);

      const journaled = governor.journal(identity, resolved, envelope.data, rawMessage);

      const release = await governor.ensureLive(resolved, deps.sendWakeTimeoutMs);
      if (release === null) {
        return denied("wake_timeout", rawTo,
          `queued as delivery ${journaled.deliveryId} — the recipient is not reachable right now; ` +
          `the console will deliver it when the recipient wakes. Do not resend this message.`,
        );
      }
      if (toolUseId !== undefined) {
        const lease = setTimeout(() => {
          inFlight.delete(toolUseId);
          release();
        }, deps.deliveryHoldLeaseMs);
        lease.unref?.();
        inFlight.set(toolUseId, { deliveryId: journaled.deliveryId, release, lease });
      } else {
        release();
      }

      const canonicalTo = address.ref !== null && address.name === resolved.peerName
        ? `${resolved.peerName} [${address.ref}]`
        : resolved.peerName;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            to: canonicalTo,
            summary: journaled.summary.slice(0, 190),
            message: `[handoff ${journaled.handoffId} delivery ${journaled.deliveryId}] ${journaled.renderedBody}`,
          },
        },
      };
    } catch (error) {
      return denied("middleware_error", rawTo,
        `console middleware failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const post = async (input: SdkHookInput, toolUseId: string | undefined): Promise<SdkHookOutput> => {
    if (toolUseId === undefined) return {};
    const pending = inFlight.get(toolUseId);
    if (pending === undefined) return {};
    inFlight.delete(toolUseId);
    clearTimeout(pending.lease);
    pending.release();
    try {
      const response = JSON.stringify(input.tool_response ?? "");
      // The tool reports refusal as a successful call with {"success":false}.
      const msgId = /\\"msg_id\\":\\"([^"\\]+)\\"/.exec(response)?.[1] ?? /"msg_id":"([^"]+)"/.exec(response)?.[1] ?? null;
      const succeeded = response.includes('\\"success\\":true') || response.includes('"success":true');
      if (succeeded) deps.governor.markDelivered(pending.deliveryId, msgId);
      else deps.governor.markCarryFailed(pending.deliveryId, response.slice(0, 500));
    } catch (error) {
      deps.governor.markCarryFailed(pending.deliveryId, error instanceof Error ? error.message : String(error));
    }
    return {};
  };

  return {
    PreToolUse: [{ matcher: "SendMessage", hooks: [pre] }],
    PostToolUse: [{ matcher: "SendMessage", hooks: [post] }],
  };
}

/** A model retrying a tagged redelivery may echo the tag; validation ignores it. */
function stripDeliveryTag(body: string): string {
  return body.replace(TAG_RE, "").trimStart();
}

/** Concatenating merge of hook fragments (later fragments append matchers). */
export function mergeHooks(fragments: SdkHooksFragment[]): SdkHooksFragment {
  const merged: SdkHooksFragment = {};
  for (const fragment of fragments) {
    for (const [event, matchers] of Object.entries(fragment)) {
      if (!matchers) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}
