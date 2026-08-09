/**
 * Every fixture in this file is a VERBATIM uncertainty string from a real run,
 * or a minimal paraphrase of one. The classifier is only worth having if it
 * fires on what agents actually write, and agents wrote all of this.
 */
import { describe, expect, it } from "vitest";
import type { HandoffCore } from "@agentique-console/shared";
import { classifyUncertainty, VOLUME_THRESHOLD, type EscalationContext } from "./escalation.ts";

const core = (uncertainty: string[], overrides: Partial<HandoffCore> = {}): HandoffCore => ({
  schemaVersion: 1, taskId: null, status: "in_progress", risk: "low",
  action: "build", state: { summary: "s", evidence: [] },
  result: { summary: null, artifacts: [] },
  uncertainty, nextAction: null, requestExpandedContext: false,
  ...overrides,
});

const ctx = (overrides: Partial<EscalationContext> = {}): EscalationContext => ({
  trigger: "update",
  operatorPins: new Map(),
  operatorConstraints: [],
  // The db-live-2 seat shape: shell and browser, no outbound network at all.
  capabilities: { shell: true, browser: true, screenshots: true, network: [] },
  ...overrides,
});

const only = (items: ReturnType<typeof classifyUncertainty>) => items[0]!;

describe("version_substitution", () => {
  it("catches a pin conflict against what the operator named", () => {
    // The db-live-2 failure: page shipped r169 where the operator's prompt said
    // r160, logged it honestly, and nobody ever asked.
    const items = classifyUncertainty(
      core(["CDN access is now failing, so the vendored copy of three stays at r169."]),
      ctx({ operatorPins: new Map([["three", "r160"]]) }),
    );
    expect(only(items)).toMatchObject({
      category: "version_substitution", urgency: "blocking", rule: "pin_conflict",
      versions: { dependency: "three", expected: "r160", shipped: "r169" },
    });
  });

  it("catches a comparative sentence naming two versions, with no pin at all", () => {
    const items = classifyUncertainty(
      core(["Shipped three r169 instead of the r160 the brief named."]),
      ctx(),
    );
    expect(only(items).category).toBe("version_substitution");
    expect(only(items).urgency).toBe("blocking");
    expect(only(items).versions).toMatchObject({ shipped: "r169", expected: "r160" });
  });

  it("handles semver as well as three.js revisions", () => {
    const items = classifyUncertainty(
      core(["Used vite 5.4.2 rather than the 4.9.1 pinned in the brief."]),
      ctx(),
    );
    expect(only(items).category).toBe("version_substitution");
    expect(only(items).versions).toMatchObject({ shipped: "5.4.2", expected: "4.9.1" });
  });

  it("does not fire on a single version mentioned in passing", () => {
    expect(classifyUncertainty(core(["Vendored three r169 locally."]), ctx())).toHaveLength(0);
  });
});

describe("capability_gap", () => {
  it("is BLOCKING when the profile genuinely lacks the capability", () => {
    // page's actual escalation in db-live-2, and the exact class of defect that
    // made db-live-1's deliverable non-functional.
    const items = classifyUncertainty(
      core(["game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK. Line 1 imports three from a CDN."]),
      ctx({ capabilities: { shell: true, browser: true, screenshots: true, network: [] } }),
    );
    expect(only(items)).toMatchObject({ category: "capability_gap", urgency: "blocking" });
    expect(only(items).rule).toContain(":confirmed");
  });

  it("is DEFERRED when the seat has the capability it claims to lack", () => {
    // Then the seat is probably wrong, and that is the coordinator's problem —
    // not something to interrupt a human for.
    const items = classifyUncertainty(
      core(["game.js WILL NOT LOAD IF THE BROWSER HAS NO NETWORK. Line 1 imports three from a CDN."]),
      ctx({ capabilities: { shell: true, browser: true, screenshots: true, network: ["unpkg.com"] } }),
    );
    expect(only(items)).toMatchObject({ category: "capability_gap", urgency: "deferred" });
    expect(only(items).rule).toContain(":claimed");
  });

  it("confirms a missing browser against the profile", () => {
    const items = classifyUncertainty(
      core(["I could not open a browser, so nothing is confirmed rendering — no WebGL context, no visible cube."]),
      ctx({ capabilities: { shell: true, browser: false, screenshots: false, network: [] } }),
    );
    expect(only(items)).toMatchObject({ category: "capability_gap", urgency: "blocking" });
  });
});

