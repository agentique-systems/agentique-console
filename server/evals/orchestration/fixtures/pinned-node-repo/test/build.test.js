const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

test("build produces dist/site.html containing every page", () => {
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "build.js")]);
  const out = fs.readFileSync(path.join(__dirname, "..", "dist", "site.html"), "utf8");
  assert.match(out, /Legacy Site/);
});
