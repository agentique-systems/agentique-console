/**
 * "renderer and page must agree the exact module interface BEFORE either writes
 * code — that contract is the handoff, and neither should guess the other's
 * shape."
 *
 * That was the operator's instruction in db-live-2. What the run actually did:
 *
 *   23:27:35  coordinator authors the contract ALONE
 *   23:27:43  → renderer          "proceed straight to implementation once you confirm"
 *   23:27:51  → page              (same)
 *   23:28:30  page writes src/score.js        — 39s after receiving it
 *   23:28:44  renderer writes src/game.js     — 61s after receiving it, unconfirmed
 *   23:30:03  page greps renderer's file off disk to learn the real shape
 *   23:34:20  page finally reports "CONTRACT CONFIRMED" — 5m50s after writing
 *
 * renderer and page exchanged zero messages in either direction all run. The
 * contract's own text conceded "or window size — your call". It worked only
 * because they shared a directory and the dictated shape happened to be
 * unambiguous; a signature mismatch would have surfaced at integration, not at
 * negotiation.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { loadConfig } from "../config.ts";
import { buildContractHooks, ownsPath } from "./contract-hook.ts";

const briefing = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const CONTRACT = {
  name: "game-module",
  body: "export function start(canvas: HTMLCanvasElement, onScore: (n: number) => void): { restart(): void }",
  parties: ["renderer", "page"],
  scopes: ["src/game.js", "index.html"],
};

async function session(config: Partial<ReturnType<typeof loadConfig>> = {}) {
  const h = makeDelegationHarness(
    async function* () {
      yield initMessage();
      yield successMessage();
    },
    { hostOverrides: { config: { ...loadConfig({}), ...config } } },
  );
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", mode: "execute",
    agents: [
      { name: "renderer", profileId: "implementer", owns: ["src/game.js"] },
      { name: "page", profileId: "implementer", owns: ["index.html"] },
    ],
    briefing: briefing("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  const tool = (name: string) => h.fake.captured.tools.find((entry) => entry.name === name)!;
  return { h, userSessionId, agentSessionId: created.agentSessionId, tool };
}

/** Tool results are MCP content blocks; these tools only ever return text. */
const parse = (result: { content: { type: string; text?: string }[] }) => {
  const block = result.content[0];
  return JSON.parse(block !== undefined && block.type === "text" ? (block.text ?? "null") : "null") as Record<string, unknown>;
};

describe("contract lifecycle", () => {
  it("declares at revision 1 with every party pending, and notifies them", async () => {
    const { h, agentSessionId, tool } = await session();
    const declared = parse(await tool("declare_contract").handler(CONTRACT, {}));

    expect(declared).toMatchObject({ status: "proposed", revision: 1, name: "game-module" });
    expect((declared.parties as { participant: string; state: string }[]).map((p) => p.state))
      .toEqual(["pending", "pending"]);

    // The parties hear about it through the star, as a journaled handoff —
    // there is still no specialist↔specialist wire, and there does not need to
    // be: the content is a shared object, not a message.
    const messages = h.repo.listMessages("agent", agentSessionId);
    expect(messages.filter((row) => row.toName === "renderer" && row.text.includes("game-module"))).toHaveLength(1);
    expect(messages.filter((row) => row.toName === "page" && row.text.includes("game-module"))).toHaveLength(1);
  });

  it("reaches accepted only when every party has accepted the CURRENT revision", async () => {
    const { h, agentSessionId, tool } = await session();
    const declared = parse(await tool("declare_contract").handler(CONTRACT, {}));
    const id = declared.id as string;

    // Through the service: each seat's tool instance is bound to that seat's
    // identity and only exists once it has spawned. The lifecycle is the
    // subject here; the tool surface is covered by the declare test above.
    expect(h.contracts.accept(id, "renderer", 1).status).toBe("proposed");
    expect(h.contracts.accept(id, "page", 1).status).toBe("accepted");
    void agentSessionId;
  });

  it("an amendment RESETS every acceptance", async () => {
    // The reason `amended` is a revision bump and not a status: an amendment
    // that left prior acceptances standing would read "accepted" while
    // describing something nobody agreed to.
    const { h, tool } = await session();
    const declared = parse(await tool("declare_contract").handler(CONTRACT, {}));
    const id = declared.id as string;
    h.contracts.accept(id, "renderer", 1);
    h.contracts.accept(id, "page", 1);
    expect(h.contracts.get(id).status).toBe("accepted");

    const amended = h.contracts.amend(id, "renderer", "…now returns a Promise", "start is async");

    expect(amended).toMatchObject({ status: "proposed", revision: 2 });
    expect(amended.parties.every((party) => party.state === "pending")).toBe(true);
  });

  it("rejects an acceptance of a stale revision, and says which is current", async () => {
    const { h, tool } = await session();
    const declared = parse(await tool("declare_contract").handler(CONTRACT, {}));
    const id = declared.id as string;
    h.contracts.amend(id, "renderer", "changed", "because");
    expect(() => h.contracts.accept(id, "renderer", 1)).toThrow(/current revision is 2/);
  });

  it("refuses a one-party contract", async () => {
    const { tool } = await session();
    const result = await tool("declare_contract").handler({ ...CONTRACT, parties: ["renderer"] }, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/at least two parties/);
  });
});

