/**
 * The plan/requirements approval card — review regressions: the operator's
 * edit survives the Edit/Preview toggle, so approve must send it and the
 * preview must show it from EITHER pane; an invalid draft blocks Approve and
 * shows its parse errors even in preview mode.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanCard } from "./plan-card";
import type { PlanItem } from "./user-fold";

const ITEM: PlanItem = {
  type: "plan",
  interactionId: "int_1",
  plan: "## Requirements\n- r1: p95 latency under 300ms\n",
  requirements: { revision: 1, nodeCount: 1 },
};

function stubFetch(posts: { url: string; body: unknown }[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, statusText: "", json: () => Promise.resolve({}) } as Response;
  }));
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => vi.unstubAllGlobals());

describe("PlanCard edit-in-place", () => {
  it("the edit survives the Preview toggle: the preview shows the draft and approve sends it", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch(posts);
    const user = userEvent.setup();
    render(<PlanCard sessionId="us_1" item={ITEM} onRequestChanges={() => {}} />, { wrapper: wrapper() });

    await user.click(screen.getByText("Edit"));
    const textarea = screen.getByLabelText("edit the proposed text");
    await user.clear(textarea);
    await user.type(textarea, "## Requirements{enter}- r1: p95 latency under 200ms");
    // Back to the preview — the pending edit, not the superseded proposal.
    await user.click(screen.getByText("Preview"));
    expect(screen.getByText("p95 latency under 200ms")).toBeTruthy();
    expect(screen.queryByText("p95 latency under 300ms")).toBeNull();

    await user.click(screen.getByText("Approve & execute"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      decision: "approve",
      editedDocument: "## Requirements\n- r1: p95 latency under 200ms",
    });
  });

  it("an invalid dirty draft keeps Approve disabled and its parse errors visible from the preview", async () => {
    stubFetch([]);
    const user = userEvent.setup();
    render(<PlanCard sessionId="us_1" item={ITEM} onRequestChanges={() => {}} />, { wrapper: wrapper() });

    await user.click(screen.getByText("Edit"));
    const textarea = screen.getByLabelText("edit the proposed text");
    await user.clear(textarea);
    await user.type(textarea, "no requirements section at all");
    await user.click(screen.getByText("Preview"));

    expect((screen.getByText("Approve & execute") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("requirements-parse-errors")).toBeTruthy();
  });
});

describe("PlanCard scoped amendments", () => {
  it("renders the scope chain and the server-computed change summary", () => {
    stubFetch([]);
    const item: PlanItem = {
      type: "plan",
      interactionId: "int_2",
      plan: "## Requirements\n- r4: Hits register within one frame\n- Misses are telegraphed\n",
      requirements: {
        revision: 3,
        nodeCount: 2,
        kind: "subtree",
        scope: { scopeId: "r1", statement: "Combat resolves hits and misses", ancestors: [] },
        summary: {
          added: ["Misses are telegraphed"],
          changed: [{ id: "r4", statement: "Hits register within one frame" }],
          retired: [{ id: "r5", statement: "Combat pauses on focus loss" }],
        },
      },
    };
    render(createElement(PlanCard, { sessionId: "us_1", item, onRequestChanges: () => {} }), { wrapper: wrapper() });
    expect(screen.getByText(/proposed amendment under r1/i)).toBeTruthy();
    const scope = screen.getByTestId("requirements-scope");
    expect(scope.textContent).toContain("r1 Combat resolves hits and misses");
    const summary = screen.getByTestId("requirements-summary");
    expect(summary.textContent).toContain("+ new: Misses are telegraphed");
    expect(summary.textContent).toContain("~ r4 changes (its status resets to open)");
    expect(summary.textContent).toContain("− r5 retires (its id never returns)");
  });
});
