/**
 * The server process behind the web application test: the production
 * composition over the directory named by `WEB_TEST_DIR`, the SDK fixture
 * as the provider, the coding fixture repository beside it, listening on a
 * free loopback port. The parent scripts the fixture over IPC by name (the
 * turns hold functions and cannot cross the process boundary), asks for the
 * remaining turn count, and closes the server; the web test itself imports
 * nothing from the server and speaks only HTTP.
 */
import { completionTurns, initFixtureRepo, planTurn, workerTurn } from "./e2e-fixture.ts";
import { openTestApp } from "./test-support.ts";

export type WebTestRequest = { kind: "script"; name: "coding" | "hang"; workspaceId: string } | { kind: "remaining" } | { kind: "close" };
export type WebTestReply = { kind: "ready"; url: string; repo: string } | { kind: "scripted"; name: string } | { kind: "remaining"; value: number } | { kind: "error"; message: string };

const dir = process.env.WEB_TEST_DIR;
if (dir === undefined) throw new Error("WEB_TEST_DIR names the directory");
const send = (reply: WebTestReply): void => {
  process.send!(reply);
};

const t = await openTestApp({ dir });
const repo = initFixtureRepo(dir);
const url = await t.app.server.listen({ port: 0, host: "127.0.0.1" });

process.on("message", (message: WebTestRequest) => {
  void (async () => {
    try {
      switch (message.kind) {
        case "script": {
          if (message.name === "coding") {
            const loaded = t.app.runtime.agents.loader.loadCurrent(message.workspaceId as never, { kind: "branch", branch: "main" });
            const implementer = loaded.files.find((f) => f.kind === "loaded" && f.name === "implementer");
            if (implementer === undefined || implementer.kind !== "loaded") throw new Error(`implementer not loaded: ${JSON.stringify(loaded.files)}`);
            t.sdk.script(planTurn(implementer.revisionId, []), workerTurn(null), ...completionTurns());
          } else {
            t.sdk.script({ steps: [{ kind: "hang" }] }, { steps: [{ kind: "hang" }] });
          }
          send({ kind: "scripted", name: message.name });
          return;
        }
        case "remaining":
          send({ kind: "remaining", value: t.sdk.remainingTurns });
          return;
        case "close":
          await t.close();
          process.exit(0);
      }
    } catch (error) {
      send({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
});

send({ kind: "ready", url, repo });
