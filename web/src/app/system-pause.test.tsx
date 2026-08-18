/** The top-bar Pause/Resume and its banner, over a stubbed fetch. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pauseLine, SystemPauseBanner, SystemPauseControl } from "./system-pause";

const UNPAUSED = { paused: false, reason: null, since: null, until: null };
const PAUSED = { paused: true, reason: "operator" as const, since: "2026-08-17T20:14:00.000Z", until: null };

/** A server whose pause state flips on POST, like the real one. */
function stubServer(initial: typeof UNPAUSED | typeof PAUSED) {
  let state: Record<string, unknown> = initial;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/system/pause") && init?.method === "POST") state = { ...PAUSED, interrupted: { main: 1, seats: 2 } };
    if (url.endsWith("/api/system/resume")) state = UNPAUSED;
    return { ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(state) } as Response;
  }));
  return calls;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

describe("SystemPauseControl + SystemPauseBanner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads Pause when unpaused; a click pauses (hard) and flips to Resume with the banner", async () => {
    const calls = stubServer(UNPAUSED);
    render(createElement("div", null, createElement(SystemPauseControl), createElement(SystemPauseBanner)), { wrapper: wrapper() });
    const toggle = await screen.findByTestId("system-pause-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveTextContent("Pause");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("system-pause-banner")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("system-pause-toggle")).toHaveTextContent("Resume"));
    expect(calls).toContain("POST /api/system/pause");
    expect(screen.getByTestId("system-pause-toggle")).toHaveAttribute("aria-pressed", "true");
    const banner = screen.getByTestId("system-pause-banner");
    expect(banner).toHaveTextContent(/Paused by operator since .* · nothing cancelled/);

    fireEvent.click(screen.getByTestId("system-pause-toggle"));
    await waitFor(() => expect(screen.getByTestId("system-pause-toggle")).toHaveTextContent("Pause"));
    expect(calls).toContain("POST /api/system/resume");
    expect(screen.queryByTestId("system-pause-banner")).not.toBeInTheDocument();
  });

  it("the banner's own Resume button resumes", async () => {
    const calls = stubServer(PAUSED);
    render(createElement(SystemPauseBanner), { wrapper: wrapper() });
    const banner = await screen.findByTestId("system-pause-banner");
    fireEvent.click(banner.querySelector("button")!);
    await waitFor(() => expect(screen.queryByTestId("system-pause-banner")).not.toBeInTheDocument());
    expect(calls).toContain("POST /api/system/resume");
  });

  it("pauseLine names the reason and what happens next", () => {
    expect(pauseLine(UNPAUSED)).toBe("");
    expect(pauseLine({ ...PAUSED, since: null })).toBe("Paused by operator · nothing cancelled — queued work redelivers on Resume");
    expect(pauseLine({ paused: true, reason: "capacity", since: null, until: null, detail: "five_hour" })).toBe("Paused — provider capacity limit (five_hour) · resumes automatically on the next probe");
    expect(pauseLine({ paused: true, reason: "capacity", since: null, until: "2026-08-17T21:00:00.000Z" })).toMatch(/^Paused — provider capacity limit · resumes automatically at /);
    expect(pauseLine({ paused: true, reason: "budget", since: null, until: null })).toBe("Paused — budget ceiling reached · raise the budget or Resume");
  });
});
