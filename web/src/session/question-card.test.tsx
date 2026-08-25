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

  it("names its co-askers when the ask shares a decision issue — one answer resolves all", () => {
    const issue = {
      id: "di_1", issueKey: "auth", subject: "Should auth use SSO?", status: "open" as const,
      provisional: false, requirementIds: [],
      asks: [
        { interactionId: "int_1", agentSessionId: "as_1", asker: "auth-dev", question: "Deploy?", status: "pending" as const, urgency: "blocking" as const, autoProceeded: false, recommendation: null, createdAt: "2026-01-01T00:00:00Z" },
        { interactionId: "int_2", agentSessionId: "as_2", asker: "api-dev", question: "Enterprise identity?", status: "pending" as const, urgency: "blocking" as const, autoProceeded: false, recommendation: null, createdAt: "2026-01-01T00:01:00Z" },
      ],
      blockingAsksActive: 2, pendingAsksActive: 2, resolutions: [], resolution: null,
      supersededById: null, createdBy: "auth-dev", createdAt: "2026-01-01T00:00:00Z", resolvedAt: null,
    };
    render(createElement(QuestionCard, { sessionId: "us_1", item: ITEM, issue }), {
      wrapper: wrapper(),
    });

    const banner = screen.getByTestId("shared-issue");
    expect(banner.textContent).toContain("also asked by api-dev");
    expect(banner.textContent).toContain("one answer resolves all 2 asks");
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
