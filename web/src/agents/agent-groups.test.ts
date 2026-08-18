import { describe, expect, it } from "vitest";

import type { AgentItem, AgentToolItem } from "./agent-fold";
import {
  agentGroupKey,
  groupAgentItems,
  runSummary,
  shortenPath,
  subjectOf,
  type ToolRunItem,
} from "./agent-groups";

function tool(
  name: string,
  uid: string,
  agent = "scout",
  output?: unknown,
): AgentToolItem {
  return {
    type: "tool",
    uid,
    callId: uid,
    name,
    agent,
    input: {},
    ...(output === undefined ? {} : { output }),
  };
}

function message(seq: number): AgentItem {
  return {
    type: "message",
    seq,
    speaker: { kind: "agent", name: "scout" },
    kind: "message",
    text: "done",
    createdAt: "2026-08-03T12:00:00.000Z",
  };
}

/**
 * Golden suite for the agent-side presentation grouping. The fold's item union
 * is the input contract — if agent-fold.ts grows an arm, this must stay total.
 */
describe("groupAgentItems", () => {
  it("collapses one agent's consecutive calls into a single run", () => {
    const groups = groupAgentItems([
      tool("Read", "a", "scout", "x"),
      tool("Grep", "b", "scout", "y"),
    ]);

    expect(groups).toHaveLength(1);
    expect((groups[0] as ToolRunItem).agent).toBe("scout");
    expect((groups[0] as ToolRunItem).tools).toHaveLength(2);
  });

  it("splits a run when the agent changes, with nothing in between", () => {
    const groups = groupAgentItems([
      tool("Read", "a", "scout", "x"),
      tool("Edit", "b", "coder", "y"),
    ]);

    expect(groups.map((g) => (g as ToolRunItem).agent)).toEqual([
      "scout",
      "coder",
    ]);
  });

  it("breaks a run on any non-tool item", () => {
    const groups = groupAgentItems([
      tool("Read", "a", "scout", "x"),
      message(1),
      tool("Read", "b", "scout", "y"),
    ]);

    expect(groups.map((g) => g.type)).toEqual([
      "tool_run",
      "message",
      "tool_run",
    ]);
  });

  it("passes non-tool items through untouched and in order", () => {
    const items: AgentItem[] = [
      message(1),
      message(2),
    ];
    expect(groupAgentItems(items)).toEqual(items);
  });

  it("marks a run active only while its LAST call is unresolved", () => {
    const open = groupAgentItems([
      tool("Read", "a", "scout", "x"),
      tool("Bash", "b", "scout"),
    ]);
    expect((open[0] as ToolRunItem).active).toBe(true);

    const closed = groupAgentItems([tool("Bash", "a", "scout", "ok")]);
    expect((closed[0] as ToolRunItem).active).toBe(false);
  });

  it("is idempotent over its own structural input", () => {
    const items = [tool("Read", "a", "scout", "x"), message(1)];
    expect(groupAgentItems(items)).toEqual(groupAgentItems(items));
  });

  it("keys a run by its first tool, so keys stay stable as it grows", () => {
    const first = groupAgentItems([tool("Read", "a", "scout", "x")]);
    const grown = groupAgentItems([
      tool("Read", "a", "scout", "x"),
      tool("Bash", "b", "scout"),
    ]);
    expect(agentGroupKey(first[0]!)).toBe("tool_run:a");
    expect(agentGroupKey(grown[0]!)).toBe("tool_run:a");
  });

  it("returns nothing for nothing", () => {
    expect(groupAgentItems([])).toEqual([]);
  });
});

describe("runSummary", () => {
  it("counts by phrase and pluralises", () => {
    expect(
      runSummary([
        tool("Bash", "a"),
        tool("Bash", "b"),
        tool("Read", "c"),
      ]),
    ).toBe("ran 2 commands · read 1 file");
  });

  it("collapses tools that say the same thing into one clause", () => {
    expect(runSummary([tool("Glob", "a"), tool("Grep", "b")])).toBe(
      "searched 2 patterns",
    );
  });

  it("keeps multi-word nouns intact", () => {
    expect(runSummary([tool("TaskCreate", "a")])).toBe("made 1 task update");
    expect(runSummary([tool("TaskCreate", "a"), tool("TaskUpdate", "b")])).toBe(
      "made 2 task updates",
    );
  });

  it("falls back to a neutral noun for unknown tools", () => {
    expect(runSummary([tool("SomethingNew", "a")])).toBe("ran 1 step");
  });
});

describe("subjectOf", () => {
  it("finds the file or pattern a call is about", () => {
    expect(subjectOf({ file_path: "/repo/web/src/app.tsx" })).toBe(
      "/repo/web/src/app.tsx",
    );
    expect(subjectOf({ pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(subjectOf({ url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });

  it("gives no chip rather than a wrong one", () => {
    expect(subjectOf({ command: "ls" })).toBeUndefined();
    expect(subjectOf({ file_path: "" })).toBeUndefined();
    expect(subjectOf(null)).toBeUndefined();
    expect(subjectOf("a string")).toBeUndefined();
  });
});

describe("shortenPath", () => {
  it("keeps the interesting end of a path", () => {
    expect(shortenPath("/repo/web/src/session/composer.tsx")).toBe(
      "…/session/composer.tsx",
    );
  });

  it("leaves already-short paths alone", () => {
    expect(shortenPath("composer.tsx")).toBe("composer.tsx");
    expect(shortenPath("src/app.tsx")).toBe("src/app.tsx");
  });
});