describe("writes gate on acceptance", () => {
  const hook = (h: Awaited<ReturnType<typeof session>>["h"], agentSessionId: string, seat: string, ownership: string[], enforceOwnership = false) =>
    buildContractHooks({
      contracts: h.contracts, bus: h.bus, userSessionId: "us", agentSessionId, seat,
      seatRoot: "/tmp/test-workspace", workspaceRoot: "/tmp/test-workspace",
      ownership, enforceOwnership,
    }).PreToolUse![0]!.hooks[0]!;

  it("denies a governed write before the seat has accepted", async () => {
    const { h, agentSessionId, tool } = await session();
    await tool("declare_contract").handler(CONTRACT, {});

    const decision = await hook(h, agentSessionId, "renderer", ["src/game.js"])(
      { tool_name: "Write", tool_input: { file_path: "src/game.js" } }, undefined, {},
    ) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    // The refusal has to be actionable, or it is just a different way to stall.
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toMatch(/accept_contract/);
    // Both names, order-independent: the query does not promise one.
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toMatch(/Still pending:.*renderer/);
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toMatch(/Still pending:.*page/);
  });

  it("allows the write once THIS seat has accepted, even while others deliberate", async () => {
    // Waiting on somebody else is not the same as disagreeing.
    const { h, agentSessionId, tool } = await session();
    const declared = parse(await tool("declare_contract").handler(CONTRACT, {}));
    h.contracts.accept(declared.id as string, "renderer", 1);

    const decision = await hook(h, agentSessionId, "renderer", ["src/game.js"])(
      { tool_name: "Write", tool_input: { file_path: "src/game.js" } }, undefined, {},
    );
    expect(decision).toEqual({});
  });

  it("does not bind a seat that is not a party", async () => {
    const { h, agentSessionId, tool } = await session();
    await tool("declare_contract").handler(CONTRACT, {});
    const decision = await hook(h, agentSessionId, "check", [])(
      { tool_name: "Write", tool_input: { file_path: "src/game.js" } }, undefined, {},
    );
    expect(decision).toEqual({});
  });

  it("ignores paths the contract does not govern", async () => {
    const { h, agentSessionId, tool } = await session();
    await tool("declare_contract").handler(CONTRACT, {});
    const decision = await hook(h, agentSessionId, "renderer", ["src/game.js"])(
      { tool_name: "Write", tool_input: { file_path: "README.md" } }, undefined, {},
    );
    expect(decision).toEqual({});
  });
});

describe("ownership enforcement", () => {
  it("denies a write outside declared ownership when enabled", async () => {
    // db-live-2's renderer created `.renderer-dev/serve.mjs` — a private
    // duplicate of the dev server `page` owned and had already written — and
    // maintained it for sixteen minutes.
    const { h, agentSessionId } = await session();
    const hook = buildContractHooks({
      contracts: h.contracts, bus: h.bus, userSessionId: "us", agentSessionId, seat: "renderer",
      seatRoot: "/tmp/test-workspace", workspaceRoot: "/tmp/test-workspace",
      ownership: ["src/game.js"], enforceOwnership: true,
    }).PreToolUse![0]!.hooks[0]!;

    const decision = await hook(
      { tool_name: "Write", tool_input: { file_path: ".renderer-dev/serve.mjs" } }, undefined, {},
    ) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toMatch(/outside your declared ownership/);
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toMatch(/duplicating a teammate's work/);
  });

  it("is off by default — it can block a seat mid-work", async () => {
    const { h, agentSessionId } = await session();
    const hook = buildContractHooks({
      contracts: h.contracts, bus: h.bus, userSessionId: "us", agentSessionId, seat: "renderer",
      seatRoot: "/tmp/test-workspace", workspaceRoot: "/tmp/test-workspace",
      ownership: ["src/game.js"], enforceOwnership: false,
    }).PreToolUse![0]!.hooks[0]!;
    expect(await hook({ tool_name: "Write", tool_input: { file_path: ".renderer-dev/serve.mjs" } }, undefined, {})).toEqual({});
  });

  it("matches a directory scope as well as a file", () => {
    expect(ownsPath(["src"], "/w/src/deep/file.ts", "/w")).toBe(true);
    expect(ownsPath(["src"], "/w/other.ts", "/w")).toBe(false);
    // Not a prefix match on the raw string: `src-old` is not inside `src`.
    expect(ownsPath(["src"], "/w/src-old/file.ts", "/w")).toBe(false);
  });
});
