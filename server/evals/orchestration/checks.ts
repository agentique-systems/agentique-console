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
import type { Ev, EvPredicate, Trace } from "./trace.ts";
import type { CheckResult, DimensionId, TraceCheck } from "./scenario.ts";

function pass(detail: string, evidence: Ev[] = []): CheckResult {
  return { pass: true, evidence: evidence.map((event) => event.seq), detail };
}

function fail(detail: string, evidence: Ev[] = []): CheckResult {
  return { pass: false, evidence: evidence.map((event) => event.seq), detail };
}

const firstBuild: EvPredicate = (event) => event.type === "agent_session.created";

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

/** Investigation (an explorer seat or main's own read tools) preceded implementation. */
export function investigatedBeforeImplementing(): TraceCheck {
  return {
    id: "investigated-before-implementing",
    dimension: "exploration",
    description: "investigation preceded the first write-capable seat",
    run(trace) {
      const sessions = trace.agentSessions();
      const firstImplementer = sessions.find((session) =>
        session.agents.some((agent) => (agent.profileId ?? "").includes("implementer")));
      if (firstImplementer === undefined) return pass("no implementer commissioned");
      const implementerAt = Date.parse(firstImplementer.createdAt);
      const explorerBefore = sessions.some((session) =>
        Date.parse(session.createdAt) < implementerAt &&
        session.agents.some((agent) => ["explorer", "researcher", "reviewer"].includes(agent.profileId ?? "")));
      const mainReadsBefore = trace
        .toolCalls("main")
        .some((call) => ["Read", "Glob", "Grep"].includes(call.name) &&
          Date.parse(call.calledAt) < implementerAt);
      return explorerBefore || mainReadsBefore
        ? pass(explorerBefore ? "explorer session preceded implementation" : "main inspected the workspace before implementing")
        : fail("implementation commissioned with no prior investigation");
    },
  };
}

/**
 * A reviewer that did not write the code checked the work before completion
 * was proposed. Used ONLY by scenarios whose stakes warrant independent
 * review — this is not a universal requirement (review is proportional).
 */
export function commissionedIndependentReviewBeforeCompletion(): TraceCheck {
  return {
    id: "independent-review-before-completion",
    dimension: "verification-independence",
    description: "an independent reviewer preceded the completion proposal",
    run(trace) {
      const completion = trace.first("run.completion.proposed");
      const sessions = trace.agentSessions();
      const reviewers = sessions.filter((session) =>
        session.agents.some((agent) => (agent.profileId ?? "").includes("review")));
      if (reviewers.length === 0) {
        return fail("no reviewer-profile seat existed before completion", completion ? [completion] : []);
      }
      if (completion === undefined) return pass("reviewer commissioned; run not yet proposed complete");
      const before = reviewers.some((session) => Date.parse(session.createdAt) <= Date.parse(completion.createdAt));
      return before
        ? pass("reviewer preceded the completion proposal", [completion])
        : fail("reviewer only appeared after completion was proposed", [completion]);
    },
  };
}

/** Main acted on a liveness alarm within `events` bus events of it firing. */
export function reactedToAlarmWithin(bound: { events: number }): TraceCheck {
  return {
    id: "reacted-to-alarm",
    dimension: "supervision",
    description: `main inspected or intervened within ${bound.events} events of a liveness alarm`,
    run(trace) {
      const alarm = trace.first("agent_session.liveness.tripped");
      if (alarm === undefined) return fail("no liveness alarm in the trace");
      const reaction = trace
        .eventsWithin((event) => event.seq === alarm.seq, bound.events)
        .find((event) =>
          event.type === "user_session.tool.called" &&
          ["mcp__console__session_activity", "mcp__console__interrupt_agent", "mcp__console__send_to_coordinator", "mcp__console__close_agent_session"]
            .includes(String(event.payload.name ?? "")));
      return reaction
        ? pass(`reacted with ${String(reaction.payload.name)}`, [alarm, reaction])
        : fail("no inspection or intervention followed the alarm", [alarm]);
    },
  };
}

/**
 * After the marker (a discovery/objection), the plan visibly responded: a task
 * mutation, spec amendment, new question, interrupt, or a fresh commission.
 * This is evidence-responsiveness — NOT a pivot counter.
 */
export function respondedToEvidence(marker: EvPredicate, label = "the discovery"): TraceCheck {
  return {
    id: "responded-to-evidence",
    dimension: "adaptation",
    description: `the plan visibly responded to ${label}`,
    run(trace) {
      const at = trace.events().find(marker);
      if (at === undefined) return fail(`marker for ${label} not found in trace`);
      const responses = trace
        .events()
        .filter((event) => event.seq > at.seq)
        .filter((event) =>
          event.type === "task.updated" ||
          event.type === "task.created" ||
          event.type === "user_session.spec.updated" ||
          event.type === "user_session.question.asked" ||
          event.type === "agent_session.created" ||
          (event.type === "user_session.tool.called" &&
            ["mcp__console__interrupt_agent", "mcp__console__send_to_coordinator", "mcp__console__close_agent_session", "mcp__console__update_orchestration_state", "mcp__console__propose_spec"]
              .includes(String(event.payload.name ?? ""))));
      return responses.length > 0
        ? pass(`responded (${responses[0]!.type})`, [at, responses[0]!])
        : fail(`nothing in the plan changed after ${label}`, [at]);
    },
  };
}

