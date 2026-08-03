import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRuntimeStore } from "@/stores/runtime";

import { WorkingLine, describeRuntime, formatElapsed } from "./working-line";

describe("describeRuntime", () => {
  it("prefers the provider's own words when it has any", () => {
    expect(
      describeRuntime("orchestrator", {
        state: "thinking",
        detail: "rate limited · retry 1/5 · in 30s",
        at: 0,
        since: 0,
      }),
    ).toBe("orchestrator · rate limited · retry 1/5 · in 30s");
  });

  it("falls back to the state, naming the tool when there is one", () => {
    expect(
      describeRuntime("scout", {
        state: "tool",
        toolName: "Grep",
        at: 0,
        since: 0,
      }),
    ).toBe("scout is running Grep…");
    expect(describeRuntime("scout", { state: "thinking", at: 0, since: 0 })).toBe(
      "scout is thinking…",
    );
  });
});

describe("formatElapsed", () => {
  it("reads as seconds under a minute and m/s beyond", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(95_000)).toBe("1m 35s");
  });
});

describe("WorkingLine", () => {
  it("shows elapsed time once the wait stops feeling instant", () => {
    const { rerender } = render(
      <WorkingLine
        name="orchestrator"
        runtime={{ state: "thinking", at: Date.now(), since: Date.now() }}
      />,
    );
    expect(screen.queryByText(/\ds/)).toBeNull();

    rerender(
      <WorkingLine
        name="orchestrator"
        runtime={{
          state: "thinking",
          at: Date.now(),
          since: Date.now() - 90_000,
        }}
      />,
    );
    expect(screen.getByText(/^1m \d\ds$/)).toBeInTheDocument();
  });
});

describe("runtime store", () => {
  it("holds `since` across detail-only updates so elapsed measures the wait", () => {
    const { ingest, clearAll } = useRuntimeStore.getState();
    clearAll();
    const scope = { kind: "user" as const, sessionId: "us_1" };
    ingest({ scope, participant: "orchestrator", state: "thinking" });
    const first = useRuntimeStore.getState().bySession["us_1"]?.["orchestrator"];

    ingest({
      scope,
      participant: "orchestrator",
      state: "thinking",
      detail: "requesting…",
    });
    const second = useRuntimeStore.getState().bySession["us_1"]?.["orchestrator"];
    expect(second?.since).toBe(first?.since);
    expect(second?.detail).toBe("requesting…");

    // A real state change restarts the clock.
    ingest({ scope, participant: "orchestrator", state: "tool", toolName: "Read" });
    const third = useRuntimeStore.getState().bySession["us_1"]?.["orchestrator"];
    expect(third?.since).toBeGreaterThanOrEqual(second?.since ?? 0);
    expect(third?.detail).toBeUndefined();
  });
});
