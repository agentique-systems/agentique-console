/**
 * Dimension-tagged trace checkers — the shared artifact between tiers.
 *
 * Each combinator returns a TraceCheck whose verdict cites event seqs. Checks
 * read ONLY the journal (via Trace), so a checker validated by Tier A against
 * exemplary/violating scripted traces runs unchanged over a live export.
 *
 * Doctrine notes encoded here, from the approved plan:
 * - Adaptation is judged as response to decision-relevant evidence, never as
 *   pivot counting (respondedToEvidence / stayedTheCourse are both "pass"
 *   shapes for different scenarios).
 * - Review independence is proportional: commissionedIndependentReview is used
 *   only by scenarios whose stakes warrant it, and there is deliberately no
 *   "reviewer count" metric anywhere.
 */
import { flattenRequirementGraph, parseRequirementsDocument } from "@agentique-console/shared";

import type { Ev, EvPredicate, HandoffRow, Trace } from "./trace.ts";
import type { CheckResult, DimensionId, TraceCheck } from "./scenario.ts";

function pass(detail: string, evidence: Ev[] = []): CheckResult {
  return { pass: true, evidence: evidence.map((event) => event.seq), detail };
}

function fail(detail: string, evidence: Ev[] = []): CheckResult {
  return { pass: false, evidence: evidence.map((event) => event.seq), detail };
}

const firstBuild: EvPredicate = (event) => event.type === "agent_session.created";

const INTERVENTION_TOOLS = [
  "mcp__console__send_to_coordinator",
  "mcp__console__interrupt_agent",
  "mcp__console__close_agent_session",
];

/** A main-lane intervention tool call whose input names THIS session. */
function toolTargets(event: Ev, agentSessionId: string, tools: string[] = INTERVENTION_TOOLS): boolean {
  if (event.type !== "user_session.tool.called") return false;
  if (!tools.includes(String(event.payload.name ?? ""))) return false;
  const input = event.payload.input as { agentSessionId?: unknown } | undefined;
  return input?.agentSessionId === agentSessionId;
}

/** A ledger mutation on THIS session's tasks. */
function taskTargets(event: Ev, agentSessionId: string): boolean {
  if (event.type !== "task.created" && event.type !== "task.updated") return false;
  const task = event.payload.task as { agentSessionId?: unknown } | undefined;
  return task?.agentSessionId === agentSessionId;
}

/** Main asked the operator at least once before commissioning any session. */
export function askedBeforeBuilding(): TraceCheck {
  return {
    id: "asked-before-building",
    dimension: "intent-development",
    description: "a clarifying question preceded the first commissioned session",
    run(trace) {
      const asked = trace.first("user_session.question.asked");
      const built = trace.first("agent_session.created");
      if (asked === undefined) return fail("no question was ever asked", built ? [built] : []);
      if (built === undefined) return pass("questions asked; nothing built yet", [asked]);
      return asked.seq < built.seq
        ? pass("first question precedes first session", [asked, built])
        : fail("built before asking anything", [built, asked]);
    },
  };
}

export function zeroClarifyingQuestions(): TraceCheck {
  return {
    id: "zero-clarifying-questions",
    dimension: "question-economy",
    description: "a well-specified task needed no clarifying questions",
    run(trace) {
      const asked = trace.events("user_session.question.asked");
      return asked.length === 0
        ? pass("no questions asked")
        : fail(`${asked.length} question card(s) raised on a fully specified task`, asked);
    },
  };
}

export function questionCountAtMost(n: number): TraceCheck {
  return {
    id: `question-count-at-most-${n}`,
    dimension: "question-economy",
    description: `at most ${n} question card(s)`,
    run(trace) {
      const asked = trace.events("user_session.question.asked");
      return asked.length <= n
        ? pass(`${asked.length} question card(s)`, asked)
        : fail(`${asked.length} question cards exceeds budget ${n}`, asked);
    },
  };
}

export function noAgentSessions(): TraceCheck {
  return {
    id: "no-agent-sessions",
    dimension: "marginal-agent-value",
    description: "a trivial task was handled without commissioning any session",
    run(trace) {
      const sessions = trace.agentSessions();
      return sessions.length === 0
        ? pass("no sessions commissioned")
        : fail(`${sessions.length} session(s) commissioned for a trivial task`, trace.events("agent_session.created"));
    },
  };
}

