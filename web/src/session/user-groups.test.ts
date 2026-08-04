import { describe, expect, it } from "vitest";

import type { ToolItem, UserItem } from "./user-fold";
import {
  chainSummary,
  groupKey,
  groupUserItems,
  toolStatus,
  type ChainItem,
} from "./user-groups";

function tool(name: string, uid: string, output?: unknown): ToolItem {
  return {
    type: "tool",
    uid,
    callId: uid,
    name,
    input: {},
    ...(output === undefined ? {} : { output }),
  };
}

function message(seq: number): UserItem {
  return {
    type: "message",
    seq,
    speaker: { kind: "orchestrator", name: "orchestrator" },
    text: "hi",
    kind: "message",
    createdAt: "2026-08-03T12:00:00.000Z",
  };
}

const turn: UserItem = { type: "turn", turnId: "t1", trigger: "operator" };

/**
 * Golden suite for the presentation grouping. The fold's item union is the
 * input contract — if user-fold.ts grows an arm, this must stay total over it.
 */
describe("groupUserItems", () => {
  it("collapses a run of consecutive tool calls into one chain", () => {
    const groups = groupUserItems([
      tool("Grep", "a", "hit"),
      tool("Read", "b", "text"),
      tool("Read", "c", "text"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("chain");
    expect((groups[0] as ChainItem).tools.map((t) => t.uid)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks the chain on any non-tool item", () => {
    const groups = groupUserItems([
      tool("Grep", "a", "hit"),
      message(1),
      tool("Read", "b", "text"),
    ]);

    expect(groups.map((g) => g.type)).toEqual(["chain", "message", "chain"]);
  });

  it("starts a new chain after a turn hairline", () => {
    const groups = groupUserItems([tool("Grep", "a", "hit"), turn, tool("Read", "b")]);
    expect(groups.map((g) => g.type)).toEqual(["chain", "turn", "chain"]);
  });

  it("passes non-tool items through untouched and in order", () => {
    const items = [message(1), turn, message(2)];
    expect(groupUserItems(items)).toEqual(items);
  });

  it("is a chain of one for a lone tool call", () => {
    const groups = groupUserItems([tool("Agent", "a")]);
    expect(groups).toHaveLength(1);
    expect((groups[0] as ChainItem).tools).toHaveLength(1);
  });

  it("marks a chain active only while its LAST call is unresolved", () => {
    const open = groupUserItems([tool("Grep", "a", "hit"), tool("Read", "b")]);
    expect((open[0] as ChainItem).active).toBe(true);

    const closed = groupUserItems([tool("Grep", "a"), tool("Read", "b", "text")]);
    expect((closed[0] as ChainItem).active).toBe(false);
  });

  it("is idempotent over its own structural input", () => {
    const items = [tool("Grep", "a", "x"), message(1), tool("Read", "b", "y")];
    expect(groupUserItems(items)).toEqual(groupUserItems(items));
  });

  it("returns nothing for nothing", () => {
    expect(groupUserItems([])).toEqual([]);
  });

  it("keys a chain by its first tool, so keys stay stable as it grows", () => {
    const first = groupUserItems([tool("Grep", "a", "x")]);
    const grown = groupUserItems([tool("Grep", "a", "x"), tool("Read", "b")]);
    expect(groupKey(first[0]!)).toBe("chain:a");
    expect(groupKey(grown[0]!)).toBe("chain:a");
  });
});

describe("toolStatus", () => {
  it("reads the three phases off the paired result", () => {
    expect(toolStatus(tool("Read", "a"))).toBe("active");
    expect(toolStatus(tool("Read", "a", "text"))).toBe("complete");
    expect(toolStatus({ ...tool("Read", "a"), isError: true })).toBe("failed");
  });
});

describe("chainSummary", () => {
  it("counts by category and pluralises", () => {
    expect(
      chainSummary([
        tool("Grep", "a"),
        tool("Read", "b"),
        tool("Read", "c"),
      ]),
    ).toBe("ran 1 search · read 2 files");
  });

  it("treats console MCP tools as one category by prefix", () => {
    expect(
      chainSummary([
        tool("mcp__console__create_agent_session", "a"),
        tool("mcp__console__list_agent_sessions", "b"),
      ]),
    ).toBe("made 2 console calls");
  });

  it("orders clauses by first appearance, not by count", () => {
    expect(
      chainSummary([tool("Agent", "a"), tool("Read", "b"), tool("Read", "c")]),
    ).toBe("spawned 1 agent · read 2 files");
  });

  it("distinguishes a search from an unknown tool despite the shared verb", () => {
    expect(chainSummary([tool("Glob", "a"), tool("Mystery", "b")])).toBe(
      "ran 1 search · ran 1 step",
    );
  });

  it("falls back to a neutral noun for unknown tools", () => {
    expect(chainSummary([tool("SomethingNew", "a")])).toBe("ran 1 step");
  });
});
