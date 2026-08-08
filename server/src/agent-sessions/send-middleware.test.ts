/** The SendMessage governance middleware against a stub governor. */
import { describe, expect, it, vi } from "vitest";
import {
  buildSendMessageMiddleware,
  deliveryTagOf,
  type JournalResult,
  type ResolvedRecipient,
  type SendGovernor,
  type SenderIdentity,
} from "./send-middleware.ts";
import type { SdkHookCallback } from "../sdk/types.ts";

const seatIdentity: SenderIdentity = { kind: "seat", agentSessionId: "as_x", seat: "scout" };

const validEnvelope = JSON.stringify({
  handoff: {
    core: {
      schemaVersion: 1, taskId: null, status: "in_progress", risk: "medium",
      action: "Investigate flaky test",
      state: { summary: "Found the race in the retry loop", evidence: [] },
      result: { summary: null, artifacts: [] },
      uncertainty: [], nextAction: "Patch the retry loop", requestExpandedContext: false,
    },
    extension: { kind: "generic", data: {} },
  },
  category: "update",
});

function stubGovernor(overrides: Partial<SendGovernor> = {}): SendGovernor & {
  journaled: unknown[]; delivered: [string, string | null][]; failed: [string, string][];
} {
  const journaled: unknown[] = [];
  const delivered: [string, string | null][] = [];
  const failed: [string, string][] = [];
  return {
    journaled, delivered, failed,
    resolve: (_identity, name): ResolvedRecipient | { error: string } =>
      name === "orchestrator" || name === "console-orchestrator-x"
        ? { scope: "seat", agentSessionId: "as_x", seat: "orchestrator", peerName: "console-orchestrator-x" }
        : { error: `unknown recipient ${name}` },
    assertSendAllowed: () => null,
    journal: (_identity, _recipient, envelope, raw): JournalResult => {
      journaled.push({ envelope, raw });
      return { deliveryId: "delivery_1", handoffId: "handoff_1", renderedBody: "CORE: …", summary: "update from scout", reused: false };
    },
    ensureLive: async () => () => undefined,
    markDelivered: (id, msgId) => { delivered.push([id, msgId]); },
    markCarryFailed: (id, reason) => { failed.push([id, reason]); },
    ...overrides,
  };
}

function hooksOf(governor: SendGovernor) {
  const fragment = buildSendMessageMiddleware({
    identity: seatIdentity, governor, sendWakeTimeoutMs: 50, deliveryHoldLeaseMs: 1_000,
  });
  const pre = fragment.PreToolUse?.[0]?.hooks[0] as SdkHookCallback;
  const post = fragment.PostToolUse?.[0]?.hooks[0] as SdkHookCallback;
  return { pre, post };
}

const call = (to: string, message: string) => ({
  hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to, message },
});

describe("SendMessage PreToolUse", () => {
  it("denies an unknown recipient", async () => {
    const { pre } = hooksOf(stubGovernor());
    const out = await pre(call("stranger", validEnvelope), "t1", {});
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("unknown recipient");
  });

  it("denies a forbidden route with the governor's reason", async () => {
    const { pre } = hooksOf(stubGovernor({ assertSendAllowed: () => "route scout → impl is not allowed" }));
    const out = await pre(call("orchestrator", validEnvelope), "t1", {});
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("route scout → impl is not allowed");
  });

  it("denies non-JSON and schema-invalid envelopes with the contract", async () => {
    const { pre } = hooksOf(stubGovernor());
    const notJson = await pre(call("orchestrator", "just text"), "t1", {});
    expect(notJson.hookSpecificOutput?.permissionDecisionReason).toContain("must be JSON");
    const badShape = await pre(call("orchestrator", JSON.stringify({ handoff: { core: {} } })), "t2", {});
    expect(badShape.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(badShape.hookSpecificOutput?.permissionDecisionReason).toContain("Invalid handoff envelope");
  });

  it("allows a valid send: journals, rewrites to the peer name and tagged body", async () => {
    const governor = stubGovernor();
    const { pre } = hooksOf(governor);
    const out = await pre(call("orchestrator", validEnvelope), "t1", {});
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(governor.journaled).toHaveLength(1);
    const updated = out.hookSpecificOutput?.updatedInput as { to: string; message: string; summary: string };
    expect(updated.to).toBe("console-orchestrator-x");
    expect(deliveryTagOf(updated.message)).toEqual({ handoffId: "handoff_1", deliveryId: "delivery_1" });
    expect(updated.summary).toBe("update from scout");
  });

  it("preserves a ref suffix on the canonical name (first-contact retry)", async () => {
    const { pre } = hooksOf(stubGovernor());
    const out = await pre(call("console-orchestrator-x [ab12cd]", validEnvelope), "t1", {});
    const updated = out.hookSpecificOutput?.updatedInput as { to: string };
    expect(updated.to).toBe("console-orchestrator-x [ab12cd]");
  });

  it("denies with a queued receipt when the recipient cannot wake", async () => {
    const { pre } = hooksOf(stubGovernor({ ensureLive: async () => null }));
    const out = await pre(call("orchestrator", validEnvelope), "t1", {});
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("queued as delivery delivery_1");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("Do not resend");
  });

  it("fails closed when the governor throws", async () => {
    const { pre } = hooksOf(stubGovernor({ journal: () => { throw new Error("db locked"); } }));
    const out = await pre(call("orchestrator", validEnvelope), "t1", {});
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("console middleware failure: db locked");
  });
});

describe("SendMessage PostToolUse", () => {
  it("marks delivered on native success and releases the hold", async () => {
    const release = vi.fn();
    const governor = stubGovernor({ ensureLive: async () => release });
    const { pre, post } = hooksOf(governor);
    await pre(call("orchestrator", validEnvelope), "t1", {});
    await post({
      hook_event_name: "PostToolUse", tool_name: "SendMessage",
      tool_response: [{ type: "text", text: '{"success":true,"message":"…","msg_id":"m-77"}' }],
    }, "t1", {});
    expect(governor.delivered).toEqual([["delivery_1", "m-77"]]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the row for console redelivery when the tool reports success:false", async () => {
    const governor = stubGovernor();
    const { pre, post } = hooksOf(governor);
    await pre(call("orchestrator", validEnvelope), "t1", {});
    await post({
      hook_event_name: "PostToolUse", tool_name: "SendMessage",
      tool_response: [{ type: "text", text: '{"success":false,"message":"Re-send with the ref …"}' }],
    }, "t1", {});
    expect(governor.delivered).toHaveLength(0);
    expect(governor.failed).toHaveLength(1);
    expect(governor.failed[0]?.[0]).toBe("delivery_1");
  });
});
