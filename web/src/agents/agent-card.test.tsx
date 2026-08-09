/** The card's liveness contract: seat dots + running ring from the runtime store. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentSession } from "@agentique-console/shared";
import { useRuntimeStore } from "@/stores/runtime";
import { useUiStore } from "@/stores/ui";

import { AgentCard } from "./agent-card";

const SESSION: AgentSession = {
  id: "as_1",
  userSessionId: "us_1",
  title: "wire the strip",
  mode: "execute",
  phase: "executing",
  status: "idle",
  pattern: "hub_and_spoke",
  parentAgentSessionId: null,
  participants: ["scout", "coder"],
  createdAt: "2026-08-03T11:00:00.000Z",
  updatedAt: "2026-08-03T11:30:00.000Z",
};

function seatState(
  seats: Record<string, { state: string; toolName?: string }>,
) {
  useRuntimeStore.setState({
    bySession: {
      as_1: Object.fromEntries(
        Object.entries(seats).map(([name, runtime]) => [
          name,
          { ...runtime, at: 0 },
        ]),
      ),
    },
  } as never);
}

function renderCard(over: Partial<AgentSession> = {}, selected = false) {
  return render(
    createElement(AgentCard, {
      session: { ...SESSION, ...over },
      taskCount: 3,
      selected,
    }),
  );
}

describe("AgentCard", () => {
  beforeEach(() => {
    useRuntimeStore.setState({ bySession: {} });
    useUiStore.setState({ selectedAgentSessionByUserSession: {} });
  });

  it("seat dots read the runtime store: thinking pulses, tool waits, unknown greys", () => {
    seatState({ scout: { state: "thinking" }, coder: { state: "tool", toolName: "Grep" } });
    renderCard();

    const scout = screen.getByTestId("seat-dot-scout");
    expect(scout.className).toContain("bg-status-running");
    expect(scout.className).toContain("animate-pulse");

    const coder = screen.getByTestId("seat-dot-coder");
    expect(coder.className).toContain("bg-status-waiting");
    expect(coder.className).not.toContain("animate-pulse");
  });

  it("seats without a runtime frame read idle (cancelled grey)", () => {
    renderCard();
    expect(screen.getByTestId("seat-dot-scout").className).toContain(
      "bg-status-cancelled",
    );
  });

  it("breathes the running ring while any seat works", () => {
    seatState({ scout: { state: "responding" }, coder: { state: "idle" } });
    renderCard();
    expect(screen.getByTestId("agent-card").className).toContain(
      "console-running-ring",
    );
  });

  it("breathes the running ring on status=working even with silent seats", () => {
    renderCard({ status: "working" });
    expect(screen.getByTestId("agent-card").className).toContain(
      "console-running-ring",
    );
  });

  it("idle session with idle seats sits still", () => {
    seatState({ scout: { state: "idle" }, coder: { state: "waiting" } });
    renderCard();
    expect(screen.getByTestId("agent-card").className).not.toContain(
      "console-running-ring",
    );
  });

  it("shows the running tool name when a seat is in tool state", () => {
    seatState({ scout: { state: "tool", toolName: "Grep" } });
    renderCard();
    expect(screen.getByText("running Grep")).toBeInTheDocument();
  });

  it("click selects the card's agent session for its user session", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByTestId("agent-card"));
    expect(
      useUiStore.getState().selectedAgentSessionByUserSession["us_1"],
    ).toBe("as_1");
  });

  it("selected cards carry the selection border", () => {
    renderCard({}, true);
    expect(screen.getByTestId("agent-card").className).toContain(
      "border-primary",
    );
  });
});
