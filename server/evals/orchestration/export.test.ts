/**
 * The decision-time evidence export, CI-proven against Tier A traces with
 * zero spend: the run dir must let a judge reconstruct any major act's
 * contemporaneous context — packets with inbound evidence, review findings,
 * decisions, spec/state revisions — and the transcript must show the
 * question cards, decisions, and tool calls the messages table never sees.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportEvidencePackets, exportRunToDir } from "./live/export-trace.ts";
import reviewerInvalidatesSpec from "./scenarios/reviewer-invalidates-spec.ts";
import vagueGreenfield from "./scenarios/vague-greenfield.ts";
import { runScenarioVariant } from "./structural-runner.ts";

async function exportVariant(scenario: Parameters<typeof runScenarioVariant>[0], variant: string) {
  const run = await runScenarioVariant(scenario, variant);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-export-"));
  const dbFile = path.join(dir, "console.db");
  fs.writeFileSync(dbFile, run.harness.sqlite.serialize());
  const out = path.join(dir, "export");
  exportRunToDir(dbFile, out);
  return { dbFile, out };
}

describe("decision-time evidence export", () => {
  it("packets reconstruct what was knowable at each major act", { timeout: 30_000 }, async () => {
    const { dbFile, out } = await exportVariant(reviewerInvalidatesSpec, "exemplary");
    for (const file of ["events.jsonl", "state-revisions.json", "spec-revisions.json", "requirement-revisions.json", "decisions.json", "questions.json", "tool-calls.json", "evidence/packets.json"]) {
      expect(fs.existsSync(path.join(out, file)), `${file} missing`).toBe(true);
    }
    const packets = exportEvidencePackets(dbFile);
    const created = packets.find((packet) => packet.actType === "agent_session.created");
    expect(created).toBeDefined();
    // The amendment act: by rev 2 the objection is inbound evidence, the
    // reviewer's output is a finding, and the rev-1 approval is a decision.
    const amendment = packets.filter((packet) => packet.actType === "user_session.requirements.updated").at(-1)!;
    expect(amendment.specRevisionAtAct).toBe(2);
    expect(amendment.decisionsAtAct.some((decision) => decision.question.includes("Requirements approval (rev 1)"))).toBe(true);
    expect(amendment.inboundEvidence.some((row) => row.summary.includes("unachievable as specified"))).toBe(true);
    expect(amendment.reviewFindings.length).toBeGreaterThan(0);
    // The spine really is the full journal, seq-ordered.
    const spine = fs.readFileSync(path.join(out, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
    expect(spine.length).toBeGreaterThan(50);
    expect(spine.every((event, index) => index === 0 || event.seq > spine[index - 1]!.seq)).toBe(true);
    // Requirement revisions export with their full canonical documents.
    const revisions = JSON.parse(fs.readFileSync(path.join(out, "requirement-revisions.json"), "utf8")) as { revision: number; status: string; document: string }[];
    expect(revisions.map((row) => row.status)).toContain("superseded");
    expect(revisions.at(-1)?.document).toContain("- r1:");
    const transcript = fs.readFileSync(path.join(out, "transcript.md"), "utf8");
    expect(transcript).toContain("[tool] main → mcp__console__propose_requirements");
    expect(transcript).toContain("[requirements] revision 2 approved");
    expect(transcript).toContain("[operator decision] Requirements approval (rev 1)");
  });

  it("the transcript shows question cards with their decisions", { timeout: 30_000 }, async () => {
    const { out } = await exportVariant(vagueGreenfield, "exemplary");
    const transcript = fs.readFileSync(path.join(out, "transcript.md"), "utf8");
    expect(transcript).toContain("[question card] Web app or CLI?");
    expect(transcript).toContain("[operator decision]");
    const questions = JSON.parse(fs.readFileSync(path.join(out, "questions.json"), "utf8")) as { questions: { question: string }[]; answeredSeq: number | null }[];
    expect(questions).toHaveLength(1);
    expect(questions[0]!.questions[0]!.question).toBe("Web app or CLI?");
    expect(questions[0]!.answeredSeq).not.toBeNull();
  });
});
