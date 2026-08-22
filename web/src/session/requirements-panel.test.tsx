/**
 * The requirements panel: the tree renders derived statuses, verification and
 * delegation chips, the frontier's annotations, and the operator's own
 * verdict posts to the status route (their word IS the gate).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GetRequirementsResponse, RequirementNodeWire } from "@agentique-console/shared";

import { RequirementsPanel } from "./requirements-panel";

function node(over: Partial<RequirementNodeWire> & { id: string }): RequirementNodeWire {
  return {
    parentId: null, ord: 0, statement: `statement ${over.id}`, composition: "all",
    status: "open", derivedStatus: "open", origin: "committed",
    introducedInRevision: 1, retiredInRevision: null, refinedByAgentSessionId: null,
    delegatedTo: [], latestChange: null, ...over,
  };
}

const RESPONSE: GetRequirementsResponse = {
  revisions: [{
    id: "req_1", revision: 1, document: "## Requirements\n- r1: Auth works",
    changeNote: "initial", status: "approved", origin: "main", interactionId: null,
    nodeCount: 3, createdAt: "2026-08-22T00:00:00Z", approvedAt: "2026-08-22T00:01:00Z",
  }],
  approved: {
    id: "req_1", revision: 1, document: "## Requirements\n- r1: Auth works",
    changeNote: "initial", status: "approved", origin: "main", interactionId: null,
    nodeCount: 3, createdAt: "2026-08-22T00:00:00Z", approvedAt: "2026-08-22T00:01:00Z",
  },
  nodes: [
    node({ id: "r1", statement: "Auth works end to end", derivedStatus: "open", delegatedTo: ["as_1"] }),
    node({ id: "r2", parentId: "r1", statement: "Login issues a token", status: "satisfied", derivedStatus: "satisfied",
      latestChange: { status: "satisfied", verifiedBy: "independent", actor: "checker", evidenceCount: 2, at: "2026-08-22T01:00:00Z" } }),
    node({ id: "r3", parentId: "r1", ord: 1, statement: "Sessions expire", origin: "refinement", refinedByAgentSessionId: "as_1" }),
  ],
  frontier: [{ requirementId: "r3", statement: "Sessions expire", annotations: ["in_progress", "awaiting_operator"] }],
};

function stubFetch(posts: { url: string; body: unknown }[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, statusText: "", json: () => Promise.resolve(RESPONSE.nodes[2]) } as Response;
    }
    return { ok: true, status: 200, statusText: "", json: () => Promise.resolve(RESPONSE) } as Response;
  }));
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

afterEach(() => vi.unstubAllGlobals());

describe("RequirementsPanel", () => {
  it("renders the tree with statuses, verification, delegation and refinement chips, and the frontier", async () => {
    stubFetch([]);
    render(<RequirementsPanel userSessionId="us_1" />, { wrapper: wrapper() });
    await screen.findByTestId("requirements-panel");

    expect(screen.getByText("rev 1")).toBeTruthy();
    expect(screen.getByText("1/3 satisfied")).toBeTruthy();
    expect(screen.getByText("Auth works end to end")).toBeTruthy();
    // r2's verification chip: independent, evidence count.
    expect(screen.getByText("independent · 2 evidence")).toBeTruthy();
    // r1's delegation chip and r3's refinement badge.
    expect(screen.getByText("delegated ×1")).toBeTruthy();
    expect(screen.getByText("refined")).toBeTruthy();
    // The frontier names the open leaf with its annotations.
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.getByText("awaiting you")).toBeTruthy();
  });

  it("posts the operator's verdict with an optional note", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch(posts);
    const user = userEvent.setup();
    render(<RequirementsPanel userSessionId="us_1" />, { wrapper: wrapper() });
    await screen.findByTestId("requirements-panel");

    // r3 is an open leaf → mark infeasible with a note.
    await user.click(screen.getAllByText("mark infeasible")[0]!);
    await user.type(screen.getByPlaceholderText(/why infeasible/), "no session store exists");
    await user.click(screen.getByText("confirm infeasible"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain("/api/user-sessions/us_1/requirements/r3/status");
    expect(posts[0]!.body).toEqual({ status: "infeasible", note: "no session store exists" });
  });

  // Review regression: a note typed for a CANCELLED verdict must never ride a
  // later status change — reopen posts no note, and the journal stays honest.
  it("a cancelled confirm note does not leak into a later status post", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch(posts);
    const user = userEvent.setup();
    render(<RequirementsPanel userSessionId="us_1" />, { wrapper: wrapper() });
    await screen.findByTestId("requirements-panel");

    await user.click(screen.getAllByText("mark satisfied")[0]!);
    await user.type(screen.getByPlaceholderText(/why satisfied/), "verified by running the e2e suite");
    await user.click(screen.getByText("cancel"));
    // r2 is a satisfied leaf → reopen posts immediately, and must carry NO note.
    await user.click(screen.getAllByText("reopen")[0]!);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ status: "open" });
  });

  it("says so plainly when no requirements govern", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, statusText: "",
      json: () => Promise.resolve({ revisions: [], approved: null, nodes: [], frontier: [] }),
    } as Response)));
    render(<RequirementsPanel userSessionId="us_1" />, { wrapper: wrapper() });
    await screen.findByText(/No approved requirements/);
  });
});
