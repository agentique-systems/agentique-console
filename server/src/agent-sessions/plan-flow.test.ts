/**
 * The plan_execute agent-session flow: a planning-phase seat's ExitPlanMode
 * becomes a plan message routed to the orchestrator; approve_agent_plan flips
 * the phase and the seat proceeds with real permissions on its next turn.
 */
import { describe, expect, it } from "vitest";
import type { CompiledTool } from "../sdk/types.ts";
import { initMessage, permissionContext, successMessage, textMessage } from "../sdk/fake.ts";
import {
  collectUntil,
  makeDelegationHarness,
  type DelegationHarness,
} from "../test-helpers.ts";

function toolByName(tools: CompiledTool[], name: string): CompiledTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`fake program: no compiled tool ${name}`);
  return tool;
}

describe("agent-session plan flow (fake SDK)", () => {
  it("captures the seat plan, wakes the orchestrator, approves, executes", { timeout: 15000 }, async () => {
    let orchestratorTurns = 0;
    let plannerTurns = 0;
    const box: { h?: DelegationHarness } = {};
    const seatModes: (string | undefined)[] = [];

    const h = makeDelegationHarness(async function* (options, tools) {
      const prompt = box.h?.fake.captured.prompts.at(-1) ?? "";
      if (options.outputFormat === undefined) {
        orchestratorTurns += 1;
        yield initMessage("orch-sdk");
        if (orchestratorTurns === 1) {
          const create = toolByName(tools, "create_agent_session");
          await create.handler(
            {
              title: "Careful build",
              mode: "plan_execute",
              agents: [{ name: "builder", preset: "implementer" }],
              briefing: "@builder plan the refactor before touching anything",
            },
            {},
          );
          yield textMessage("Delegated with a plan gate.");
        } else if (prompt.includes("PLAN:")) {
          const approve = toolByName(tools, "approve_agent_plan");
          const sessions = box.h!.host.listForUserSession(sessionIdBox.id);
          await approve.handler(
            {
              agentSessionId: sessions[0]!.id,
              participant: "builder",
              decision: "approve",
            },
            {},
          );
          yield textMessage("Approved builder's plan.");
        } else {
          yield textMessage("Builder finished the refactor.");
        }
        yield successMessage(undefined, { session_id: "orch-sdk" });
        return;
      }
      // --- builder turns ---
      plannerTurns += 1;
      seatModes.push(options.permissionMode);
      yield initMessage("builder-sdk");
      if (options.permissionMode === "plan") {
        yield textMessage("Plan: rename module, fix imports, run tests.");
        const result = await options.canUseTool?.(
          "ExitPlanMode",
          {},
          permissionContext(),
        );
        expect(result?.behavior).toBe("deny");
        yield successMessage(
          { message: null, to: null },
          { session_id: "builder-sdk" },
        );
      } else {
        yield successMessage(
          { message: "Refactor done, tests green.", to: null },
          { session_id: "builder-sdk" },
        );
      }
    });
    box.h = h;
    const sessionIdBox = { id: "" };

    const userSessionId = h.addUserSession();
    sessionIdBox.id = userSessionId;
    const done = collectUntil(
      h.bus,
      (e) =>
        e.type === "user_session.message" &&
        (e.payload as { message: { text: string } }).message.text.startsWith(
          "Builder finished",
        ),
      12000,
    );
    h.runner.postOperatorMessage(userSessionId, "refactor the parser carefully");
    const all = await done;

    // The plan was captured off the seat's last assistant text (D9 fallback).
    const captured = all.find((e) => e.type === "agent_session.plan.captured");
    expect(captured?.payload).toMatchObject({
      participant: "builder",
      plan: "Plan: rename module, fix imports, run tests.",
    });

    // Plan message rides the transcript as kind:'plan' addressed to the orchestrator.
    const planMessage = all.find(
      (e) =>
        e.type === "agent_session.message" &&
        (e.payload as { message: { kind: string } }).message.kind === "plan",
    );
    expect(planMessage?.payload).toMatchObject({
      message: { to: "orchestrator", speaker: { name: "builder" } },
    });

    // approve_agent_plan flipped the phase.
    const phase = all.find((e) => e.type === "agent_session.phase");
    expect(phase?.payload).toMatchObject({ phase: "executing" });

    // The seat ran planning first, then executing with real permissions.
    expect(seatModes[0]).toBe("plan");
    expect(seatModes.at(-1)).toBe("bypassPermissions");
    expect(plannerTurns).toBeGreaterThanOrEqual(2);
  });
});
