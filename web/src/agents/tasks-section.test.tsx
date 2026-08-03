/** The ledger's contract: grouping, the done pile toggle, blocked chip, click-through. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@agentique-console/shared";
import { useUiStore } from "@/stores/ui";

import { TasksSection } from "./tasks-section";

let n = 0;
function task(
  over: Partial<Task> & Pick<Task, "subject" | "status">,
): Task {
  n += 1;
  return {
    sdkSessionId: "sdk_1",
    sdkTaskId: `t_${n}`,
    workspaceId: "ws_1",
    userSessionId: "us_1",
    agentSessionId: null,
    participant: null,
    description: "",
    activeForm: null,
    owner: null,
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: "2026-08-03T11:30:00.000Z",
    ...over,
  };
}

describe("TasksSection", () => {
  beforeEach(() => {
    useUiStore.setState({ selectedAgentSessionByUserSession: {} });
  });

  it("groups in_progress before pending, hides deleted, counts the rest", () => {
    render(
      createElement(TasksSection, {
        tasks: [
          task({ subject: "queued thing", status: "pending" }),
          task({
            subject: "hot thing",
            status: "in_progress",
            activeForm: "doing the hot thing",
          }),
          task({ subject: "gone thing", status: "deleted" }),
          task({ subject: "done thing", status: "completed" }),
        ],
      }),
    );

    const rows = screen.getAllByTestId("task-row");
    // in_progress first (activeForm text), then pending (subject); done is
    // collapsed and deleted never renders.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("doing the hot thing");
    expect(rows[1]).toHaveTextContent("queued thing");
    expect(screen.queryByText("gone thing")).not.toBeInTheDocument();
    expect(screen.queryByText("done thing")).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // header count
  });

  it("the done pile expands behind its toggle", async () => {
    const user = userEvent.setup();
    render(
      createElement(TasksSection, {
        tasks: [
          task({ subject: "done one", status: "completed" }),
          task({ subject: "done two", status: "completed" }),
        ],
      }),
    );

    expect(screen.queryByText("done one")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /2 done/ }));
    expect(screen.getByText("done one")).toBeInTheDocument();
    expect(screen.getByText("done two")).toBeInTheDocument();
  });

  it("pending tasks with blockers wear the blocked chip", () => {
    render(
      createElement(TasksSection, {
        tasks: [
          task({
            subject: "stuck thing",
            status: "pending",
            blockedBy: ["t_x", "t_y"],
          }),
        ],
      }),
    );
    expect(screen.getByText("blocked by 2")).toBeInTheDocument();
  });

  it("a task with an agent session clicks through to select it", async () => {
    const user = userEvent.setup();
    render(
      createElement(TasksSection, {
        tasks: [
          task({
            subject: "delegated thing",
            status: "in_progress",
            agentSessionId: "as_9",
            owner: "scout",
          }),
        ],
      }),
    );

    await user.click(screen.getByTestId("task-row"));
    expect(
      useUiStore.getState().selectedAgentSessionByUserSession["us_1"],
    ).toBe("as_9");
  });

  it("a task without an agent session is not a button", () => {
    render(
      createElement(TasksSection, {
        tasks: [task({ subject: "orchestrator's own", status: "pending" })],
      }),
    );
    expect(screen.getByTestId("task-row").tagName).toBe("DIV");
  });
});
