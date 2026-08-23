/**
 * The DeliverySelector seam, pinned with a fake selector: unselected rows stay
 * queued (and still count toward the status derivation), selected rows
 * deliver, and the assignment-turn reset keys on SELECTED rows only.
 */
import { describe, expect, it } from "vitest";
import type { MailboxDeliveryRow } from "../db/repo.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness, type Harness } from "../test-helpers.ts";
import { PromptComposer } from "./composer.ts";
import { Mailroom, simpleHandoff } from "./mailroom.ts";
import { SessionRouting } from "./routing.ts";
import type { DeliverySelector } from "./seams.ts";
import { WorktreeBinding } from "./worktree-binding.ts";

const draft = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

/** Journal a queued row for `recipient` directly — no delivery machinery runs. */
function queueRow(h: Harness, userSessionId: string, agentSessionId: string, recipient: string, category: "assignment" | "update", action: string) {
  const prepared = h.handoffs.prepare({ draft: draft(action), userSessionId, agentSessionId,
    sender: "coordinator", recipient, profileId: null, generation: 0, trigger: category, parentHandoffId: null });
  return h.repo.appendHandoffMailbox({ sessionKind: "agent", sessionId: agentSessionId, userSessionId,
    agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: recipient, recipient,
    kind: "message", text: prepared.text, category, handoff: prepared.row, summary: prepared.summary });
}

/** A Mailroom over the harness's real stores, with the selector and injector under test. */
function mailroomWith(h: Harness, selector: DeliverySelector, sink: {
  injected: { recipient: string; rows: MailboxDeliveryRow[]; prompt: string }[];
  resets: string[];
}): Mailroom {
  const routing = new SessionRouting({ repo: h.repo });
  return new Mailroom({
    repo: h.repo, bus: h.bus, config: h.config, interactions: h.interactions,
    decisions: h.decisions, tasks: h.tasks, handoffs: h.handoffs, scheduler: () => h.scheduler,
    wake: () => {},
    capacityPaused: () => false,
    routing,
    worktree: new WorktreeBinding({ repo: h.repo, bus: h.bus, artifacts: h.app.artifacts, config: h.config,
      worktrees: null, getWorkspaceRoot: () => "/tmp/test-workspace",
      escalationTarget: () => "main", isReviewRole: () => false, laneBusy: () => false, laneLive: () => false,
      transfer: () => { throw new Error("unused"); }, simpleHandoff }),
    composer: new PromptComposer({ repo: h.repo, bus: h.bus, config: h.config, handoffs: h.handoffs,
      decisions: h.decisions, requirements: h.app.requirements, assumptions: h.app.assumptions, tasks: h.tasks, interactions: h.interactions, worktrees: null, laneState: () => null }),
    lanes: { hasBusyTurnExcludingOperatorWaits: () => false, operatorWaits: () => [],
      bindOperatorWait: () => () => {}, hasLane: () => false, namesWithActiveTurn: () => [] },
    selector,
    ensureLive: async () => {},
    injector: {
      ready: () => true,
      inject: (_session, recipient, rows, prompt) => sink.injected.push({ recipient, rows, prompt }),
      resetAssignmentTurns: (_agentSessionId, recipient) => sink.resets.push(recipient),
    },
    sessionStatus: () => "idle",
    boundary: { crossBoundary: () => {}, maybeReleaseParentFinal: () => {} },
    onPatternPost: () => {},
    recordFailure: (agentSessionId, error) => { throw new Error(`unexpected mailroom failure for ${agentSessionId}: ${String(error)}`); },
  });
}

describe("DeliverySelector seam", () => {
  it("delivers selected rows only; a held row stays queued and still counts toward status; reset keys on selected", async () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "selection", agents: [{ name: "scout", profileId: "explorer" }] });
    const sessionRow = () => h.repo.getAgentSession(created.agentSessionId)!;

    const assignment = queueRow(h, userSessionId, created.agentSessionId, "scout", "assignment", "build the thing");
    const update = queueRow(h, userSessionId, created.agentSessionId, "scout", "update", "context you should have");

    const sink = { injected: [] as { recipient: string; rows: MailboxDeliveryRow[]; prompt: string }[], resets: [] as string[] };
    const holdAssignment: DeliverySelector = { select: (_session, _agent, rows) => rows.filter((row) => row.id !== assignment.delivery.id) };
    const mailroom = mailroomWith(h, holdAssignment, sink);

    await mailroom.deliver(created.agentSessionId, "scout");

    // Selected rows deliver — exactly one push, carrying only the update.
    expect(sink.injected).toHaveLength(1);
    expect(sink.injected[0]!.rows.map((row) => row.id)).toEqual([update.delivery.id]);
    expect(sink.injected[0]!.prompt).toContain("context you should have");
    expect(sink.injected[0]!.prompt).not.toContain("build the thing");
    // The assignment was held back, so the reset must NOT fire.
    expect(sink.resets).toEqual([]);

    // The held row stays queued in the journal...
    const statuses = new Map(h.repo.listUnackedDeliveries(created.agentSessionId, "scout").map((row) => [row.id, row.status]));
    expect(statuses.get(assignment.delivery.id)).toBe("queued");
    expect(statuses.get(update.delivery.id)).toBe("delivered");
    // ...and still counts toward the session's status derivation.
    expect(h.host.statusOf(sessionRow())).toBe("working");

    // The next delivery re-offers the held row; selecting it fires the reset.
    const releaseAll: DeliverySelector = { select: (_session, _agent, rows) => rows };
    await mailroomWith(h, releaseAll, sink).deliver(created.agentSessionId, "scout");
    expect(sink.injected).toHaveLength(2);
    expect(sink.injected[1]!.rows.map((row) => row.id)).toEqual([assignment.delivery.id]);
    expect(sink.resets).toEqual(["scout"]);
  });
});
