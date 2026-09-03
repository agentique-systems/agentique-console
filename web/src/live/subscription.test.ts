import { describe, expect, it } from "vitest";
import type { Event } from "@agentique-console/core";
import { createSseParser, invalidationsOf } from "./subscription";

describe("event subscription", () => {
  it("parses SSE frames across chunk boundaries, keeps ids, and ignores comments", () => {
    const frames: { event: string; data: string; id: string | null }[] = [];
    const parse = createSseParser((event, data, id) => frames.push({ event, data, id }));
    parse(": connected\n\nid: 7\nevent: ev");
    parse("ent\ndata: {\"kind\":\"event\"}\n\nevent: output\ndata: {\"kind\":");
    parse("\"output\"}\n\n: heartbeat\n\n");
    expect(frames).toEqual([
      { event: "event", data: '{"kind":"event"}', id: "7" },
      { event: "output", data: '{"kind":"output"}', id: null },
    ]);
  });

  it("invalidates exactly the projections in an Event's scope", () => {
    const event = { type: "run.started", scope: { workspaceId: "ws_1", conversationId: "cv_1", runId: "run_1", planNodeId: null, invocationId: null, attemptId: null } } as unknown as Event;
    expect(invalidationsOf(event)).toEqual([["workspace", "ws_1"], ["conversation", "cv_1"], ["run", "run_1"], ["workspace", "ws_1", "runs"]]);
    const foreign = { type: "attempt.started", scope: { workspaceId: "ws_2", conversationId: null, runId: "run_2", planNodeId: "pn_1", invocationId: "inv_1", attemptId: "att_1" } } as unknown as Event;
    expect(invalidationsOf(foreign).some((k) => k.includes("run_1"))).toBe(false);
    expect(invalidationsOf(foreign)).toContainEqual(["attempt", "att_1"]);
  });
});
