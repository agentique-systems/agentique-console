/** The install-wide pause routes over the real app graph (fastify inject). */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.ts";
import { initMessage, successMessage } from "../../sdk/fake.ts";
import { makeHarness } from "../../test-helpers.ts";

const quiet = { info() {}, warn() {}, error() {} };

describe("system pause routes", () => {
  const servers: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

  it("GET reflects POST pause / POST resume; the legacy resume-capacity route still resumes", async () => {
    const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const server = buildServer({ app: h.app, config: h.config, log: quiet });
    servers.push(server);

    const before = await server.inject({ method: "GET", url: "/api/system/pause" });
    expect(before.json()).toEqual({ paused: false, reason: null, since: null, until: null });

    const paused = await server.inject({ method: "POST", url: "/api/system/pause", payload: { detail: "top bar" } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ paused: true, reason: "operator", until: null, detail: "top bar", interrupted: { main: 0, seats: 0 } });
    expect((await server.inject({ method: "GET", url: "/api/system/pause" })).json()).toMatchObject({ paused: true, reason: "operator" });
    expect(h.repo.getUserSession(userSessionId)?.pauseReason).toBe("operator");

    const bad = await server.inject({ method: "POST", url: "/api/system/pause", payload: { mode: "sideways" } });
    expect(bad.statusCode).toBe(400);

    const resumed = await server.inject({ method: "POST", url: "/api/system/resume" });
    expect(resumed.json()).toMatchObject({ paused: false, reason: null });

    await server.inject({ method: "POST", url: "/api/system/pause", payload: {} });
    const legacy = await server.inject({ method: "POST", url: `/api/user-sessions/${userSessionId}/resume-capacity` });
    expect(legacy.json()).toEqual({ resumed: true });
    expect(h.app.capacity.paused).toBe(false);
  });
});
