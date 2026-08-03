/** The topbar combobox: filters by name and path, and switching sets scope. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScopeStore } from "@/stores/scope";

import { WorkspaceSelector } from "./workspace-selector";

const WORKSPACES = [
  {
    id: "ws_1",
    name: "console",
    rootPath: "/home/dev/git/agentique/console",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "ws_2",
    name: "scratch",
    rootPath: "/tmp/experiments/scratch",
    metadata: {},
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/workspaces") ? WORKSPACES : {};
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

describe("WorkspaceSelector", () => {
  beforeEach(() => {
    stubFetch();
    useScopeStore.setState({ selectedWorkspaceId: "ws_1" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the active workspace's name on the trigger", async () => {
    render(createElement(WorkspaceSelector), { wrapper: wrapper() });
    expect(
      await screen.findByRole("button", { name: /console/ }),
    ).toBeInTheDocument();
  });

  it("picking a row switches scope", async () => {
    const user = userEvent.setup();
    render(createElement(WorkspaceSelector), { wrapper: wrapper() });

    await user.click(await screen.findByTestId("workspace-selector"));
    await user.click(await screen.findByText("scratch"));

    await waitFor(() =>
      expect(useScopeStore.getState().selectedWorkspaceId).toBe("ws_2"),
    );
  });

  it("search matches the directory, not just the name", async () => {
    const user = userEvent.setup();
    render(createElement(WorkspaceSelector), { wrapper: wrapper() });

    await user.click(await screen.findByTestId("workspace-selector"));
    await user.type(
      await screen.findByPlaceholderText("search workspaces…"),
      "experiments",
    );

    // Scoped to the list: "console" is also the trigger's label.
    const list = await screen.findByRole("listbox");
    await waitFor(() =>
      expect(within(list).queryByText("console")).toBeNull(),
    );
    expect(within(list).getByText("scratch")).toBeInTheDocument();
  });
});
