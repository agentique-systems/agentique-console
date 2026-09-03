/**
 * The server process behind the web application tests (the jsdom suite and
 * the driven-browser suite): the production composition over the directory
 * named by `WEB_TEST_DIR`, the SDK fixture as the provider, the coding
 * fixture repository beside it, listening on a free loopback port and
 * serving the built web application when `web/dist` exists. The parent
 * scripts the fixture over IPC by name (the turns hold functions and cannot
 * cross the process boundary), asks for the remaining turn count, and
 * closes the server; the web tests import nothing from the server and speak
 * only HTTP.
 */
import { completionTurns, initFixtureRepo, planTurn, returned, tool, workerTurn } from "./e2e-fixture.ts";
import { openTestApp } from "./test-support.ts";

export type WebTestScript = "coding" | "hang" | "review" | "decisions";
export type WebTestRequest = { kind: "script"; name: WebTestScript; workspaceId: string } | { kind: "remaining" } | { kind: "disconnect" } | { kind: "close" };
export type WebTestReply = { kind: "ready"; url: string; repo: string; webDir: string; servesWeb: boolean } | { kind: "scripted"; name: string } | { kind: "remaining"; value: number } | { kind: "disconnected"; count: number } | { kind: "error"; message: string };

const dir = process.env.WEB_TEST_DIR;
if (dir === undefined) throw new Error("WEB_TEST_DIR names the directory");
const send = (reply: WebTestReply): void => {
  process.send!(reply);
};

const t = await openTestApp({ dir });
const repo = initFixtureRepo(dir);
const url = await t.app.server.listen({ port: 0, host: "127.0.0.1" });

/** A blocking operator Decision with two options; the turn ends on it. */
const decisionRequest = (question: string) => ({ kind: "tool_use" as const, name: tool("request_decision"), input: { kind: "operator_choice", question, options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], recommendedOptionKey: "yes", resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } });

/** The Orchestrator's own recorded choice: a resolved `orchestrator_choice` Decision, one per call. */
const recorded = (n: number) => ({ kind: "tool_use" as const, name: tool("record_decision"), input: { question: `Recorded choice ${n}?`, options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], chosenOptionKey: "a", rationale: `choice ${n}`, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } });

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
          } else if (message.name === "hang") {
            t.sdk.script({ steps: [{ kind: "hang" }] }, { steps: [{ kind: "hang" }] });
          } else if (message.name === "review") {
            // The first turn reads the Requirements (as a model would, to learn the operator's goal's id), proposes a tree that keeps
            // that goal and adds one leaf, then asks a Decision; the successor (the resolution) and the later turn that receives the
            // approved proposal both simply return.
            const proposal = (calls: { tool: string; text: string }[]) => {
              const read = [...calls].reverse().find((c) => c.tool.endsWith("read_requirements"));
              const goalId = read === undefined ? null : /"requirementId":"(req_[A-Za-z0-9]+)"/.exec(read.text)?.[1];
              if (goalId === null || goalId === undefined) throw new Error(`no Requirement read yet: ${JSON.stringify(calls.map((c) => [c.tool, c.text.slice(0, 200)]))}`);
              return {
                requirements: [
                  { key: "goal", parentKey: null, composition: "all", statement: "Add a --version flag to the CLI.", requirementId: goalId, acceptanceCriteria: [] },
                  { key: "flag", parentKey: "goal", composition: null, statement: "`--version` prints the version from package.json and exits 0.", requirementId: null, acceptanceCriteria: [{ kind: "deterministic", command: "node src/cli.js --version", expectedExitCode: 0 }] },
                ],
                rationale: "Split the goal into the one testable behaviour.",
              };
            };
            t.sdk.script(
              { steps: [{ kind: "tool_use", name: tool("read_requirements"), input: {} }, { kind: "tool_use", name: tool("propose_requirements"), input: {}, inputFrom: proposal }, decisionRequest("Which flag spelling?")] },
              { steps: [returned("Acknowledged the resolution.")] },
              { steps: [returned("Noted the approved Requirements.")] },
            );
          } else {
            // Fifty-two recorded choices, then an open Decision: the open one sits beyond the first page of the unfiltered history.
            t.sdk.script({ steps: [...Array.from({ length: 52 }, (_, i) => recorded(i + 1)), decisionRequest("The fifty-third: proceed?")] }, { steps: [returned("Acknowledged the resolution.")] });
          }
          send({ kind: "scripted", name: message.name });
          return;
        }
        case "remaining":
          send({ kind: "remaining", value: t.sdk.remainingTurns });
          return;
        case "disconnect":
          // The server drops every event-stream subscriber (as a restart or a proxy would); each client resumes from its last sequence.
          send({ kind: "disconnected", count: t.app.events.disconnectAll() });
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

send({ kind: "ready", url, repo, webDir: t.config.webDir, servesWeb: (await import("node:fs")).existsSync(t.config.webDir) });
