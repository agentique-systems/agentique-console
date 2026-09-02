/**
 * The web application against the real server: a separate server process
 * (the production composition over a disposable directory, the SDK fixture
 * as the provider, a listening loopback port) and the application rendered
 * in jsdom, speaking only HTTP and the event stream. The normal operator
 * flow through the DOM — add a Workspace, open a Conversation, start a Run,
 * watch it reach signoff through the event subscription, accept the result,
 * request and confirm the publication, and see the Target published — then
 * the operator controls (pause, resume, cancel) and the truthful capability
 * state of a plain-directory Workspace. Nothing below the API is mocked.
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { setApiBase } from "@/api/client";
import { App } from "@/app/app";
import { createSubscription } from "@/live/subscription";
import { useScopeStore } from "@/stores/scope";

type Reply = { kind: "ready"; url: string; repo: string } | { kind: "scripted"; name: string } | { kind: "remaining"; value: number } | { kind: "error"; message: string };

const OLD_CLI = ["const args = process.argv.slice(2);", 'console.log("hello");', ""].join("\n");
const NEW_CLI = ["const args = process.argv.slice(2);", 'if (args[0] === "--version") {', "  console.log(require(" + "'../package.json').version);", "  process.exit(0);", "}", 'console.log("hello");', ""].join("\n");

function serverRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(dir, "server", "package.json"))) return path.join(dir, "server");
    dir = path.dirname(dir);
  }
  throw new Error("the server workspace was not found above the working directory");
}

class ServerProcess {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-web-"));
  #child: ChildProcess | null = null;
  #stderr = "";
  url = "";
  repo = "";

  async start(): Promise<void> {
    const root = serverRoot();
    const child = fork(path.join(root, "src", "api", "web-test-server.ts"), [], { cwd: root, execArgv: ["--import=tsx"], env: { ...process.env, WEB_TEST_DIR: this.dir, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.#child = child;
    const ready = await this.#next((r) => r.kind === "ready", 120_000);
    if (ready.kind !== "ready") throw new Error("unreachable");
    this.url = ready.url;
    this.repo = ready.repo;
  }

  async script(name: "coding" | "hang", workspaceId: string): Promise<void> {
    this.#child!.send({ kind: "script", name, workspaceId });
    const reply = await this.#next((r) => r.kind === "scripted" || r.kind === "error", 30_000);
    if (reply.kind === "error") throw new Error(reply.message);
  }

  async remaining(): Promise<number> {
    this.#child!.send({ kind: "remaining" });
    const reply = await this.#next((r) => r.kind === "remaining", 30_000);
    return reply.kind === "remaining" ? reply.value : -1;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.send({ kind: "close" });
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
    if (child.exitCode === null) child.kill();
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  get stderr(): string {
    return this.#stderr;
  }

  #next(accept: (reply: Reply) => boolean, timeoutMs: number): Promise<Reply> {
    const child = this.#child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error(`no reply from the server process within ${timeoutMs}ms; stderr: ${this.#stderr.slice(-2_000)}`));
      }, timeoutMs);
      const onMessage = (reply: Reply) => {
        if (!accept(reply)) return;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(reply);
      };
      child.on("message", onMessage);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the server process exited with ${code}; stderr: ${this.#stderr.slice(-2_000)}`));
      });
    });
  }
}

describe("the operator's web application over the real server", () => {
  const server = new ServerProcess();
  let queryClient: QueryClient;
  let subscription: ReturnType<typeof createSubscription>;
  const user = userEvent.setup();

  beforeAll(async () => {
    await server.start();
    setApiBase(server.url);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    subscription = createSubscription(queryClient);
    subscription.start();
  }, 180_000);

  afterAll(async () => {
    subscription.stop();
    cleanup();
    await server.close();
  });

  const mount = (initialPath = "/conversations") => {
    cleanup();
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App router={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };
  const cli = () => fs.readFileSync(path.join(server.repo, "src", "cli.js"), "utf8");
  const api = async <T,>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as T };
  };

  it("walks the normal flow: Workspace, Conversation, Run, live progress, signoff, publication", async () => {
    // 1. The gate: no Workspace yet; the wizard adopts the fixture repository through the browse roots.
    mount();
    await screen.findByTestId("workspace-gate", {}, { timeout: 30_000 });
    await user.click(screen.getByRole("button", { name: /New Workspace/ }));
    const wizard = await screen.findByTestId("workspace-wizard");
    const pathInput = within(wizard).getByLabelText("directory path");
    // The picker fills the first browse root once the roots load; clearing before that would be overwritten.
    await waitFor(() => expect((pathInput as HTMLInputElement).value).not.toBe(""), { timeout: 30_000 });
    // Pasted, not typed: user-event's keyboard syntax treats the backslashes of a Windows path as escapes.
    await user.clear(pathInput);
    await user.click(pathInput);
    await user.paste(server.repo);
    await user.keyboard("{Enter}");
    await user.click(within(wizard).getByRole("button", { name: "Next" }));
    await user.click(within(wizard).getByRole("button", { name: "Add Workspace" }));
    // 2. The shell opens on the Workspace; a new Conversation.
    await screen.findByTestId("topbar", {}, { timeout: 30_000 });
    const workspaceId = useScopeStore.getState().selectedWorkspaceId;
    expect(workspaceId).not.toBeNull();
    await user.click(await screen.findByTestId("new-conversation"));
    await screen.findByTestId("conversation-pane", {}, { timeout: 30_000 });
    // 3. The scripted provider: plan one implementer node, implement in a worktree, request completion, synthesize.
    await server.script("coding", workspaceId!);
    // 4. Start the Run from the goal and the completion check (the fixture's check is a real subprocess).
    await user.type(screen.getByTestId("goal"), "Add a --version flag to the CLI.");
    const check = screen.getByLabelText("completion check");
    await user.clear(check);
    await user.type(check, "node test.js");
    await user.click(screen.getByTestId("start-run-button"));
    // 5. The Run view: the event subscription refreshes the projections until signoff is awaited; nothing polls.
    await screen.findByTestId("run-header", {}, { timeout: 30_000 });
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Awaiting signoff"), { timeout: 120_000 });
    expect(screen.getByTestId("next-step")).toHaveTextContent(/verified/);
    // The Target is untouched before publication.
    expect(cli()).toBe(OLD_CLI);
    // 6. Verification tab: the completion Gate passed and the final report is shown.
    await user.click(screen.getByTestId("tab-verification"));
    await screen.findByTestId("final-report", {}, { timeout: 30_000 });
    expect(screen.getByTestId("gates")).toHaveTextContent(/run completion/);
    // 7. Signoff: accept.
    await user.click(screen.getByTestId("tab-publish"));
    await user.click(await screen.findByTestId("signoff-accept", {}, { timeout: 30_000 }));
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Completed, not published"), { timeout: 30_000 });
    expect(cli()).toBe(OLD_CLI);
    // 8. Publication: a separate request and confirmation; then the Target moves once.
    await user.click(await screen.findByTestId("publish-request", {}, { timeout: 30_000 }));
    await user.click(await screen.findByTestId("publish-confirm", {}, { timeout: 30_000 }));
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Published"), { timeout: 60_000 });
    expect(cli()).toBe(NEW_CLI);
    await waitFor(() => expect(screen.getByTestId("publication")).toHaveTextContent(/brought forward/), { timeout: 30_000 });
    expect(await server.remaining()).toBe(0);
  }, 300_000);

  it("shows the operator controls and the truthful states: pause and resume, cancel, and a plain-directory Workspace that cannot publish", async () => {
    const plain = path.join(server.dir, "plain");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "notes.md"), "# notes\n");
    const created = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { rootPath: plain });
    expect(created.status).toBe(201);
    useScopeStore.getState().select(created.body.workspace.id);
    const conversation = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId: created.body.workspace.id, title: "plain" });
    expect(conversation.status).toBe(201);
    // A turn that hangs until interrupted: the pause and the cancel have something to act on.
    await server.script("hang", created.body.workspace.id);
    mount(`/conversations/${conversation.body.conversation.id}`);
    await screen.findByTestId("conversation-pane", {}, { timeout: 30_000 });
    await user.type(await screen.findByTestId("goal"), "Reorganize the notes.");
    await user.click(screen.getByTestId("start-run-button"));
    await screen.findByTestId("run-header", {}, { timeout: 30_000 });
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Running"), { timeout: 30_000 });
    // Pause (hard): the Run waits on the operator; the interrupted Attempt retries after resume.
    await user.click(screen.getByTestId("pause-hard"));
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Paused"), { timeout: 30_000 });
    expect(screen.getByTestId("next-step")).toHaveTextContent(/Paused/);
    await user.click(screen.getByTestId("resume"));
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Running"), { timeout: 30_000 });
    // The publication tab states the capability truthfully before anything is attempted.
    await user.click(screen.getByTestId("tab-publish"));
    await screen.findByTestId("publication-unsupported", {}, { timeout: 30_000 });
    // Cancel with confirmation.
    await user.click(screen.getByTestId("cancel"));
    await user.click(screen.getByTestId("cancel-confirm"));
    await waitFor(() => expect(screen.getByTestId("run-header")).toHaveTextContent("Cancelled"), { timeout: 30_000 });
    await user.click(screen.getByTestId("tab-overview"));
    expect(screen.getByTestId("next-step")).toHaveTextContent(/cancelled/);
  }, 300_000);
});
