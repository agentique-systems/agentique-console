/** The card's contract: the right POST body, and read-only once answered. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuestionCard } from "./question-card";
import type { QuestionItem } from "./user-fold";

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

const ITEM: QuestionItem = {
  type: "question",
  interactionId: "int_1",
  questions: [
    {
      question: "Deploy?",
      options: [
        { label: "Yes", description: "ship it" },
        { label: "No" },
      ],
    },
  ],
};

describe("QuestionCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a single single-select question submits on click with the right body", async () => {
    const spy = stubRoutes([
      {
        match: (url, init) =>
          url.endsWith("/api/user-sessions/us_1/interactions/int_1") &&
          init?.method === "POST",
        status: 200,
        body: { id: "int_1", status: "answered" },
      },
    ]);
    const user = userEvent.setup();
    render(createElement(QuestionCard, { sessionId: "us_1", item: ITEM }), {
      wrapper: wrapper(),
    });

    await user.click(screen.getByRole("button", { name: /Yes/ }));

    await waitFor(() => {
      const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        answers: { "Deploy?": ["Yes"] },
      });
    });
  });

  it("an answered card is read-only with the chosen option highlighted", () => {
    stubRoutes([]);
    render(
      createElement(QuestionCard, {
        sessionId: "us_1",
        item: { ...ITEM, answer: { answers: { "Deploy?": ["Yes"] } } },
      }),
      { wrapper: wrapper() },
    );

    const yes = screen.getByRole("button", { name: /Yes/ });
    const no = screen.getByRole("button", { name: /No/ });
    expect(yes).toBeDisabled();
    expect(no).toBeDisabled();
    expect(yes.className).toContain("border-status-completed");
    expect(no.className).not.toContain("border-status-completed");
  });

  it("a 409 (answered elsewhere) settles the card locally", async () => {
    stubRoutes([
      {
        match: (url, init) =>
          url.endsWith("/api/user-sessions/us_1/interactions/int_1") &&
          init?.method === "POST",
        status: 409,
        body: {
          error: { code: "conflict", message: "already answered" },
        },
      },
    ]);
    const user = userEvent.setup();
    render(createElement(QuestionCard, { sessionId: "us_1", item: ITEM }), {
      wrapper: wrapper(),
    });

    await user.click(screen.getByRole("button", { name: /Yes/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Yes/ })).toBeDisabled(),
    );
  });
});
