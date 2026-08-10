/**
 * The composer's contract: one button covering send/steer/interrupt, Shift+Tab
 * cycling the mode, and the rewrite pass replacing the draft.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserSession } from "@agentique-console/shared";

import { Composer } from "./composer";

function stubFetch(body: unknown = {}) {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    // The model chip is held back until /api/config lands, so every mount
    // needs a real answer here even when the test is about something else.
    json: () =>
      Promise.resolve(
        String(input).endsWith("/api/config")
          ? { defaultModel: "claude-opus-5" }
          : body,
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

const SESSION: UserSession = {
  id: "us_1",
  workspaceId: "ws_1",
  title: "test",
  mode: "execute",
  phase: "executing",
  status: "open",
  runState: "active",
  model: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mount(overrides: Partial<{ session: UserSession; busy: boolean }> = {}) {
  return render(
    createElement(Composer, {
      session: SESSION,
      busy: false,
      ...overrides,
    }),
    { wrapper: wrapper() },
  );
}

describe("Composer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("idle + empty: send, disabled", () => {
    stubFetch();
    mount();
    expect(screen.getByLabelText("send message")).toBeDisabled();
  });

  it("idle + text: send, enabled", async () => {
    stubFetch();
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByRole("textbox"), "do the thing");
    expect(screen.getByLabelText("send message")).toBeEnabled();
  });

  it("busy + empty: the button becomes interrupt and POSTs to /interrupt", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount({ busy: true });

    const stop = screen.getByLabelText("interrupt the running turn");
    expect(stop).toBeEnabled();
    await user.click(stop);

    await waitFor(() =>
      expect(
        spy.mock.calls.some(([url, init]) =>
          String(url).endsWith("/api/user-sessions/us_1/interrupt") &&
          init?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("busy + text: the button steers, posting the message as the next turn", async () => {
    const spy = stubFetch({ messageId: "m_1", seq: 1 });
    const user = userEvent.setup();
    mount({ busy: true });

    await user.type(screen.getByRole("textbox"), "actually do this instead");
    expect(screen.queryByLabelText("interrupt the running turn")).toBeNull();
    await user.click(screen.getByLabelText("steer the running turn"));

    await waitFor(() => {
      const post = spy.mock.calls.find(([url]) =>
        String(url).endsWith("/api/user-sessions/us_1/messages"),
      );
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        text: "actually do this instead",
      });
    });
  });

  it("an archived session never offers interrupt, even mid-turn", () => {
    stubFetch();
    mount({ session: { ...SESSION, status: "archived" }, busy: true });
    expect(screen.getByLabelText("send message")).toBeDisabled();
  });

  it("shift+tab in the textarea patches the session to the next mode", async () => {
    const spy = stubFetch(SESSION);
    const user = userEvent.setup();
    mount();

    screen.getByRole("textbox").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");

    await waitFor(() => {
      const patch = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        mode: "plan_execute",
      });
    });
  });

  it("improve replaces the draft with the rewrite", async () => {
    const spy = stubFetch({ text: "Review the auth module." });
    const user = userEvent.setup();
    mount();

    const box = screen.getByRole("textbox");
    await user.type(box, "hey can u look at teh auth module");
    await user.click(screen.getByLabelText("improve wording"));

    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe(
        "Review the auth module.",
      ),
    );
    expect(
      spy.mock.calls.some(([url]) =>
        String(url).endsWith("/api/compose/improve"),
      ),
    ).toBe(true);
  });

  it("improve is disabled on an empty draft", () => {
    stubFetch();
    mount();
    expect(screen.getByLabelText("improve wording")).toBeDisabled();
  });

  it("a session with no model shows the server default on the chip", async () => {
    stubFetch();
    mount();
    await screen.findByLabelText("orchestrator model: opus-5");
  });

  it("the session's own model wins over the server default", async () => {
    stubFetch();
    mount({ session: { ...SESSION, model: "claude-sonnet-5" } });
    await screen.findByLabelText("orchestrator model: sonnet-5");
  });

  /**
   * The chip lives inside PromptInput's <form>. A DialogTrigger defaults to a
   * submit button, so without asChild onto PromptInputButton this click would
   * send the message instead of opening the picker.
   */
  it("clicking the model chip opens the picker without sending the draft", async () => {
    const spy = stubFetch();
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByRole("textbox"), "do not send me");
    await user.click(await screen.findByLabelText("orchestrator model: opus-5"));

    await screen.findByPlaceholderText("search models…");
    expect(
      spy.mock.calls.some(([url]) =>
        String(url).endsWith("/api/user-sessions/us_1/messages"),
      ),
    ).toBe(false);
  });

  it("picking a model patches the session", async () => {
    const spy = stubFetch(SESSION);
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByLabelText("orchestrator model: opus-5"));
    await user.click(await screen.findByText("claude-fable-5"));

    await waitFor(() => {
      const patch = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
        model: "claude-fable-5",
      });
    });
  });
});
