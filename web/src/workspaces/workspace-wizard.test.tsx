/** The wizard's contract: the right POST body, scope lands on the new id, and errors surface. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScopeStore } from "@/stores/scope";

import { WorkspaceWizard } from "./workspace-wizard";

interface Route {
  readonly match: (url: string, init?: RequestInit) => boolean;
  readonly status: number;
  readonly body: unknown;
}

function stubRoutes(routes: readonly Route[]) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const route = routes.find((candidate) => candidate.match(url, init));
    const status = route?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "status-text",
      json: () => Promise.resolve(route?.body ?? {}),
    } as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

const ROOTS: Route = {
  match: (url) => url.includes("/api/fs/roots"),
  status: 200,
  body: { roots: [{ label: "cairon", path: "/home/cairon" }] },
};
const DIRS_HOME: Route = {
  // URLSearchParams encodes "/" as %2F.
  match: (url) => url.includes("/api/fs/dirs") && url.endsWith("%2Fcairon"),
  status: 200,
  body: {
    path: "/home/cairon",
    parent: "/home",
    entries: [{ name: "git", path: "/home/cairon/git", hidden: false }],
  },
};
const DIRS_GIT: Route = {
  match: (url) => url.includes("/api/fs/dirs") && url.endsWith("%2Fgit"),
  status: 200,
  body: { path: "/home/cairon/git", parent: "/home/cairon", entries: [] },
};

/** Browses into /home/cairon/git, names the folder, and presses Create. */
async function runToSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "git" }));
  await user.click(await screen.findByRole("button", { name: /Next/ }));
  await user.type(await screen.findByLabelText("folder name"), "demo");
  await user.click(
    await screen.findByRole("button", { name: /Create workspace/ }),
  );
}

describe("WorkspaceWizard", () => {
  beforeEach(() => {
    useScopeStore.setState({ selectedWorkspaceId: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the browsed dir + folder name and scopes to the new workspace", async () => {
    const spy = stubRoutes([
      ROOTS,
      DIRS_HOME,
      DIRS_GIT,
      {
        match: (url, init) =>
          url.endsWith("/api/workspaces") && init?.method === "POST",
        status: 201,
        body: {
          id: "ws_new",
          name: "demo",
          rootPath: "/home/cairon/git/demo",
          metadata: {},
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    ]);
    const user = userEvent.setup();
    render(
      createElement(WorkspaceWizard, { open: true, onOpenChange: () => {} }),
      { wrapper: wrapper() },
    );

    await runToSubmit(user);

    await waitFor(() =>
      expect(useScopeStore.getState().selectedWorkspaceId).toBe("ws_new"),
    );
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      name: "demo",
      rootPath: "/home/cairon/git/demo",
      create: true,
    });
  });

  it("shows the server's error message and keeps the dialog open", async () => {
    stubRoutes([
      ROOTS,
      DIRS_HOME,
      DIRS_GIT,
      {
        match: (url, init) =>
          url.endsWith("/api/workspaces") && init?.method === "POST",
        status: 409,
        body: {
          error: {
            code: "conflict",
            message:
              'A workspace already uses the directory "/home/cairon/git/demo".',
          },
        },
      },
    ]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(createElement(WorkspaceWizard, { open: true, onOpenChange }), {
      wrapper: wrapper(),
    });

    await runToSubmit(user);

    expect(await screen.findByTestId("wizard-error")).toHaveTextContent(
      "already uses the directory",
    );
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalledWith(false));
    expect(useScopeStore.getState().selectedWorkspaceId).toBeNull();
  });
});