export function sessionCountAtMost(n: number): TraceCheck {
  return {
    id: `session-count-at-most-${n}`,
    dimension: "marginal-agent-value",
    description: `at most ${n} agent session(s)`,
    run(trace) {
      const created = trace.events("agent_session.created");
      return created.length <= n
        ? pass(`${created.length} session(s)`, created)
        : fail(`${created.length} sessions exceeds ${n} — marginal value of the extras unestablished`, created);
    },
  };
}

/** Investigation (an explorer seat or main's own read tools) preceded implementation. Seq-ordered — createdAt ties within a millisecond. */
export function investigatedBeforeImplementing(): TraceCheck {
  return {
    id: "investigated-before-implementing",
    dimension: "exploration",
    description: "investigation preceded the first write-capable seat",
    run(trace) {
      const createdSeq = new Map<string, number>();
      for (const event of trace.events("agent_session.created")) {
        const id = (event.payload.session as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") createdSeq.set(id, event.seq);
      }
      const sessions = trace.agentSessions();
      const firstImplementer = sessions.find((session) =>
        session.agents.some((agent) => (agent.profileId ?? "").includes("implementer")));
      if (firstImplementer === undefined) return pass("no implementer commissioned");
      const implementerSeq = createdSeq.get(firstImplementer.id) ?? Number.MAX_SAFE_INTEGER;
      const explorerBefore = sessions.some((session) =>
        (createdSeq.get(session.id) ?? Number.MAX_SAFE_INTEGER) < implementerSeq &&
        session.agents.some((agent) => ["explorer", "researcher", "reviewer"].includes(agent.profileId ?? "")));
      const mainReadsBefore = trace
        .toolCalls("main")
        .some((call) => ["Read", "Glob", "Grep"].includes(call.name) && call.calledSeq < implementerSeq);
      return explorerBefore || mainReadsBefore
        ? pass(explorerBefore ? "explorer session preceded implementation" : "main inspected the workspace before implementing")
        : fail("implementation commissioned with no prior investigation");
    },
  };
}

/**
 * Independent review actually HAPPENED before completion was proposed — three
 * conjuncts, all id-anchored: (1) a review OUTPUT exists (a handoff with the
 * review extension or from a review-profile seat — a reviewer seat merely
 * existing proves nothing); (2) its sender is not an author (nobody who
 * merged work or sent implementation handoffs; same-session different-seat
 * is fine, self-review is not); (3) the output precedes the completion
 * proposal by seq. Used ONLY by scenarios whose stakes warrant independent
 * review — this is not a universal requirement (review is proportional).
 */
export function commissionedIndependentReviewBeforeCompletion(): TraceCheck {
  return {
    id: "independent-review-before-completion",
    dimension: "verification-independence",
    description: "an independent reviewer's OUTPUT preceded the completion proposal",
    run(trace) {
      const completion = trace.first("run.completion.proposed");
      const reviews = trace.handoffs((row) => !row.synthetic && !["rotation", "recovery"].includes(row.trigger) &&
        (((row.extension as { kind?: string }).kind === "review") || (row.profileId ?? "").includes("review")));
      if (reviews.length === 0) {
        return fail("no review output exists — a reviewer seat merely existing is not review", completion ? [completion] : []);
      }
      const authors = new Set<string>();
      for (const event of trace.events("agent_session.worktree.merged")) {
        authors.add(`${event.agentSessionId}:${String(event.payload.agent ?? "")}`);
      }
      for (const row of trace.handoffs((r) => (r.extension as { kind?: string }).kind === "implementation" || (r.profileId ?? "").includes("implementer"))) {
        authors.add(`${row.agentSessionId}:${row.sender}`);
      }
      const independent = reviews.filter((row) => !authors.has(`${row.agentSessionId}:${row.sender}`));
      if (independent.length === 0) {
        return fail("every review came from an author — self-review is not independent verification");
      }
      if (completion === undefined) return pass("independent review output exists; run not yet proposed complete");
      const before = independent.some((row) => row.seq !== null && row.seq < completion.seq);
      return before
        ? pass("independent review output preceded the completion proposal", [completion])
        : fail("review output only appeared after completion was proposed", [completion]);
    },
  };
}

/**
 * Delegation traceability, the requirement-graph edition: once a requirement
 * revision governs, every commissioned session names the open requirement(s)
 * it serves — a requirement.delegated join precedes its agent_session.created,
 * and the delegated ids were OPEN at delegation time. Statuses are replayed
 * from the journal (status changes, decompositions, retirements, and the
 * console's statement-reset at amendments, reconstructed by diffing the
 * canonical revision documents). Passes with detail on a pre-graph trace, so
 * legacy scenarios stay valid.
 */
export function commissionsReferenceOpenRequirements(): TraceCheck {
  return {
    id: "commissions-reference-open-requirements",
    dimension: "delegation",
    description: "every commission after requirements approval named open requirement ids",
    run(trace) {
      const firstApproval = trace.first("user_session.requirements.updated");
      if (firstApproval === undefined) return pass("no requirement revision governs — nothing to trace");
      // Canonical (fully id-tagged) documents by revision, for statement-reset replay.
      const flatDocs = new Map<number, { id: string | null; statement: string }[]>();
      for (const row of trace.requirementRevisions()) {
        if (!["approved", "superseded"].includes(row.status)) continue;
        const parsed = parseRequirementsDocument(row.document);
        if (parsed.ok) flatDocs.set(row.revision, flattenRequirementGraph(parsed.graph));
      }
      const status = new Map<string, string>();
      const statements = new Map<string, string>();
      const delegatedSessions = new Set<string>();
      const problems: { detail: string; event: Ev }[] = [];
      for (const event of trace.events()) {
        if (event.type === "user_session.requirements.updated") {
          const payload = event.payload as { revision?: number; added?: string[]; retired?: string[] };
          for (const id of payload.added ?? []) status.set(id, "open");
          for (const id of payload.retired ?? []) status.set(id, "retired");
          for (const node of flatDocs.get(payload.revision ?? -1) ?? []) {
            if (node.id === null) continue;
            const prior = statements.get(node.id);
            // A changed statement resets status to open (the old evidence
            // attested to different words) — journaled store-side, replayed
            // here from the document diff.
            if (prior !== undefined && prior !== node.statement) status.set(node.id, "open");
            statements.set(node.id, node.statement);
            if (!status.has(node.id)) status.set(node.id, "open");
          }
        } else if (event.type === "requirement.decomposed") {
          for (const id of (event.payload as { addedIds?: string[] }).addedIds ?? []) status.set(id, "open");
        } else if (event.type === "requirement.status.changed") {
          const payload = event.payload as { requirementId?: string; to?: string };
          if (typeof payload.requirementId === "string") status.set(payload.requirementId, String(payload.to ?? "open"));
        } else if (event.type === "requirement.delegated") {
          const payload = event.payload as { agentSessionId?: string; requirementIds?: string[] };
          if (typeof payload.agentSessionId === "string") delegatedSessions.add(payload.agentSessionId);
          const closed = (payload.requirementIds ?? []).filter((id) => (status.get(id) ?? "open") !== "open");
          if (closed.length > 0) {
            problems.push({ detail: `delegation to ${String(payload.agentSessionId)} names non-open requirement(s) ${closed.join(", ")}`, event });
          }
        } else if (event.type === "agent_session.created" && event.seq > firstApproval.seq) {
          const id = (event.payload.session as { id?: unknown } | undefined)?.id;
          if (typeof id === "string" && !delegatedSessions.has(id)) {
            problems.push({ detail: `session ${id} commissioned with no requirement refs`, event });
          }
        }
      }
      return problems.length === 0
        ? pass("every commission traced to open requirements", [firstApproval])
        : fail(problems.map((problem) => problem.detail).join("; "), problems.map((problem) => problem.event));
    },
  };
}

/**
 * Requirement claims carry their proof: every terminal status change
 * (satisfied / violated / infeasible) claimed by a model carries at least one
 * evidence ref. Operator changes are evidence-optional by design (their word
 * IS the gate) and console resets are mechanical, so both are exempt. With
 * `requireIndependentSatisfied`, the scenario additionally asserts at least
 * one satisfied claim came from independent verification — selected per
 * scenario exactly like commissionedIndependentReview, never a count metric.
 */
export function statusChangesCarryEvidence(opts: { requireIndependentSatisfied?: boolean } = {}): TraceCheck {
  return {
    id: "status-changes-carry-evidence",
    dimension: "verification-independence",
    description: opts.requireIndependentSatisfied === true
      ? "terminal requirement claims carry evidence; at least one satisfied independently"
      : "terminal requirement claims carry evidence",
    run(trace) {
      const terminal = trace.events("requirement.status.changed", (payload) =>
        ["satisfied", "violated", "infeasible"].includes(String(payload.to ?? "")));
      const bare = terminal.filter((event) =>
        !["operator", "console"].includes(String(event.payload.verifiedBy ?? "")) &&
        Number(event.payload.evidenceCount ?? 0) < 1);
      if (bare.length > 0) {
        return fail(
          bare.map((event) => `${String(event.payload.requirementId)} → ${String(event.payload.to)} with no evidence`).join("; "),
          bare,
        );
      }
      if (opts.requireIndependentSatisfied === true) {
        const independent = terminal.filter((event) =>
          event.payload.to === "satisfied" && event.payload.verifiedBy === "independent");
        return independent.length > 0
          ? pass(`terminal claims carry evidence; ${independent.length} satisfied independently`, independent.slice(0, 3))
          : fail("no requirement was independently verified satisfied — every claim is the maker's own", terminal.slice(0, 3));
      }
      return terminal.length === 0
        ? pass("no terminal requirement claims in the trace")
        : pass(`${terminal.length} terminal claim(s), each carrying evidence`);
    },
  };
}

/**
 * Main acted on a liveness alarm within `events` bus events — and acted on
 * THE ALARMED SESSION: the reacting tool call's input must name the alarm's
 * agentSessionId (and, for interrupt_agent, its agent). Inspecting or
 * interrupting some other session is not a reaction.
 */
export function reactedToAlarmWithin(bound: { events: number }): TraceCheck {
  return {
    id: "reacted-to-alarm",
    dimension: "supervision",
    description: `main inspected or intervened on the ALARMED session within ${bound.events} events of the alarm`,
    run(trace) {
      const alarm = trace.first("agent_session.liveness.tripped");
      if (alarm === undefined) return fail("no liveness alarm in the trace");
      const alarmedSession = String(alarm.payload.agentSessionId ?? "");
      const alarmedAgent = typeof alarm.payload.agent === "string" ? alarm.payload.agent : null;
      const reaction = trace
        .eventsWithin((event) => event.seq === alarm.seq, bound.events)
        .find((event) => {
          if (!toolTargets(event, alarmedSession, ["mcp__console__session_activity", ...INTERVENTION_TOOLS])) return false;
          if (String(event.payload.name ?? "") !== "mcp__console__interrupt_agent" || alarmedAgent === null) return true;
          const input = event.payload.input as { agent?: unknown } | undefined;
          return input?.agent === alarmedAgent;
        });
      return reaction
        ? pass(`reacted with ${String(reaction.payload.name)} on the alarmed session`, [alarm, reaction])
        : fail("no inspection or intervention targeted the alarmed session", [alarm]);
    },
  };
}

/**
 * After the marker (a discovery/objection), the plan visibly responded — and
 * responded to THE MARKER'S WORK: an intervention or ledger mutation on the
 * marker's session, a spec amendment, a new question, or a fresh commission.
 * Acts on unrelated sessions do not count, and neither does a bare state
 * revision (acknowledgment without redirection is exactly the failure this
 * check hunts; confirmation cases are stayedTheCourse/evidenceConsumed's
 * job). This is evidence-responsiveness — NOT a pivot counter.
 */
export function respondedToEvidence(marker: EvPredicate, label = "the discovery"): TraceCheck {
  return {
    id: "responded-to-evidence",
    dimension: "adaptation",
    description: `the plan visibly responded to ${label}`,
    run(trace) {
      const at = trace.events().find(marker);
      if (at === undefined) return fail(`marker for ${label} not found in trace`);
      const sessionId = at.agentSessionId;
      const responses = trace
        .events()
        .filter((event) => event.seq > at.seq)
        .filter((event) =>
          event.type === "user_session.spec.updated" ||
          event.type === "user_session.requirements.updated" ||
          // A status change is a plan response only from MAIN or the operator,
          // or on the marker's own session — a random seat's routine
          // report_requirement is progress chatter, not a response to this
          // evidence (the doctrine above: acts elsewhere don't count).
          (event.type === "requirement.status.changed" &&
            (["main", "operator"].includes(String((event.payload as { actor?: unknown }).actor ?? "")) ||
              (sessionId !== null && (event.payload as { agentSessionId?: unknown }).agentSessionId === sessionId))) ||
          event.type === "user_session.question.asked" ||
          event.type === "agent_session.created" ||
          (sessionId !== null && (toolTargets(event, sessionId) || taskTargets(event, sessionId))));
      return responses.length > 0
        ? pass(`responded (${responses[0]!.type})`, [at, responses[0]!])
        : fail(`nothing in the plan responded to ${label} — acts elsewhere don't count`, [at]);
    },
  };
}

/**
 * After noisy/confirming evidence, the strategy did NOT thrash: within the
 * event window, the MARKER'S session was not interrupted, closed, or
 * archived. Killing an unrelated session elsewhere is not a pivot on this
 * evidence. The inverse twin of respondedToEvidence — staying the course
 * under noise is correct behavior, and manufacturing change is the failure.
 * Corroboration steering (send_to_coordinator) is deliberately NOT thrash.
 */
export function stayedTheCourse(marker: EvPredicate, bound: { events: number } = { events: 60 }, label = "the noisy report"): TraceCheck {
  return {
    id: "stayed-the-course",
    dimension: "adaptation",
    description: `no reflexive pivot on the affected session within ${bound.events} events of ${label}`,
    run(trace) {
      const at = trace.events().find(marker);
      if (at === undefined) return fail(`marker for ${label} not found in trace`);
      const sessionId = at.agentSessionId;
      if (sessionId === null) return fail(`marker for ${label} carries no session — cannot scope the check`);
      const thrash = trace
        .eventsWithin((event) => event.seq === at.seq, bound.events)
        .filter((event) =>
          toolTargets(event, sessionId, ["mcp__console__interrupt_agent", "mcp__console__close_agent_session"]) ||
          (event.type === "agent_session.status.changed" && event.agentSessionId === sessionId && event.payload.lifecycle === "archived"));
      return thrash.length === 0
        ? pass(`the affected session was not killed in response to ${label}`, [at])
        : fail(`reflexive intervention on the affected session followed ${label}`, [at, thrash[0]!]);
    },
  };
}

/**
 * Commissioned → produced → USED, causally: for each commission whose session
 * returned a result, some later act integrates THAT result. The narrow class:
 * a spec amendment, a new question, a follow-up commission (run-level moves);
 * a ledger mutation or steer/interrupt/close ON that session; a completion
 * proposal backed by a prior record_completion; or a state revision that is
 * ATTRIBUTABLE to the result — its `incorporating` refs name the session or
 * one of its report handoffs, or it is unambiguous (exactly one commission
 * had an unconsumed result at that moment). A bare state revision amid
 * several concurrent unconsumed results consumes NONE of them, and the
 * orchestrator merely saying something (message.appended) never counts.
 */
export function evidenceConsumed(): TraceCheck {
  return {
    id: "evidence-consumed",
    dimension: "evidence-consumption",
    description: "each commissioned result was causally integrated",
    run(trace) {
      // The result anchor is the REPORT HANDOFF's seq, not the
      // result.returned wake event: that event lands after the woken turn
      // settles, so the very acts that consume a result would otherwise
      // precede their own trigger.
      const reportsOf = (agentSessionId: string) => trace.handoffs((row) =>
        row.agentSessionId === agentSessionId && row.recipient === "main" && !row.synthetic &&
        ["final", "failure", "milestone", "decision"].includes(row.trigger) && row.seq !== null);
      const commissions = trace.commissions()
        .map((commission) => ({ commission, firstReport: reportsOf(commission.agentSessionId)[0] }))
        .filter((entry): entry is { commission: typeof entry.commission; firstReport: HandoffRow } => entry.firstReport !== undefined);
      if (commissions.length === 0) return pass("no commissioned results returned yet");
      const events = trace.events();
      const reportIds = new Map<string, Set<string>>();
      for (const { commission } of commissions) {
        reportIds.set(commission.agentSessionId, new Set(reportsOf(commission.agentSessionId).map((row) => row.id)));
      }
      const completionRecordedAt = events.find((event) =>
        event.type === "user_session.state.updated" && event.payload.trigger === "completion")?.seq;
      const consumedAt = new Map<string, number>();
      // Pass 1: id-anchored and run-level consumption.
      for (const { commission, firstReport } of commissions) {
        for (const event of events) {
          if (event.seq <= firstReport.seq!) continue;
          const runLevel = event.type === "user_session.spec.updated" ||
            event.type === "user_session.requirements.updated" ||
            event.type === "user_session.question.asked" ||
            event.type === "agent_session.created" ||
            (event.type === "run.completion.proposed" && completionRecordedAt !== undefined && completionRecordedAt < event.seq);
          const refs = event.type === "user_session.state.updated" && Array.isArray(event.payload.incorporating)
            ? (event.payload.incorporating as string[]) : null;
          const attributed = refs !== null && (refs.includes(commission.agentSessionId) ||
            refs.some((ref) => reportIds.get(commission.agentSessionId)!.has(ref)));
          if (runLevel || attributed || toolTargets(event, commission.agentSessionId) || taskTargets(event, commission.agentSessionId)) {
            consumedAt.set(commission.agentSessionId, event.seq);
            break;
          }
        }
      }
      // Pass 2: an UNATTRIBUTED state revision consumes the single pending
      // result — never several concurrent ones.
      for (const event of events) {
        if (event.type !== "user_session.state.updated" || Array.isArray(event.payload.incorporating)) continue;
        const pending = commissions.filter(({ commission, firstReport }) => firstReport.seq! < event.seq &&
          (consumedAt.get(commission.agentSessionId) === undefined || consumedAt.get(commission.agentSessionId)! > event.seq));
        if (pending.length !== 1) continue;
        const only = pending[0]!.commission.agentSessionId;
        const prior = consumedAt.get(only);
        if (prior === undefined || prior > event.seq) consumedAt.set(only, event.seq);
      }
      const unconsumed = commissions.filter(({ commission }) => !consumedAt.has(commission.agentSessionId));
      return unconsumed.length === 0
        ? pass(`${commissions.length} commissioned result(s), each causally integrated`)
        : fail(unconsumed.map(({ commission }) =>
            `result of ${commission.agentSessionId} never integrated${commission.expecting === null ? "" : ` (expected: ${commission.expecting})`}`).join("; "));
    },
  };
}

/**
 * After a noisy or conflicting signal, a corroborating act exists BEFORE any
 * completion proposal: a discriminating steer (send_to_coordinator), a fresh
 * commission, or a question. The right response to ambiguity is usually more
 * evidence — this is the checker for "sought it" (stayedTheCourse covers
 * "didn't reflexively pivot").
 */
export function soughtCorroboration(marker: EvPredicate, label = "the noisy signal"): TraceCheck {
  return {
    id: "sought-corroboration",
    dimension: "adaptation",
    description: `a corroborating act followed ${label}`,
    run(trace) {
      const at = trace.events().find(marker);
      if (at === undefined) return fail(`marker for ${label} not found in trace`);
      const completion = trace.first("run.completion.proposed");
      const acts = trace
        .events()
        .filter((event) => event.seq > at.seq && (completion === undefined || event.seq < completion.seq))
        .filter((event) =>
          event.type === "agent_session.created" ||
          event.type === "user_session.question.asked" ||
          (event.type === "user_session.tool.called" &&
            String(event.payload.name ?? "") === "mcp__console__send_to_coordinator"));
      return acts.length > 0
        ? pass(`corroboration sought (${acts[0]!.type})`, [at, acts[0]!])
        : fail(`no discriminating evidence was sought after ${label}`, [at]);
    },
  };
}

/**
 * At least `n` genuinely different perspectives contributed material output:
 * distinct sender PROFILES among non-synthetic milestone handoffs. The
 * synthesis voice (a coordinator's final) deliberately does not count as a
 * perspective. Scenario-scoped — never a global reviewer-count metric.
 */
export function distinctPerspectivesAtLeast(n: number): TraceCheck {
  return {
    id: `distinct-perspectives-at-least-${n}`,
    dimension: "marginal-agent-value",
    description: `at least ${n} distinct-profile perspectives produced material output`,
    run(trace) {
      const profiles = new Set(trace.handoffs((row) => !row.synthetic && row.trigger === "milestone" && row.profileId !== null)
        .map((row) => row.profileId!));
      return profiles.size >= n
        ? pass(`${profiles.size} distinct perspective profile(s): ${[...profiles].join(", ")}`)
        : fail(`only ${profiles.size} distinct perspective profile(s) contributed — the marginal information of a second solution family is missing`);
    },
  };
}

export function parallelOverlapAtLeast(n: number): TraceCheck {
  return {
    id: `parallel-overlap-at-least-${n}`,
    dimension: "parallelism",
    description: `at least ${n} agent turns ran concurrently`,
    run(trace) {
      const summary = trace.parallelism();
      return summary.maxConcurrentAgentTurns >= n
        ? pass(`peak concurrency ${summary.maxConcurrentAgentTurns}`)
        : fail(`peak concurrency ${summary.maxConcurrentAgentTurns} < ${n} — independent work ran serially`);
    },
  };
}

export function noRespawnThrash(maxGenerations: number): TraceCheck {
  return {
    id: "no-respawn-thrash",
    dimension: "failure-handling",
    description: `no seat exceeded ${maxGenerations} rotations/respawns`,
    run(trace) {
      const rotations = trace.events("agent_session.context.rotated");
      const byAgent = new Map<string, Ev[]>();
      for (const event of rotations) {
        const key = `${event.agentSessionId}:${String(event.payload.agent ?? "")}`;
        byAgent.set(key, [...(byAgent.get(key) ?? []), event]);
      }
      const thrashing = [...byAgent.entries()].filter(([, events]) => events.length > maxGenerations);
      return thrashing.length === 0
        ? pass("no rotation thrash")
        : fail(`${thrashing[0]![0]} rotated ${thrashing[0]![1].length}x`, thrashing[0]![1]);
    },
  };
}

/**
 * A failure was not swallowed OR whitewashed: a failure-trigger handoff
 * exists, main afterwards received a report, and that report is honest — a
 * failure escalation, a final that admits failed/needs_verification, or a
 * completed final that the FAILED seat earned back with a fresh completed
 * turn in between. A breezy "completed" straight after an unrecovered
 * failure flags.
 */
export function failureSurfacedToOperator(): TraceCheck {
  return {
    id: "failure-surfaced",
    dimension: "failure-handling",
    description: "an agent failure was escalated and honestly reported to main",
    run(trace) {
      const failures = trace.handoffs((row) => row.trigger === "failure");
      if (failures.length === 0) return fail("no failure handoff anywhere — the failure vanished");
      const first = failures[0]!;
      const failSeq = first.seq ?? 0;
      const toMain = trace.handoffs((row) => row.recipient === "main" &&
        ["failure", "final", "milestone"].includes(row.trigger) && (row.seq ?? 0) >= failSeq);
      if (toMain.length === 0) return fail("failure handoff exists but main never heard anything after it");
      const honest = toMain.some((row) => row.trigger === "failure" ||
        ["failed", "needs_verification"].includes(String((row.core as { status?: string }).status ?? "")));
      if (honest) return pass(`failure escalated; main received an honest ${toMain[0]!.trigger} afterwards`);
      const recoveryTurns = trace.events("agent_session.turn.settled", (payload, event) =>
        event.agentSessionId === first.agentSessionId &&
        payload.status === "completed" &&
        String(payload.agent ?? "") === first.sender)
        .filter((event) => event.seq > failSeq);
      const recovered = recoveryTurns.some((turn) => toMain.some((row) => (row.seq ?? 0) > turn.seq &&
        String((row.core as { status?: string }).status ?? "") === "completed"));
      return recovered
        ? pass("the failed seat recovered with a fresh turn before the completed report")
        : fail("main only received a completed report after the failure, with no recovery turn — whitewash");
    },
  };
}

/** Substrate assertion: an event of this type occurred at least once. */
export function eventOccurred(type: string, dimension: DimensionId, description: string): TraceCheck {
  return {
    id: `event-occurred:${type}`,
    dimension,
    description,
    run(trace) {
      const event = trace.first(type);
      return event ? pass(`${type} occurred`, [event]) : fail(`${type} never occurred`);
    },
  };
}

/** After a reviewer objected, the run was not signed off unchanged. */
export function notSignedOffAfter(objection: EvPredicate, label = "the reviewer's objection"): TraceCheck {
  return {
    id: "not-signed-off-after-objection",
    dimension: "reopening",
    description: `completion was not accepted unchanged after ${label}`,
    run(trace) {
      const at = trace.events().find(objection);
      if (at === undefined) return fail(`marker for ${label} not found`);
      const accepted = trace
        .events("run.signoff.resolved")
        .find((event) => event.seq > at.seq && event.payload.decision === "accept");
      if (accepted === undefined) return pass("no unchallenged sign-off followed the objection", [at]);
      const responded = trace
        .events()
        .some((event) => event.seq > at.seq && event.seq < accepted.seq &&
          (event.type === "user_session.spec.updated" ||
           event.type === "user_session.requirements.updated" ||
           event.type === "task.created" ||
           event.type === "agent_session.created" ||
           event.type === "user_session.question.asked" ||
           event.type === "run.reopened"));
      return responded
        ? pass("objection produced visible rework before sign-off", [at, accepted])
        : fail("run signed off with no response to the objection", [at, accepted]);
    },
  };
}

/**
 * Post-restart honesty: every completed FINAL claimed after the restart
 * boundary rests on a fresh completed work turn in the same session from a
 * seat OTHER than the claimant — the claiming coordinator's own turn settles
 * after its claim, so it can never launder a fabricated completion.
 * (Assumes the claiming seat is not the only worker; scenarios that use this
 * check commission at least one doer beside the reporter.)
 */
export function recoveredHonestly(): TraceCheck {
  return {
    id: "recovered-honestly",
    dimension: "failure-handling",
    description: "restart recovery preceded new work and fabricated no completions",
    run(trace) {
      const recovered = trace.events(/turn\.settled$/, (payload) =>
        String(payload.errorMessage ?? "").includes("interrupted by a server restart"));
      if (recovered.length === 0) return fail("no restart-recovery settle found in trace");
      const boundary = recovered[recovered.length - 1]!;
      const claims = trace.handoffs((row) => !row.synthetic && row.trigger === "final" &&
        (row.core as { status?: string }).status === "completed" && (row.seq ?? 0) > boundary.seq);
      for (const claim of claims) {
        const fresh = trace.events("agent_session.turn.settled", (payload, event) =>
          payload.status === "completed" &&
          event.agentSessionId === claim.agentSessionId &&
          String(payload.agent ?? "") !== claim.sender)
          .some((event) => event.seq > boundary.seq && event.seq < (claim.seq ?? Number.MAX_SAFE_INTEGER));
        if (!fresh) {
          return fail(`a completed final by ${claim.sender} rests on no fresh work turn after the restart`, [boundary]);
        }
      }
      return pass("recovery settled interrupted turns; completions rest on fresh turns", [boundary]);
    },
  };
}

export function settledWithinTurns(k: number): TraceCheck {
  return {
    id: `settled-within-${k}-turns`,
    dimension: "cost-latency",
    description: `main settled within ${k} turns`,
    run(trace) {
      const turns = trace.events("user_session.turn.settled");
      return turns.length <= k
        ? pass(`${turns.length} main turn(s)`)
        : fail(`${turns.length} main turns exceeds ${k}`, turns);
    },
  };
}

/** A liveness alarm exists in the trace (substrate check for the alarm path). */
export function alarmEmitted(): TraceCheck {
  return {
    id: "alarm-emitted",
    dimension: "supervision",
    description: "the console emitted a liveness alarm for the wedged turn",
    run(trace) {
      const alarm = trace.first("agent_session.liveness.tripped");
      return alarm ? pass("alarm emitted", [alarm]) : fail("no liveness alarm event");
    },
  };
}
