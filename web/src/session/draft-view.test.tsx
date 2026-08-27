/**
 * The draft view's contract: Enter starts the session, Shift+Tab cycles the
 * mode, and the model rides along on the create call. Enter must NOT fire on
 * the keypress that COMMITS an IME candidate — the vendored prompt-input's
 * `isComposing` guard covers it, and this test is what keeps it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectContinuationItem } from "@agentique-console/shared";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

import { DraftView } from "./draft-view";

function stubFetch(projects: ProjectContinuationItem[] = []) {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () =>
      Promise.resolve(
        String(input).endsWith("/api/config")
          ? { defaultModel: "claude-opus-5" }
          : String(input).endsWith("/projects")
            ? projects
            : { session: { id: "us_new" } },
      ),
  }) as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** A continuation candidate row as the discovery endpoint ships it. */
function projectItem(overrides: Partial<ProjectContinuationItem> = {}): ProjectContinuationItem {
  return {
    id: "proj_1",
    name: "Straf3 movement wave",
    intentPreview: "Canonical movement plus measured responsiveness",
    openSession: null,
    lastSession: {
      id: "us_old", title: "Straf3 movement wave", lifecycle: "archived",
      runState: "active", pauseReason: "capacity", updatedAt: "2026-08-26T19:09:38Z",
    },
    sessionCount: 1,
    hasCheckpoint: true,
    openRequirements: 14,
    createdAt: "2026-08-26T17:33:39Z",
    ...overrides,
  };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

const created = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/api/user-sessions") && init?.method === "POST",
  );

function mount() {
  return render(createElement(DraftView), { wrapper: wrapper() });
}

describe("DraftView", () => {
  beforeEach(() => {
    useScopeStore.setState({ selectedWorkspaceId: "ws_1" });
    useUiStore.setState({ draftOpen: true, draftContinuation: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Enter creates the session with the typed message", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByRole("textbox"), "review the auth module");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(JSON.parse(String(created(spy)?.[1]?.body))).toEqual({
        workspaceId: "ws_1",
        mode: "execute",
        message: "review the auth module",
      }),
    );
  });

  it("Enter mid-IME-composition commits the candidate, it does not send", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    const box = screen.getByRole("textbox");
    await user.type(box, "認証");
    // What an IME actually emits: composing is still true on the Enter that
    // accepts the candidate.
    box.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    await user.keyboard("{Enter}");

    expect(created(spy)).toBeUndefined();
  });

  it("shift+tab cycles the mode without touching the server", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    screen.getByRole("textbox").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");

    await screen.findByText(
      "the orchestrator plans first and waits for your approval",
    );
    expect(created(spy)).toBeUndefined();
  });

  it("a picked model rides along on the create call", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("radio", { name: "fable-5" }));

    await user.type(screen.getByRole("textbox"), "do the thing");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(JSON.parse(String(created(spy)?.[1]?.body))).toMatchObject({
        model: "claude-fable-5",
      }),
    );
  });

  it("an untouched picker omits the model, so CONSOLE_MODEL still decides", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByRole("textbox"), "do the thing");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(JSON.parse(String(created(spy)?.[1]?.body))).not.toHaveProperty(
        "model",
      ),
    );
  });

  it("with no continuable projects there is no picker and create is unchanged", async () => {
    const spy = stubFetch([]);
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByRole("textbox"), "fresh work");
    await user.keyboard("{Enter}");

    expect(screen.queryByTestId("draft-project-picker")).toBeNull();
    await waitFor(() =>
      expect(JSON.parse(String(created(spy)?.[1]?.body))).not.toHaveProperty("projectId"),
    );
  });

  it("selecting a project sends projectId — explicit continuation, never silent attachment", async () => {
    const spy = stubFetch([projectItem()]);
    const user = userEvent.setup();
    mount();

    // The default stays "start a new project" until the operator picks.
    const newProject = await screen.findByRole("radio", { name: "Start a new project" });
    expect(newProject).toHaveAttribute("aria-checked", "true");
    await screen.findByText(/stopped by provider quota/);
    await screen.findByText(/14 open requirements/);

    await user.click(screen.getByRole("radio", { name: /Straf3 movement wave/ }));
    await screen.findByTestId("draft-continuation-consequence");
    await user.type(screen.getByRole("textbox"), "continue the movement work, land maps first");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(JSON.parse(String(created(spy)?.[1]?.body))).toMatchObject({
        workspaceId: "ws_1",
        message: "continue the movement work, land maps first",
        projectId: "proj_1",
      }),
    );
  });

  it("a paused-open project routes through the continue endpoint — a handoff, not a plain create", async () => {
    const spy = stubFetch([
      projectItem({
        openSession: { id: "us_paused", title: "Straf3 movement wave", pauseReason: "capacity" },
      }),
    ]);
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("radio", { name: /Straf3 movement wave/ }));
    // The consequence is on screen before the send: the old session is handed off.
    await screen.findByText(/hands off the paused session/);
    await user.type(screen.getByRole("textbox"), "close this iteration; continue fresh");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const call = spy.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith("/api/user-sessions/us_paused/continue") &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        message: "close this iteration; continue fresh",
      });
    });
    expect(created(spy)).toBeUndefined();
  });

  it("an open project that is NOT paused is not offered for continuation", async () => {
    stubFetch([
      projectItem({
        openSession: { id: "us_running", title: "Straf3 movement wave", pauseReason: null },
      }),
    ]);
    mount();

    await screen.findByRole("textbox");
    expect(screen.queryByTestId("draft-project-picker")).toBeNull();
  });

  it("a session's 'continue in a fresh session' pre-seeds the picker", async () => {
    stubFetch([projectItem()]);
    useUiStore.setState({ draftContinuation: { projectId: "proj_1", handoffSessionId: null } });
    mount();

    const row = await screen.findByRole("radio", { name: /Straf3 movement wave/ });
    await waitFor(() => expect(row).toHaveAttribute("aria-checked", "true"));
  });
});