describe("unverifiable_claim", () => {
  const CLAIM = "I did not run the tests.";

  it("is deferred on an ordinary update", () => {
    expect(only(classifyUncertainty(core([CLAIM]), ctx({ trigger: "update" })))).toMatchObject({
      category: "unverifiable_claim", urgency: "deferred",
    });
  });

  it("is BLOCKING on a final — the same string, two verdicts", () => {
    // This is the rule that matters. Claiming done while admitting you never
    // verified is what db-live-2 shipped: `check` reported completed alongside
    // "I could not view the PNG screenshots myself".
    expect(only(classifyUncertainty(core([CLAIM]), ctx({ trigger: "final" })))).toMatchObject({
      category: "unverifiable_claim", urgency: "blocking",
    });
  });

  it("is BLOCKING on status:completed even without a final trigger", () => {
    expect(only(classifyUncertainty(core([CLAIM], { status: "completed" }), ctx({ trigger: "milestone" })))).toMatchObject({
      urgency: "blocking",
    });
  });

  it("catches the db-live-2 screenshot admission verbatim", () => {
    const items = classifyUncertainty(
      core(["I could not view the PNG screenshots myself. Both captured fine but read_artifact fails with an MCP schema error."]),
      ctx({ trigger: "final", capabilities: { shell: true, browser: true, screenshots: true, network: [] } }),
    );
    expect(only(items).urgency).toBe("blocking");
  });
});

describe("spec_deviation", () => {
  it("fires on explicit deviation language", () => {
    expect(only(classifyUncertainty(
      core(["three.js was loaded from a vendored copy although the brief asked for a CDN."]), ctx(),
    ))).toMatchObject({ category: "spec_deviation", urgency: "blocking" });
  });

  it("fires when a distinctive operator constraint appears with a negation", () => {
    const items = classifyUncertainty(
      core(["The importmap does not use the vendored path we agreed."]),
      ctx({ operatorConstraints: ["Use the vendored copy under vendor/three.module.js"] }),
    );
    expect(only(items).category).toBe("spec_deviation");
    expect(only(items).rule).toMatch(/^constraint:/);
  });
});

describe("ambiguity", () => {
  it("is deferred when merely noted", () => {
    expect(only(classifyUncertainty(core(["It is unclear whether the HUD should persist across restarts."]), ctx())))
      .toMatchObject({ category: "ambiguity", urgency: "deferred" });
  });

  it("is blocking when the seat is literally asking", () => {
    expect(only(classifyUncertainty(core(["Should I add a start gate, or leave it auto-starting?"]), ctx())))
      .toMatchObject({ category: "ambiguity", urgency: "blocking" });
  });
});

describe("what must NOT escalate", () => {
  it("ignores a benign note", () => {
    expect(classifyUncertainty(core(["Formatting may differ from prettier defaults."]), ctx())).toHaveLength(0);
  });

  it("ignores an anti-hedge — a seat refusing to assume is doing it right", () => {
    // Verbatim db-live-2. Escalating these would punish exactly the behaviour
    // the doctrine asks for.
    const items = classifyUncertainty(core([
      "Tracking down that 404 rather than assuming it's harmless.",
      "Reading player positions out of the live three.js scene graph rather than guessing from pixels.",
    ]), ctx());
    expect(items).toHaveLength(0);
  });

  it("ignores empty and whitespace entries", () => {
    expect(classifyUncertainty(core(["", "   "]), ctx())).toHaveLength(0);
  });
});

describe("volume", () => {
  it("fires one synthetic item on a final carrying many uncertainties", () => {
    // db-live-2's final carried 22.
    const many = Array.from({ length: 22 }, (_, i) => `Minor open item ${i + 1}.`);
    const items = classifyUncertainty(core(many), ctx({ trigger: "final" }));
    const volume = items.filter((item) => item.category === "volume");
    expect(volume).toHaveLength(1);
    expect(volume[0]?.urgency).toBe("deferred");
    expect(volume[0]?.text).toContain("22");
  });

  it("does not fire below the threshold, or on a non-final", () => {
    const few = Array.from({ length: VOLUME_THRESHOLD - 1 }, (_, i) => `Item ${i}.`);
    expect(classifyUncertainty(core(few), ctx({ trigger: "final" })).some((i) => i.category === "volume")).toBe(false);
    const many = Array.from({ length: VOLUME_THRESHOLD + 2 }, (_, i) => `Item ${i}.`);
    expect(classifyUncertainty(core(many), ctx({ trigger: "update" })).some((i) => i.category === "volume")).toBe(false);
  });
});

describe("rule ordering", () => {
  it("prefers version_substitution over the capability gap that caused it", () => {
    // "Could not fetch r160, so it stays at r169" is both. The version call is
    // the operator's; the network limit is just why.
    const items = classifyUncertainty(
      core(["Could not reach the registry to fetch three r160, so the vendored copy stays at r169."]),
      ctx({ operatorPins: new Map([["three", "r160"]]) }),
    );
    expect(only(items).category).toBe("version_substitution");
  });

  it("emits at most one item per uncertainty string", () => {
    const items = classifyUncertainty(
      core(["I could not verify this and it is unclear and it deviates from the brief."]),
      ctx(),
    );
    expect(items).toHaveLength(1);
  });
});
