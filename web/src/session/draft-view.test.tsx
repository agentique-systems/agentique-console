/**
 * The draft view's contract: Enter starts the session, Shift+Tab cycles the
 * mode, and the model rides along on the create call.
 *
 * The composition case is the reason this file exists. The hand-rolled
 * `event.key === "Enter"` check this view used to carry fired on the Enter that
 * COMMITS an IME candidate, so every CJK input method created a session out of
 * a half-typed word. Rebuilding on the vendored prompt-input inherits the
 * `isComposing` guard; this test is what keeps it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScopeStore } from "@/stores/scope";

import { DraftView } from "./draft-view";

function stubFetch() {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () =>
      Promise.resolve(
        String(input).endsWith("/api/config")
          ? { defaultModel: "claude-opus-5" }
          : { session: { id: "us_new" } },
      ),
  }) as Response);
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

const created = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/api/user-sessions") && init?.method === "POST",
  );

function mount() {
  return render(createElement(DraftView), { wrapper: wrapper() });
}

describe("DraftView", () => {
  beforeEach(() => useScopeStore.setState({ selectedWorkspaceId: "ws_1" }));
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

    await user.click(await screen.findByLabelText("orchestrator model: opus-5"));
    await user.click(await screen.findByText("claude-fable-5"));

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
});
