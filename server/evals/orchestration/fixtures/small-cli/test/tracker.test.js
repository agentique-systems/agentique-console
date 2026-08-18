import assert from "node:assert/strict";
import { test } from "node:test";
import { fooBar, formatEntry } from "../src/util.js";
import { addEntry, finishEntry } from "../src/store.js";

test("fooBar collapses whitespace", () => {
  assert.equal(fooBar("  The   Left  Hand of Darkness "), "The Left Hand of Darkness");
});

test("addEntry assigns increasing ids and normalizes the title", () => {
  const one = addEntry([], "  Book   One ");
  const two = addEntry(one, "Book Two");
  assert.equal(one[0].id, 1);
  assert.equal(one[0].title, "Book One");
  assert.equal(two[1].id, 2);
  assert.equal(two[1].finishedAt, null);
});

test("finishEntry stamps exactly the finished entry", () => {
  const entries = addEntry(addEntry([], "A"), "B");
  const done = finishEntry(entries, 1);
  assert.notEqual(done[0].finishedAt, null);
  assert.equal(done[1].finishedAt, null);
  assert.match(formatEntry(done[0]), /^done /);
  assert.match(formatEntry(done[1]), /^open /);
});
