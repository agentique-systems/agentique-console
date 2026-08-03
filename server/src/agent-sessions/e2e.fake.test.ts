/**
 * The scripted full loop: operator asks → orchestrator delegates via the
 * console MCP tools → specialists collaborate through @mentions → unaddressed
 * reply routes to the orchestrator → session settles → wake digest → the
 * orchestrator relays results to the operator. All credential-free.
 */
import { describe, expect, it } from "vitest";
import type { CompiledTool, SdkToolResult } from "../sdk/types.ts";
import {
  initMessage,
  successMessage,
  textMessage,
  toolResultMessage,
  toolUseMessage,
} from "../sdk/fake.ts";
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

function toolJson(result: SdkToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("delegation e2e (fake SDK)", () => {
  it("runs delegate → collaborate → settle → wake → relay", { timeout: 15000 }, async () => {
    let orchestratorTurns = 0;
    const box: { h?: DelegationHarness } = {};
    const prompts: string[] = [];

    const h = makeDelegationHarness(async function* (options, tools) {
      const prompt = box.h?.fake.captured.prompts.at(-1) ?? "";
      prompts.push(prompt);
      if (options.outputFormat === undefined) {
        // --- Orchestrator turns ---
        orchestratorTurns += 1;
        yield initMessage("orch-sdk");
        if (orchestratorTurns === 1) {
          const create = toolByName(tools, "create_agent_session");
          const created = toolJson(
            await create.handler(
              {
                title: "Find the entry point",
                mode: "execute",
                agents: [
                  { name: "scout", preset: "explorer" },
                  { name: "coder", preset: "implementer" },
                ],
                briefing: "@scout find the entry point of this repo",
              },
              {},
            ),
          ) as { agentSessionId: string; participants: string[] };
          expect(created.participants).toEqual(["scout", "coder"]);
          yield textMessage("Delegated to scout and coder; I'll report back.");
        } else {
          yield textMessage("They finished: the entry point is main.ts.");
        }
        yield successMessage(undefined, { session_id: "orch-sdk" });
        return;
      }
      // --- Specialist turns ---
      const seat = /You are \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "unknown";
      yield initMessage(`${seat}-sdk`);
      if (seat === "scout") {
        yield toolUseMessage("tu_s1", "Grep", { pattern: "main" });
        yield toolResultMessage("tu_s1", "main.ts:1");
        yield successMessage(
          {
            message:
              "@coder the entry point is main.ts — confirm the build target",
            to: null,
          },
          { session_id: "scout-sdk" },
        );
      } else {
        yield successMessage(
          { message: "Confirmed: main.ts builds with tsc.", to: null },
          { session_id: `${seat}-sdk` },
        );
      }
    });
    box.h = h;

    const sessionId = h.addUserSession();
    const events = collectUntil(
      h.bus,
      (e) =>
        e.type === "user_session.message" &&
        (e.payload as { message: { text: string } }).message.text.startsWith(
          "They finished",
        ),
      8000,
    );

    h.runner.postOperatorMessage(sessionId, "where does this repo start?");
    const all = await events;

    const types = all.map((e) => e.type);
    // The delegation lifecycle, in order of first occurrence.
    for (const expected of [
      "agent_session.created",
      "flow.delegation",
      "agent_session.message",
      "agent_session.routed",
      "agent_session.turn.started",
      "agent_session.tool.call",
      "agent_session.tool.result",
      "agent_session.turn.settled",
      "flow.result",
      "user_session.turn.started",
      "user_session.message",
    ]) {
      expect(types).toContain(expected);
    }

    // Two specialist turns ran: scout then coder.
    const turnStarts = all.filter((e) => e.type === "agent_session.turn.started");
    expect(
      turnStarts.map((e) => (e.payload as { participant: string }).participant),
    ).toEqual(["scout", "coder"]);

    // Hop accounting: briefing (orchestrator, 0) → scout→coder (1) → coder→orchestrator (1).
    const routed = all.filter((e) => e.type === "agent_session.routed");
    expect(
      routed.map((e) => (e.payload as { hopCount: number }).hopCount),
    ).toEqual([0, 1, 1]);
    expect(
      routed.map(
        (e) =>
          (e.payload as { decisions: { recipient: string }[] }).decisions.map(
            (d) => d.recipient,
          ),
      ),
    ).toEqual([["scout"], ["coder"], ["orchestrator"]]);

    // The wake turn carries the transcript digest.
    const wakeTurn = all.find(
      (e) =>
        e.type === "user_session.turn.started" &&
        (e.payload as { trigger: string }).trigger === "wake",
    );
    expect(wakeTurn).toBeDefined();
    const wakePrompt = prompts.find((p) => p.includes("has gone quiet"));
    expect(wakePrompt).toContain("[scout]:");
    expect(wakePrompt).toContain("[coder]:");
    expect(wakePrompt).toContain("main.ts");

    // Watermarks came to rest: nothing pending, nothing unseen.
    const agentSessions = h.host.listForUserSession(sessionId);
    expect(agentSessions).toHaveLength(1);
    expect(agentSessions[0]).toMatchObject({ status: "idle", unseenCount: 0 });
    const row = h.repo.getAgentSession(agentSessions[0]!.id);
    expect(row?.owedToOrchestrator).toBe(false);

    // Specialist resume ids persisted at settle.
    expect(
      h.repo.getParticipant(agentSessions[0]!.id, "scout")?.sdkSessionId,
    ).toBe("scout-sdk");
  });

  it("brakes runaway agent↔agent mention loops at the hop limit", { timeout: 15000 }, async () => {
    const box: { h?: DelegationHarness } = {};
    let orchestratorTurns = 0;
    const h = makeDelegationHarness(
      async function* (options, tools) {
        const prompt = box.h?.fake.captured.prompts.at(-1) ?? "";
        if (options.outputFormat === undefined) {
          orchestratorTurns += 1;
          yield initMessage("orch-sdk");
          if (orchestratorTurns === 1) {
            const create = toolByName(tools, "create_agent_session");
            await create.handler(
              {
                title: "Ping pong",
                mode: "execute",
                agents: [
                  { name: "alpha", instructions: "ping" },
                  { name: "beta", instructions: "pong" },
                ],
                briefing: "@alpha start",
              },
              {},
            );
            yield textMessage("Delegated.");
          } else {
            yield textMessage("Noted the stall.");
          }
          yield successMessage(undefined, { session_id: "orch-sdk" });
          return;
        }
        const seat = /You are \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "unknown";
        yield initMessage(`${seat}-sdk`);
        const other = seat === "alpha" ? "beta" : "alpha";
        yield successMessage(
          { message: `@${other} ping`, to: null },
          { session_id: `${seat}-sdk` },
        );
      },
      { hopLimit: 2 },
    );
    box.h = h;

    const sessionId = h.addUserSession();
    const collected = collectUntil(
      h.bus,
      (e) =>
        e.type === "agent_session.message" &&
        (e.payload as { message: { text: string } }).message.text.includes(
          "hop limit",
        ),
      8000,
    );
    h.runner.postOperatorMessage(sessionId, "go");
    const all = await collected;

    const brake = all.at(-1);
    expect(
      (brake?.payload as { message: { speaker: { kind: string } } }).message
        .speaker.kind,
    ).toBe("system");

    // After the brake the floor lands with the orchestrator, and a wake follows.
    await collectUntil(
      h.bus,
      (e) =>
        e.type === "user_session.turn.started" &&
        (e.payload as { trigger: string }).trigger === "wake",
      8000,
    );
  });
});
