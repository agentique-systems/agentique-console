/**
 * Cross-seat dependency drift, read from merged diffs.
 *
 * Disjoint file ownership stops seats colliding on files, not on shared facts.
 * In db-live-1 `page` pinned three@0.169.0 in an import map while `renderer`
 * imported 0.160.0 by URL — the version the operator had specified. Three
 * agents examined that graph and all three concluded it was fine, because no
 * one of them could see both files. The evidence was in the diffs.
 */
import { describe, expect, it } from "vitest";
import { dependencyPinsInPatch } from "./host.ts";

describe("dependencyPinsInPatch", () => {
  it("finds the db-live-1 drift across an import map and a direct CDN import", () => {
    const pagePatch = [
      "--- /dev/null", "+++ b/index.html",
      '+    "three": "https://unpkg.com/three@0.169.0/build/three.module.js",',
      '+    "three/addons/": "https://unpkg.com/three@0.169.0/examples/jsm/"',
    ].join("\n");
    const rendererPatch = [
      "--- /dev/null", "+++ b/src/game.js",
      "+import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';",
    ].join("\n");

    expect(dependencyPinsInPatch(pagePatch)).toEqual([
      { name: "three", version: "0.169.0" }, { name: "three", version: "0.169.0" },
    ]);
    expect(dependencyPinsInPatch(rendererPatch)).toEqual([{ name: "three", version: "0.160.0" }]);
  });

  it("ignores removed lines and diff headers", () => {
    // `+++ b/foo@1.0.0.txt` is a header, not an added dependency.
    const patch = ["+++ b/vendor@1.0.0/index.js", "-import x from 'pkg@2.0.0';", " context pkg@3.0.0"].join("\n");
    expect(dependencyPinsInPatch(patch)).toEqual([]);
  });

  it("does not fire on a version that is not a pin", () => {
    expect(dependencyPinsInPatch("+const version = '1.2.3';")).toEqual([]);
    expect(dependencyPinsInPatch("+// see release 2.0.0 notes")).toEqual([]);
  });
});
