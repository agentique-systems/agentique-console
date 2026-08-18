/** Legacy build: concatenates src/pages into dist/site.html. CommonJS on purpose. */
const fs = require("node:fs");
const path = require("node:path");

const pagesDir = path.join(__dirname, "..", "src", "pages");
const outDir = path.join(__dirname, "..", "dist");
const pages = fs.readdirSync(pagesDir).filter((name) => name.endsWith(".html")).sort();
const body = pages.map((name) => fs.readFileSync(path.join(pagesDir, name), "utf8")).join("\n");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "site.html"), `<!doctype html>\n<main>\n${body}</main>\n`);
process.stdout.write(`built dist/site.html from ${pages.length} page(s)\n`);
