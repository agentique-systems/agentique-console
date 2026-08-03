/** The draft posture rule: draftOpen renders the draft view, nothing else. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

import { ConversationRegion } from "./conversation-region";

function stubFetch(sessions: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/user-sessions") ? sessions : {};
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      } as Response;
    }),
  );
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe("ConversationRegion", () => {
  beforeEach(() => {
    useScopeStore.setState({ selectedWorkspaceId: "ws_1" });
    useUiStore.setState({
      activeUserSessionId: null,
      draftOpen: false,
      awaitingInput: new Set(),
      selectedAgentSessionByUserSession: {},
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the draft view in draft posture", async () => {
    stubFetch([]);
    useUiStore.setState({ draftOpen: true });
    render(createElement(ConversationRegion), { wrapper: wrapper() });

    expect(await screen.findByTestId("draft-session")).toBeInTheDocument();
  });

  it("renders the empty invite when there are no sessions and no draft", async () => {
    stubFetch([]);
    render(createElement(ConversationRegion), { wrapper: wrapper() });

    expect(
      await screen.findByRole("button", { name: "New session" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("draft-session")).not.toBeInTheDocument();
  });
});
