/**
 * Requirement proposals (execution-model §8.1): the Orchestrator proposes
 * through `propose_requirements`, only the operator's approval creates a
 * revision (verbatim or edited, with stable ids for kept Requirements and
 * the proposed criteria), a rejection creates nothing, a newer proposal
 * supersedes the open one, every resolution is queued as a typed input the
 * Orchestrator's next turn delivers, and repeats replay.
 */
import type { ManifestInput, ProposedRequirement, RequirementProposalId, RuntimeToolCallRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { rootPort } from "./decision-test-support.ts";
import type { RuntimeToolExecutor } from "./runtime-tools.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

function tree(keptId: string, overrides: Partial<ProposedRequirement>[] = []): ProposedRequirement[] {
  const base: ProposedRequirement[] = [
    { key: "root", parentKey: null, composition: "all", statement: "The CLI reports its version", requirementId: null, acceptanceCriteria: [] },
    { key: "keep", parentKey: "root", composition: null, statement: "The build passes", requirementId: keptId as never, acceptanceCriteria: [{ kind: "deterministic", command: "npm test", expectedExitCode: 0 }] },
    { key: "new", parentKey: "root", composition: null, statement: "--version prints the package version", requirementId: null, acceptanceCriteria: [{ kind: "evaluated", question: "Does --version print the version?", rubric: null }] },
  ];
  return base.map((entry, i) => ({ ...entry, ...(overrides[i] ?? {}) }));
}

const propose = (requirements: ProposedRequirement[], rationale = "The operator's message implies a versioned CLI."): RuntimeToolCallRequest => ({ tool: "propose_requirements", input: { requirements, rationale } });

function proposalIdOf(outcome: Awaited<ReturnType<RuntimeToolExecutor["call"]>>): RequirementProposalId {
  if (outcome.kind !== "accepted" || outcome.result.tool !== "propose_requirements") throw new Error(`expected an accepted proposal, got ${JSON.stringify(outcome)}`);
  return outcome.result.proposalId;
}

describe("propose_requirements", () => {
  it("records a bounded proposal awaiting the operator, supersedes the Run's earlier open proposal, refuses a tree keeping a Requirement that is not live, and changes no Requirement by itself", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      const revisionBefore = h.stores.requirements.currentRevision(conversationId)!;
      const seq = h.ctx.journal.lastSeq();
      expect(await r.port.call(propose(tree(h.ctx.ids("requirement"))))).toMatchObject({ kind: "rejected", tool: "propose_requirements", reasons: [{ code: "proposal_invalid", path: "requirements.1.requirementId" }] });
      expect(await r.port.call(propose(tree(s.completion.requirementId, [{}, { parentKey: "missing" }])))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(await r.port.call(propose(tree(s.completion.requirementId, [{ composition: null }])))).toMatchObject({ kind: "rejected", reasons: [{ code: "invalid_input" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      const first = await r.port.call(propose(tree(s.completion.requirementId)));
      const firstId = proposalIdOf(first);
      expect(first).toMatchObject({ kind: "accepted", replayed: false, result: { tool: "propose_requirements", status: "proposed" } });
      expect(h.stores.requirementProposals.get(firstId)).toMatchObject({ runId, conversationId, invocationId: r.invocation.id, status: "proposed", rationale: "The operator's message implies a versioned CLI.", resolution: null, supersededByProposalId: null });
      expect(h.stores.requirementProposals.openFor(runId)?.id).toBe(firstId);
      expect(await r.port.call(propose(tree(s.completion.requirementId)))).toMatchObject({ kind: "accepted", replayed: true, result: { proposalId: firstId } });
      // A different proposal supersedes the open one; the Requirements themselves are untouched until the operator approves.
      const second = await r.port.call(propose(tree(s.completion.requirementId), "A narrower reading."));
      const secondId = proposalIdOf(second);
      expect(h.stores.requirementProposals.get(firstId)).toMatchObject({ status: "superseded", supersededByProposalId: secondId });
      expect(h.stores.requirementProposals.openFor(runId)?.id).toBe(secondId);
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type)).toEqual(["requirement_proposal.created", "runtime_tool_call.committed", "requirement_proposal.superseded", "requirement_proposal.created", "runtime_tool_call.committed"]);
      expect(h.stores.requirements.currentRevision(conversationId)!.id).toBe(revisionBefore.id);
      expect(h.stores.requirements.listByConversation(conversationId)).toHaveLength(1);
      expect(() => h.requirementProposals.approve({ proposalId: firstId })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
    } finally {
      h.close();
    }
  });

  it("approval creates the revision — kept ids stable, new ids minted, criteria authored in the new revision — records the operator's resolution, queues it for the Orchestrator, and the next root turn delivers it; repeats replay and a later rejection conflicts", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      const proposalId = proposalIdOf(await r.port.call(propose(tree(s.completion.requirementId))));
      expect(() => h.requirementProposals.approve({ proposalId }, { actor: { kind: "runtime" } })).toThrow(expect.objectContaining({ refusal: "operator_required" }));
      expect(() => h.requirementProposals.approve({ proposalId: h.ctx.ids("requirementProposal") })).toThrow(expect.objectContaining({ refusal: "proposal_not_found" }));
      const seq = h.ctx.journal.lastSeq();
      const approved = h.requirementProposals.approve({ proposalId, rationale: "Matches the request." });
      if (approved.kind !== "approved") throw new Error(approved.kind);
      expect(approved).toMatchObject({ proposalId, edited: false, replayed: false });
      const revision = h.stores.requirements.getRevision(approved.requirementRevisionId);
      expect(h.stores.requirements.currentRevision(conversationId)!.id).toBe(revision.id);
      expect(revision.tree.map((e) => [e.statement, e.parentId === null, e.composition])).toEqual([["The CLI reports its version", true, "all"], ["The build passes", false, null], ["--version prints the package version", false, null]]);
      const kept = revision.tree.find((e) => e.statement === "The build passes")!;
      const created = revision.tree.find((e) => e.statement === "--version prints the package version")!;
      expect(kept.id).toBe(s.completion.requirementId);
      expect(created.id).not.toBe(s.completion.requirementId);
      expect(h.stores.requirements.get(s.completion.requirementId).status).toBe("open");
      expect(h.stores.requirements.listAcceptanceCriteria({ requirementId: kept.id }).filter((c) => c.requirementRevisionId === revision.id).map((c) => c.check)).toEqual([{ kind: "deterministic", command: "npm test", expectedExitCode: 0 }]);
      expect(h.stores.requirements.listAcceptanceCriteria({ requirementId: created.id }).map((c) => [c.requirementRevisionId, c.check.kind])).toEqual([[revision.id, "evaluated"]]);
      expect(h.stores.requirementProposals.get(proposalId)).toMatchObject({ status: "approved", resolution: { status: "approved", requirementRevisionId: revision.id, edited: false, rationale: "Matches the request." } });
      const queued = h.orchestratorInputs.pending(runId);
      expect(queued.map((q) => q.input)).toEqual([{ kind: "requirement_proposal_resolution", proposalId, status: "approved", requirementRevisionId: revision.id, edited: false, rationale: "Matches the request." }]);
      expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => [e.type, e.actor])).toContainEqual(["requirement_proposal.approved", { kind: "operator" }]);
      // Replays and conflicts.
      expect(h.requirementProposals.approve({ proposalId })).toMatchObject({ kind: "approved", requirementRevisionId: revision.id, replayed: true });
      expect(() => h.requirementProposals.reject({ proposalId })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      // Nothing reaches the active root turn: the input waits until it ends, then one decision_resolution turn delivers it.
      expect(h.scheduler.reconcileRun(runId).actions.some((a) => a.kind === "prepare_root_turn")).toBe(false);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(r.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const requests = h.provider.requests.length;
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(pass.actions.map((a) => a.action.kind)).toEqual(["prepare_root_turn"]);
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn.id).not.toBe(r.invocation.id);
      expect(turn).toMatchObject({ role: "orchestrator", purpose: "decision_resolution", continuedFromInvocationId: r.invocation.id });
      const inputs = h.stores.invocations.getManifest(turn.id).content.inputs;
      expect(inputs.map((i) => i.kind)).toEqual(["requirement_proposal_resolution"]);
      expect((inputs[0] as Extract<ManifestInput, { kind: "requirement_proposal_resolution" }>).requirementRevisionId).toBe(revision.id);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
      expect(h.orchestratorInputs.listByRun(runId).map((q) => q.deliveredByInvocationId)).toEqual([turn.id]);
      expect(h.provider.requests.length).toBe(requests);
    } finally {
      h.close();
    }
  });

  it("the operator edits or rejects: an edited approval records `edited` and creates exactly the edited tree; a rejection creates no revision, retires nothing, and queues the rejection for the Orchestrator", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const r = await rootPort(h, s);
      const runId = s.created.run.id;
      const conversationId = s.created.run.conversationId;
      const rejectedId = proposalIdOf(await r.port.call(propose(tree(s.completion.requirementId), "First reading.")));
      const before = h.stores.requirements.currentRevision(conversationId)!.id;
      expect(h.requirementProposals.reject({ proposalId: rejectedId, rationale: "Too broad." })).toEqual({ kind: "rejected", proposalId: rejectedId, replayed: false });
      expect(h.stores.requirementProposals.get(rejectedId)).toMatchObject({ status: "rejected", resolution: { status: "rejected", requirementRevisionId: null, edited: false, rationale: "Too broad." } });
      expect(h.stores.requirements.currentRevision(conversationId)!.id).toBe(before);
      expect(h.requirementProposals.reject({ proposalId: rejectedId })).toEqual({ kind: "rejected", proposalId: rejectedId, replayed: true });
      expect(() => h.requirementProposals.approve({ proposalId: rejectedId })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      // An edited approval: the operator drops the new leaf and keeps the rest.
      const editedId = proposalIdOf(await r.port.call(propose(tree(s.completion.requirementId), "Second reading.")));
      const edits = tree(s.completion.requirementId).slice(0, 2);
      expect(() => h.requirementProposals.approve({ proposalId: editedId, entries: [{ ...edits[0]!, composition: null }, edits[1]!] })).toThrow(expect.objectContaining({ refusal: "proposal_invalid" }));
      const approved = h.requirementProposals.approve({ proposalId: editedId, entries: edits });
      if (approved.kind !== "approved") throw new Error(approved.kind);
      expect(approved.edited).toBe(true);
      const revision = h.stores.requirements.getRevision(approved.requirementRevisionId);
      expect(revision.tree.map((e) => e.statement)).toEqual(["The CLI reports its version", "The build passes"]);
      expect(h.stores.requirementProposals.get(editedId).resolution).toMatchObject({ status: "approved", edited: true });
      expect(h.orchestratorInputs.pending(runId).map((q) => q.input)).toEqual([
        { kind: "requirement_proposal_resolution", proposalId: rejectedId, status: "rejected", requirementRevisionId: null, edited: false, rationale: "Too broad." },
        { kind: "requirement_proposal_resolution", proposalId: editedId, status: "approved", requirementRevisionId: revision.id, edited: true, rationale: null },
      ]);
      // Both resolutions reach the Orchestrator in one turn once the current turn ends.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(r.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn.purpose).toBe("decision_resolution");
      expect(h.stores.invocations.getManifest(turn.id).content.inputs.map((i) => i.kind)).toEqual(["requirement_proposal_resolution", "requirement_proposal_resolution"]);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
