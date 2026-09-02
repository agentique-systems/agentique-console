import { describe, expect, it } from "vitest";
import { supportsPublication, supportsStrategy, WORKSPACE_CAPABILITIES } from "./capabilities.ts";

describe("Workspace capability matrix", () => {
  it("names both kinds with their exact publication strategies and atomicity", () => {
    expect(Object.keys(WORKSPACE_CAPABILITIES).sort()).toEqual(["directory", "git"]);
    expect(WORKSPACE_CAPABILITIES.git).toMatchObject({ target: "branch", publicationStrategies: ["fast_forward", "merge"], atomicPublication: true, snapshotIdentity: "commit and tree" });
    expect(WORKSPACE_CAPABILITIES.directory).toMatchObject({ target: "directory", publicationStrategies: [], atomicPublication: false, snapshotIdentity: "content digest of the tracked files" });
    // Only a kind with an atomic update-plus-receipt publishes; the directory kind refuses before the Target is touched.
    expect(supportsPublication("git")).toBe(true);
    expect(supportsPublication("directory")).toBe(false);
    expect(supportsStrategy("directory", { kind: "fast_forward" })).toBe(false);
    expect(supportsStrategy("git", { kind: "merge" })).toBe(true);
    expect(supportsStrategy("directory", { kind: "merge" })).toBe(false);
    expect(supportsStrategy("git", { kind: "other", name: "rebase" })).toBe(false);
  });
});
