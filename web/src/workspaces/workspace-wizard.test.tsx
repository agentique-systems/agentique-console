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
    return { ok: status >= 200 && status < 300, status, statusText: "status-text", json: () => Promise.resolve(route?.body ?? {}) } as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

const ROOTS: Route = {
  match: (url) => url.includes("/api/fs/roots"),
  status: 200,
  body: { roots: [{ label: "cairon", path: "/home/cairon" }] },
};
const DIRS_HOME: Route = {
  match: (url) => url.includes("/api/fs/dirs") && url.endsWith("%2Fcairon"),
  status: 200,
  body: { path: "/home/cairon", parent: "/home", entries: [{ name: "git", path: "/home/cairon/git", hidden: false }] },
};
const DIRS_GIT: Route = {
  match: (url) => url.includes("/api/fs/dirs") && url.endsWith("%2Fgit"),
  status: 200,
  body: { path: "/home/cairon/git", parent: "/home/cairon", entries: [] },
};

function workspace(rootPath: string, name: string) {
  return { id: "ws_new", name, rootPath, metadata: {}, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
}

describe("WorkspaceWizard", () => {
  beforeEach(() => useScopeStore.setState({ selectedWorkspaceId: null }));
  afterEach(() => vi.unstubAllGlobals());

  it("adopts the directory being browsed and derives its workspace name", async () => {
    const spy = stubRoutes([
      ROOTS, DIRS_HOME, DIRS_GIT,
      { match: (url, init) => url.endsWith("/api/workspaces") && init?.method === "POST", status: 201, body: workspace("/home/cairon/git", "git") },
    ]);
    const user = userEvent.setup();
    render(createElement(WorkspaceWizard, { open: true, onOpenChange: () => {} }), { wrapper: wrapper() });

    await user.click(await screen.findByRole("button", { name: "git" }));
    await user.click(await screen.findByRole("button", { name: "Use this folder" }));

    await waitFor(() => expect(useScopeStore.getState().selectedWorkspaceId).toBe("ws_new"));
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "git", rootPath: "/home/cairon/git", create: false });
  });

  it("defines a new folder inline and creates it only when confirmed", async () => {
    const spy = stubRoutes([
      ROOTS, DIRS_HOME,
      { match: (url, init) => url.endsWith("/api/workspaces") && init?.method === "POST", status: 201, body: workspace("/home/cairon/demo", "Demo project") },
    ]);
    const user = userEvent.setup();
    render(createElement(WorkspaceWizard, { open: true, onOpenChange: () => {} }), { wrapper: wrapper() });

    await screen.findByRole("button", { name: "git" });
    await user.click(await screen.findByRole("button", { name: "New folder" }));
    await user.type(await screen.findByLabelText("new folder name"), "demo");
    await user.click(screen.getByRole("button", { name: "Choose new folder" }));
    const name = screen.getByLabelText(/Workspace name/);
    await user.clear(name);
    await user.type(name, "Demo project");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    const post = await waitFor(() => spy.mock.calls.find(([, init]) => init?.method === "POST"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "Demo project", rootPath: "/home/cairon/demo", create: true });
  });

  it("shows the server error and keeps the dialog open", async () => {
    stubRoutes([
      ROOTS, DIRS_HOME, DIRS_GIT,
      { match: (url, init) => url.endsWith("/api/workspaces") && init?.method === "POST", status: 409, body: { error: { code: "conflict", message: 'A workspace already uses the directory "/home/cairon/git".' } } },
    ]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(createElement(WorkspaceWizard, { open: true, onOpenChange }), { wrapper: wrapper() });

    await user.click(await screen.findByRole("button", { name: "git" }));
    await user.click(await screen.findByRole("button", { name: "Use this folder" }));

    expect(await screen.findByTestId("wizard-error")).toHaveTextContent("already uses the directory");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(useScopeStore.getState().selectedWorkspaceId).toBeNull();
  });
});
