/**
 * The ARTIFACT evidence bundle: what the run actually produced, assembled at
 * export time so the outcome judge consumes the artifact — never the
 * orchestration story. Validator-first: where the scenario declares an
 * objective command, its exit code and output are the mechanical floor and
 * the judge treats them as authoritative; LLM judgment covers only the
 * quality above that floor.
 *
 * Bundle contents under <runDir>/evidence/:
 *   tree.txt         workspace file list + sizes (.git excluded)
 *   workspace.diff   git diff fixture-baseline → HEAD + --stat + untracked list
 *   files/           contents matching scenario.live.evidence.globs (capped)
 *   validator.json   declared validator's exit code + output (run in a COPY)
 *   screenshots/     image artifacts from the journal (needsBrowser scenarios)
 */
import { execFileSync, execSync } from "node:child_process";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrchestrationScenario } from "../scenario.ts";

const DIFF_CAP = 512 * 1024;
const FILE_CAP_DEFAULT = 64 * 1024;
const TOTAL_CAP_DEFAULT = 1024 * 1024;

function walk(dir: string, base = dir): { rel: string; bytes: number }[] {
  const rows: { rel: string; bytes: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...walk(full, base));
    else rows.push({ rel: path.relative(base, full), bytes: fs.statSync(full).size });
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

function matches(rel: string, globs: string[]): boolean {
  return globs.some((glob) => {
    const pattern = new RegExp(`^${glob.split("**").map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
    return pattern.test(rel);
  });
}

export function exportEvidenceBundle(scenario: OrchestrationScenario, runDir: string): void {
  const workspace = path.join(runDir, "workspace");
  if (!fs.existsSync(workspace)) return;
  const evidenceDir = path.join(runDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const files = walk(workspace);
  fs.writeFileSync(path.join(evidenceDir, "tree.txt"),
    `${files.map((row) => `${String(row.bytes).padStart(9)}  ${row.rel}`).join("\n")}\n`);

  // Diff against the fixture-baseline root commit — "what did the run change"
  // is only well-defined against the committed starting point.
  try {
    const git = (...argv: string[]): string => execFileSync("git", ["-C", workspace, ...argv], { encoding: "utf8" });
    const baseline = git("rev-list", "--max-parents=0", "HEAD").trim().split("\n")[0]!;
    const stat = git("diff", "--stat", baseline);
    const diff = git("diff", baseline);
    const untracked = git("status", "--porcelain");
    fs.writeFileSync(path.join(evidenceDir, "workspace.diff"),
      `# git diff --stat ${baseline.slice(0, 12)}..HEAD\n${stat}\n# untracked/dirty (git status --porcelain)\n${untracked}\n# full diff${diff.length > DIFF_CAP ? " (capped)" : ""}\n${diff.slice(0, DIFF_CAP)}\n`);
  } catch (error) {
    fs.writeFileSync(path.join(evidenceDir, "workspace.diff"),
      `# diff unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}\n`);
  }

  const globs = scenario.live?.evidence?.globs ?? [];
  if (globs.length > 0) {
    const filesDir = path.join(evidenceDir, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    const perFileCap = scenario.live?.evidence?.maxFileBytes ?? FILE_CAP_DEFAULT;
    let budget = scenario.live?.evidence?.maxTotalBytes ?? TOTAL_CAP_DEFAULT;
    for (const row of files) {
      if (!matches(row.rel, globs) || budget <= 0) continue;
      const content = fs.readFileSync(path.join(workspace, row.rel));
      const slice = content.subarray(0, Math.min(perFileCap, budget));
      const target = path.join(filesDir, row.rel.replaceAll("/", "__"));
      fs.writeFileSync(target, slice);
      budget -= slice.byteLength;
    }
  }

  const validator = scenario.live?.validator;
  if (validator !== undefined) {
    // A COPY: the validator must not be able to mutate the exported artifact.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "orch-validate-"));
    fs.cpSync(workspace, copy, { recursive: true });
    let exitCode = 0;
    let output = "";
    try {
      output = execSync(validator.command, { cwd: copy, encoding: "utf8", timeout: validator.timeoutMs ?? 120_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      exitCode = failed.status ?? 1;
      output = `${failed.stdout ?? ""}\n${failed.stderr ?? failed.message ?? ""}`;
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(evidenceDir, "validator.json"),
      `${JSON.stringify({ command: validator.command, exitCode, passed: exitCode === 0, output: output.slice(0, 32 * 1024) }, null, 2)}\n`);
  }

  if (scenario.live?.needsBrowser === true) {
    const dbFile = path.join(runDir, "console.db");
    if (fs.existsSync(dbFile)) {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      const images = db.prepare("SELECT id, media_type, content FROM event_artifacts WHERE media_type LIKE 'image/%'").all() as { id: string; media_type: string; content: string }[];
      if (images.length > 0) {
        const shotsDir = path.join(evidenceDir, "screenshots");
        fs.mkdirSync(shotsDir, { recursive: true });
        for (const image of images) {
          const ext = image.media_type.includes("png") ? "png" : image.media_type.includes("jpeg") ? "jpg" : "img";
          const binary = image.media_type.endsWith(";base64");
          fs.writeFileSync(path.join(shotsDir, `${image.id}.${ext}`), binary ? Buffer.from(image.content, "base64") : image.content);
        }
      }
      db.close();
    }
  }
}
