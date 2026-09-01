import { describe, expect, it } from "vitest";
import { supportsStrategy, WORKSPACE_CAPABILITIES } from "./capabilities.ts";

describe("Workspace capability matrix", () => {
  it("names both kinds with their exact publication strategies and atomicity", () => {
    expect(Object.keys(WORKSPACE_CAPABILITIES).sort()).toEqual(["directory", "git"]);
    expect(WORKSPACE_CAPABILITIES.git).toMatchObject({ target: "branch", publicationStrategies: ["fast_forward", "merge"], atomicPublication: true, snapshotIdentity: "commit and tree" });
    expect(WORKSPACE_CAPABILITIES.directory).toMatchObject({ target: "directory", publicationStrategies: ["fast_forward"], atomicPublication: false, snapshotIdentity: "content digest of the tracked files" });
    expect(supportsStrategy("git", { kind: "merge" })).toBe(true);
    expect(supportsStrategy("directory", { kind: "merge" })).toBe(false);
    expect(supportsStrategy("git", { kind: "other", name: "rebase" })).toBe(false);
  });
});
