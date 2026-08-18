/** JSON-file persistence for the reading tracker. */
import fs from "node:fs";
import { fooBar } from "./util.js";

/** Where entries live; override with READING_TRACKER_FILE. */
export const DATA_FILE = process.env.READING_TRACKER_FILE ?? ".reading-tracker.json";

export function loadEntries(file = DATA_FILE) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

export function saveEntries(entries, file = DATA_FILE) {
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

export function addEntry(entries, title) {
  const id = entries.length === 0 ? 1 : Math.max(...entries.map((entry) => entry.id)) + 1;
  return [...entries, { id, title: fooBar(title), addedAt: new Date().toISOString(), finishedAt: null }];
}

export function finishEntry(entries, id) {
  return entries.map((entry) => (entry.id === id ? { ...entry, finishedAt: new Date().toISOString() } : entry));
}
