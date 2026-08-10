/**
 * `read_artifact` — reading back what a seat produced.
 *
 * The regression this file exists for: the tool returned the ANTHROPIC MESSAGES
 * API image shape (`{type:"image", source:{type:"base64", media_type, data}}`)
 * to an in-process MCP server that accepts only MCP `ContentBlock`s
 * (`{type:"image", data, mimeType}`). Every image call in db-live-2 failed with
 * `MCP error -32602 … invalid_union … expected "text"` — four times, across
 * three different agents. Three valid 1440x1000 PNGs sat in `event_artifacts`
 * that nobody, including the seat that captured them, could open.
 *
 * The operator's acceptance bar was "report final only when check has confirmed
 * it with a screenshot". It was met procedurally and defeated semantically:
 * `check` reimplemented visual verification in `gl.readPixels` instead, at
 * ~4 minutes and a large share of a $2.64 turn.
 *
 * The fake could not have caught it — `executeMcpTool` mapped content with
 * `part.text ?? ""`, so an invalid block became an empty string and a green
 * test. It now validates against the MCP shape, which is why these assertions
 * are worth anything.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

/** A 1x1 transparent PNG — small, real, and decodes cleanly. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function seatWithArtifacts() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "artifacts", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  const tool = h.fake.captured.tools.find((t) => t.name === "read_artifact");
  expect(tool).toBeDefined();
  return { h, userSessionId, agentSessionId: created.agentSessionId, tool: tool! };
}

describe("read_artifact (fake SDK)", () => {
  it("returns an image as MCP image content, not the Messages API shape", async () => {
    const { h, userSessionId, agentSessionId, tool } = await seatWithArtifacts();
    const { artifactId } = h.bus.storeArtifact(PNG_BASE64, "image/png;base64", { userSessionId, agentSessionId });

    const result = await tool.handler({ artifactId, maxBytes: 8 * 1024 }, {});

    // The shape itself is the assertion. `source` present, or `mimeType`
    // missing, is exactly what the real server rejected.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
    expect(result.content[0]).not.toHaveProperty("source");
    expect(result.isError).not.toBe(true);
  });

  it("strips the console's `;base64` storage suffix at the tool boundary", async () => {
    const { h, userSessionId, agentSessionId, tool } = await seatWithArtifacts();
    // `bus.storeArtifact` branches on the suffix to compute decoded byte
    // counts, so the convention stays in storage and is normalized only here.
    const { artifactId, bytes } = h.bus.storeArtifact(PNG_BASE64, "image/png;base64", { userSessionId, agentSessionId });
    expect(bytes).toBe(Buffer.from(PNG_BASE64, "base64").byteLength);

    const result = await tool.handler({ artifactId, maxBytes: 8 * 1024 }, {});
    const block = result.content[0] as { mimeType: string };
    expect(block.mimeType).toBe("image/png");
    expect(block.mimeType).not.toMatch(/;base64$/);
  });

  it("degrades an oversize image to text instead of failing the whole result", async () => {
    const { h, userSessionId, agentSessionId, tool } = await seatWithArtifacts();
    // Over the ~5MB provider ceiling for inline images. A full-page screenshot
    // at a large viewport can reach this, and an oversize image fails the
    // entire tool result rather than degrading.
    const oversize = "A".repeat(5 * 1024 * 1024 + 4);
    const { artifactId } = h.bus.storeArtifact(oversize, "image/png;base64", { userSessionId, agentSessionId });

    const result = await tool.handler({ artifactId, maxBytes: 8 * 1024 }, {});

    expect(result.content[0]?.type).toBe("text");
    const payload = JSON.parse((result.content[0] as { text: string }).text) as { error?: string; artifactId?: string };
    expect(payload.artifactId).toBe(artifactId);
    expect(payload.error).toMatch(/over the .* limit for inline images/);
  });

  it("still pages non-image artifacts as text", async () => {
    const { h, userSessionId, agentSessionId, tool } = await seatWithArtifacts();
    const { artifactId } = h.bus.storeArtifact(JSON.stringify({ hello: "world" }), "application/json", { userSessionId, agentSessionId });

    const result = await tool.handler({ artifactId, maxBytes: 8 * 1024 }, {});

    expect(result.content[0]?.type).toBe("text");
    const payload = JSON.parse((result.content[0] as { text: string }).text) as { mediaType: string; content: unknown };
    expect(payload.mediaType).toBe("application/json");
    expect(JSON.stringify(payload.content)).toContain("hello");
  });

  it("reports a missing artifact as a tool error rather than throwing", async () => {
    const { tool } = await seatWithArtifacts();
    const result = await tool.handler({ artifactId: "artifact_missing", maxBytes: 8 * 1024 }, {});
    // The same convention as read_attempt_diff: a reference to something that
    // does not exist is the seat's mistake, so it is an isError result — not
    // an `ok({error})` success shape the model has to notice.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("artifact_missing");
  });
});
