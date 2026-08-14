#!/usr/bin/env node
/** reading-tracker: add | list | finish <id> | --version */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fooBar, formatEntry } from "./util.js";
import { addEntry, finishEntry, loadEntries, saveEntries } from "./store.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "--version") {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  process.stdout.write(`${JSON.parse(fs.readFileSync(pkg, "utf8")).version}\n`);
  process.exit(0);
}

const entries = loadEntries();

if (command === "add") {
  const title = fooBar(rest.join(" "));
  if (title === "") {
    process.stderr.write("usage: reading-tracker add <title>\n");
    process.exit(1);
  }
  saveEntries(addEntry(entries, title));
  process.stdout.write(`added: ${title}\n`);
} else if (command === "list") {
  for (const entry of entries) process.stdout.write(`${formatEntry(entry)}\n`);
} else if (command === "finish") {
  const id = Number(rest[0]);
  if (!entries.some((entry) => entry.id === id)) {
    process.stderr.write(`no entry ${rest[0]}\n`);
    process.exit(1);
  }
  saveEntries(finishEntry(entries, id));
  process.stdout.write(`finished: ${id}\n`);
} else {
  process.stderr.write("usage: reading-tracker add|list|finish|--version\n");
  process.exit(1);
}
