/** The composer's rewrite pass: hermetic options, text out, never empty. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import {
  fakeSdk,
  initMessage,
  successMessage,
  textMessage,
  type FakeProgram,
} from "../sdk/fake.ts";
import { improveMessage } from "./improve.ts";

function harness(program: FakeProgram) {
  return { fake: fakeSdk(program), config: loadConfig({}) };
}

describe("improveMessage", () => {
  it("returns the assistant's rewrite and runs hermetically on the cheap model", async () => {
    const h = harness(async function* () {
      yield initMessage();
      yield textMessage("Please review the auth module and report findings.");
      yield successMessage();
    });

    const improved = await improveMessage(
      h.fake.sdk,
      h.config,
      "hey so could u maybe take a look at teh auth module n tell me what u find",
    );

    expect(improved).toBe(
      "Please review the auth module and report findings.",
    );
    expect(h.fake.captured.prompts[0]).toContain("teh auth module");

    const options = h.fake.captured.options[0];
    expect(options?.model).toBe("claude-sonnet-5");
    expect(options?.allowedTools).toEqual([]);
    expect(options?.settingSources).toEqual([]);
    expect(options?.maxTurns).toBe(1);
    expect(options?.persistSession).toBe(false);
    // A rewrite must never resume or write to a session lane.
    expect(options?.resume).toBeUndefined();
    expect(options?.sessionStore).toBeUndefined();
    expect(options?.mcpServers).toBeUndefined();
  });

  it("honors CONSOLE_IMPROVE_MODEL", async () => {
    const fake = fakeSdk(async function* () {
      yield textMessage("Tightened.");
    });
    await improveMessage(
      fake.sdk,
      loadConfig({ CONSOLE_IMPROVE_MODEL: "claude-haiku-4-5" }),
      "loose",
    );
    expect(fake.captured.options[0]?.model).toBe("claude-haiku-4-5");
  });

  it("joins multi-block text and unwraps a fenced reply", async () => {
    const h = harness(async function* () {
      yield textMessage("```\nShip the fix.");
      yield textMessage("\n```");
      yield successMessage();
    });
    expect(await improveMessage(h.fake.sdk, h.config, "ship it maybe?")).toBe(
      "Ship the fix.",
    );
  });

  it("throws rather than handing back an empty draft", async () => {
    const h = harness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    await expect(
      improveMessage(h.fake.sdk, h.config, "something"),
    ).rejects.toThrow(/returned nothing/);
  });
});
