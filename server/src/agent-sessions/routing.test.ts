import { describe, expect, it } from "vitest";
import { parseMentions, route } from "./routing.ts";

const SEATS = ["scout", "coder"];
const orchestrator = { kind: "orchestrator" as const, name: "orchestrator" };
const agent = (name: string) => ({ kind: "agent" as const, name });

describe("parseMentions", () => {
  it("finds mentions case-insensitively on word boundaries", () => {
    expect(parseMentions("hey @Scout and @CODER", SEATS)).toEqual([
      "scout",
      "coder",
    ]);
  });

  it("does not read emails as mentions", () => {
    expect(parseMentions("mail me at bob@scout.dev", SEATS)).toEqual([]);
  });

  it("trims trailing punctuation until a name resolves", () => {
    expect(parseMentions("@scout, thoughts?", SEATS)).toEqual(["scout"]);
  });

  it("dedupes repeated mentions", () => {
    expect(parseMentions("@scout @scout", SEATS)).toEqual(["scout"]);
  });
});

describe("route", () => {
  it("explicit to wins over mentions", () => {
    expect(
      route({ speaker: orchestrator, to: "coder", text: "@scout look" }, SEATS),
    ).toEqual([{ recipient: "coder", reason: "addressed" }]);
  });

  it("every mention is a recipient, speaker excluded", () => {
    expect(
      route(
        { speaker: agent("scout"), text: "@coder @scout @orchestrator see" },
        SEATS,
      ),
    ).toEqual([
      { recipient: "coder", reason: "mention" },
      { recipient: "orchestrator", reason: "mention" },
    ]);
  });

  it("unaddressed specialist speech returns to the orchestrator", () => {
    expect(route({ speaker: agent("scout"), text: "done" }, SEATS)).toEqual([
      { recipient: "orchestrator", reason: "default" },
    ]);
  });

  it("unaddressed orchestrator speech seats the sole specialist", () => {
    expect(
      route({ speaker: orchestrator, text: "go look" }, ["scout"]),
    ).toEqual([{ recipient: "scout", reason: "default" }]);
  });

  it("unaddressed orchestrator speech in a multi-seat session routes nowhere", () => {
    expect(route({ speaker: orchestrator, text: "go look" }, SEATS)).toEqual(
      [],
    );
  });

  it("invalid to falls back to mention parsing then default", () => {
    expect(
      route({ speaker: agent("scout"), to: "nobody", text: "hm" }, SEATS),
    ).toEqual([{ recipient: "orchestrator", reason: "default" }]);
  });
});