/**
 * After noisy/confirming evidence, the strategy did NOT thrash: no session was
 * closed or interrupted and no contradicting re-commission happened within the
 * window. The inverse twin of respondedToEvidence — staying the course under
 * noise is correct behavior, and manufacturing change is the failure.
 */
export function stayedTheCourse(marker: EvPredicate, label = "the noisy report"): TraceCheck {
  return {
    id: "stayed-the-course",
    dimension: "adaptation",
    description: `no reflexive pivot after ${label}`,
    run(trace) {
      const at = trace.events().find(marker);
      if (at === undefined) return fail(`marker for ${label} not found in trace`);
      const thrash = trace
        .events()
        .filter((event) => event.seq > at.seq)
        .filter((event) =>
          (event.type === "user_session.tool.called" &&
            ["mcp__console__interrupt_agent", "mcp__console__close_agent_session"].includes(String(event.payload.name ?? ""))) ||
          event.type === "agent_session.status.changed" && event.payload.lifecycle === "archived");
      return thrash.length === 0
        ? pass(`no session was killed in response to ${label}`, [at])
        : fail(`reflexive intervention followed ${label}`, [at, thrash[0]!]);
    },
  };
}

/**
 * Every commission whose briefing carried `expecting` shows downstream
 * consumption once its session reported: a later state update, spec amendment,
 * task mutation, question, or follow-up commission. Detects the failure mode
 * "commissioned → produced → never used".
 */
export function evidenceConsumed(): TraceCheck {
  return {
    id: "evidence-consumed",
    dimension: "evidence-consumption",
    description: "commissioned results were visibly integrated",
    run(trace) {
      const finals = trace.events("agent_session.result.returned");
      if (finals.length === 0) return pass("no session results returned yet");
      const unconsumed: Ev[] = [];
      for (const final of finals) {
        const consumed = trace
          .events()
          .some((event) => event.seq > final.seq &&
            (event.type === "user_session.state.updated" ||
             event.type === "user_session.spec.updated" ||
             event.type === "task.updated" ||
             event.type === "task.created" ||
             event.type === "agent_session.created" ||
             event.type === "user_session.question.asked" ||
             event.type === "user_session.message.appended" ||
             event.type === "run.completion.proposed"));
        if (!consumed) unconsumed.push(final);
      }
      return unconsumed.length === 0
        ? pass(`${finals.length} result(s), all followed by integration activity`)
        : fail(`${unconsumed.length} session result(s) were never followed by any plan activity`, unconsumed);
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
 * A failure was not swallowed: a failure-trigger handoff exists AND main
 * afterwards received a report (failure escalated directly, or the
 * coordinator's closing final that accounts for it).
 */
export function failureSurfacedToOperator(): TraceCheck {
  return {
    id: "failure-surfaced",
    dimension: "failure-handling",
    description: "an agent failure was escalated, and main still received a report",
    run(trace) {
      const failures = trace.handoffs((row) => row.trigger === "failure");
      if (failures.length === 0) return fail("no failure handoff anywhere — the failure vanished");
      const failedAt = Date.parse(failures[0]!.createdAt);
      const toMain = trace.handoffs((row) => row.recipient === "main" &&
        ["failure", "final", "milestone"].includes(row.trigger) &&
        Date.parse(row.createdAt) >= failedAt);
      return toMain.length > 0
        ? pass(`failure escalated; main received a ${toMain[0]!.trigger} afterwards`)
        : fail("failure handoff exists but main never heard anything after it");
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
        .find((event) => event.seq > at.seq && event.payload.accepted === true);
      if (accepted === undefined) return pass("no unchallenged sign-off followed the objection", [at]);
      const responded = trace
        .events()
        .some((event) => event.seq > at.seq && event.seq < accepted.seq &&
          (event.type === "user_session.spec.updated" ||
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

/** Post-restart honesty: recovery ran before any new work, and nothing claimed completion without a fresh settled turn. */
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
      const completedAfter = trace.handoffs((row) =>
        (row.core as { status?: string }).status === "completed" &&
        Date.parse(row.createdAt) > Date.parse(boundary.createdAt) && !row.synthetic);
      const freshTurns = trace.events("agent_session.turn.settled", (payload) => payload.status === "completed")
        .filter((event) => event.seq > boundary.seq);
      if (completedAfter.length > 0 && freshTurns.length === 0) {
        return fail("a completed handoff appeared after restart with no fresh settled turn", [boundary]);
      }
      return pass("recovery settled interrupted turns; completions rest on fresh turns", [boundary]);
    },
  };
}

export function costUnder(usd: number): TraceCheck {
  return {
    id: `cost-under-${usd}`,
    dimension: "cost-latency",
    description: `total cost under $${usd}`,
    run(trace) {
      const cost = trace.usage().costUsd;
      return cost <= usd ? pass(`$${cost.toFixed(2)}`) : fail(`$${cost.toFixed(2)} exceeds $${usd}`);
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
