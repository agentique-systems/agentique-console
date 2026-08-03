/** The gate rule: no workspaces means the gate, never the shell. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScopeStore } from "@/stores/scope";

import { App } from "./app";

function stubFetch(workspaces: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/workspaces") ? workspaces : {};
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

describe("App", () => {
  beforeEach(() => {
    useScopeStore.setState({ selectedWorkspaceId: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the gate, not the shell, when there are no workspaces", async () => {
    stubFetch([]);
    render(createElement(App), { wrapper: wrapper() });

    expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.queryByText("conversation")).not.toBeInTheDocument();
  });

  it("renders the gate when the persisted id no longer exists", async () => {
    useScopeStore.setState({ selectedWorkspaceId: "ws_gone" });
    stubFetch([
      {
        id: "ws_1",
        name: "alpha",
        rootPath: "/home/cairon/alpha",
        metadata: {},
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    render(createElement(App), { wrapper: wrapper() });

    expect(
      await screen.findByText("Choose a workspace"),
    ).toBeInTheDocument();
    expect(screen.queryByText("conversation")).not.toBeInTheDocument();
  });
});
