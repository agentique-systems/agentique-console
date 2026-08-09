import fs from "node:fs";
import path from "node:path";
import type {
  HandoffDraft,
  HandoffPage,
  HandoffRecord,
  HandoffSummary,
  HandoffTrigger,
  HandoffExtensionKind,
} from "@agentique-console/shared";
import {
  HANDOFF_CHECKPOINT_SOFT_TARGET_BYTES,
  HANDOFF_READ_DEFAULT_BYTES,
  HANDOFF_READ_MAX_BYTES,
  HANDOFF_REPORT_SOFT_TARGET_BYTES,
  HANDOFF_SOFT_TARGET_BYTES,
  REPORT_TRIGGERS,
  handoffExtensionKindForProfile,
} from "@agentique-console/shared";
import { badRequest, notFound } from "../api/errors.ts";
import { decodeCursor, encodeCursor, sliceUtf8Window } from "../paging.ts";
import type { HandoffRecordRow, Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { HandoffDraftSchema } from "./schema.ts";

export interface PrepareHandoffInput {
  draft: HandoffDraft;
  userSessionId: string;
  agentSessionId: string | null;
  sender: string;
  recipient: string;
  profileId: string | null;
  generation: number;
  turnId?: string | null;
  trigger: HandoffTrigger;
  parentHandoffId?: string | null;
  checkpoint?: boolean;
  extensionKind?: HandoffExtensionKind;
  /**
   * Console-owned extension fields, merged UNDER the model's own data. For
   * facts the console knows and the model should not have to restate — today,
   * the operator decisions carried on a coordination handoff.
   */
  extensionDefaults?: Record<string, unknown>;
  /** Root for file-ref validation; a worktree'd seat's refs resolve there. */
  resolveRoot?: string;
}

export class HandoffService {
  constructor(private readonly deps: { repo: Repo; bus: EventBus; getWorkspaceRoot: (workspaceId: string) => string }) {}

  prepare(input: PrepareHandoffInput): { row: HandoffRecordRow; record: HandoffRecord; summary: HandoffSummary; text: string } {
    const parsed = HandoffDraftSchema.parse(input.draft);
    const extensionKind = input.extensionKind ?? handoffExtensionKindForProfile(input.profileId);
    // Console-authored defaults sit UNDER the model's own data, so a seat that
    // filled a field keeps its value and never has it silently overwritten.
    // This is how `CoordinationHandoffData.operatorDecisions` finally gets
    // written — it has been declared in the shared types and populated by
    // nothing at all.
    const extension = {
      kind: extensionKind,
      data: { ...(input.extensionDefaults ?? {}), ...(parsed.extension?.data ?? {}) },
    };
    const referenceWarnings = this.referenceWarnings(input.userSessionId, [...parsed.core.state.evidence, ...parsed.core.result.artifacts], input.resolveRoot);
    const core = referenceWarnings.length > 0 && parsed.core.risk === "low" ? { ...parsed.core, risk: "medium" as const } : parsed.core;
    const id = newId("handoff");
    const parent = input.parentHandoffId ? this.deps.repo.getHandoff(input.parentHandoffId) : undefined;
    if (input.parentHandoffId && !parent) referenceWarnings.push(`parent handoff does not exist: ${input.parentHandoffId}`);
    const adjustedCore = referenceWarnings.length > 0 && core.risk === "low" ? { ...core, risk: "medium" as const } : core;
    const rootHandoffId = parent?.rootHandoffId ?? id;
    const bytes = Buffer.byteLength(JSON.stringify({ core: adjustedCore, extension }), "utf8");
    const softTargetBytes = input.checkpoint
      ? HANDOFF_CHECKPOINT_SOFT_TARGET_BYTES
      : REPORT_TRIGGERS.includes(input.trigger) ? HANDOFF_REPORT_SOFT_TARGET_BYTES : HANDOFF_SOFT_TARGET_BYTES;
    const createdAt = nowIso();
    const row: HandoffRecordRow = {
      id, userSessionId: input.userSessionId, agentSessionId: input.agentSessionId, messageId: null,
      sender: input.sender, recipient: input.recipient, profileId: input.profileId, generation: input.generation,
      turnId: input.turnId ?? null, trigger: input.trigger, parentHandoffId: parent?.id ?? null, rootHandoffId,
      checkpoint: input.checkpoint ?? false, core: adjustedCore, extension, bytes, softTargetBytes,
      overflow: bytes > softTargetBytes, referenceWarnings, createdAt,
    };
    const record = this.toWire(row);
    const summary = this.summary(record);
    return { row, record, summary, text: this.render(record) };
  }

  committed(record: HandoffRecord): void {
    this.deps.bus.append({ type: "handoff.created", userSessionId: record.metadata.userSessionId,
      ...(record.metadata.agentSessionId ? { agentSessionId: record.metadata.agentSessionId } : {}),
      payload: { handoff: this.summary(record), sender: record.metadata.sender, recipient: record.metadata.recipient,
        checkpoint: record.metadata.checkpoint, bytes: record.metadata.bytes, softTargetBytes: record.metadata.softTargetBytes } });
  }

  get(id: string): HandoffRecord {
    const row = this.deps.repo.getHandoff(id);
    if (!row) throw notFound(`no handoff ${id}`);
    return this.toWire(row);
  }

  read(id: string, section: "core" | "extension" = "core", cursor?: string, maxBytes = HANDOFF_READ_DEFAULT_BYTES): HandoffPage {
    const handoff = this.get(id);
    const bounded = Math.max(4, Math.min(HANDOFF_READ_MAX_BYTES, Math.floor(maxBytes)));
    const offset = cursor ? decodeCursor(cursor, "handoff cursor") : 0;
    const serialized = JSON.stringify(section === "core" ? handoff.core : handoff.extension, null, 2);
    const buffer = Buffer.from(serialized, "utf8");
    if (offset > buffer.length) throw badRequest("handoff cursor is past the end of the section");
    const { content, end } = sliceUtf8Window(buffer, offset, bounded);
    const nextCursor = end < buffer.length ? encodeCursor(end) : null;
    this.deps.bus.append({ type: "handoff.retrieved", userSessionId: handoff.metadata.userSessionId,
      ...(handoff.metadata.agentSessionId ? { agentSessionId: handoff.metadata.agentSessionId } : {}),
      payload: { handoffId: id, section, bytes: Buffer.byteLength(content), nextCursor } });
    return { handoff, section, content, nextCursor };
  }

  reportDiscrepancy(id: string, reporter: string, claim: string, evidence: string): void {
    const handoff = this.get(id);
    this.deps.bus.append({ type: "handoff.discrepancy", userSessionId: handoff.metadata.userSessionId,
      ...(handoff.metadata.agentSessionId ? { agentSessionId: handoff.metadata.agentSessionId } : {}),
      payload: { handoffId: id, reporter, claim, evidence } });
  }

  toWire(row: HandoffRecordRow): HandoffRecord {
    return { metadata: { id: row.id, userSessionId: row.userSessionId, agentSessionId: row.agentSessionId,
      sender: row.sender, recipient: row.recipient, profileId: row.profileId, generation: row.generation,
      turnId: row.turnId, trigger: row.trigger, parentHandoffId: row.parentHandoffId, rootHandoffId: row.rootHandoffId,
      checkpoint: row.checkpoint, bytes: row.bytes, softTargetBytes: row.softTargetBytes, overflow: row.overflow,
      referenceWarnings: row.referenceWarnings, createdAt: row.createdAt }, core: row.core, extension: row.extension };
  }

  summary(record: HandoffRecord): HandoffSummary {
    return { id: record.metadata.id, trigger: record.metadata.trigger, status: record.core.status, risk: record.core.risk,
      action: record.core.action, stateSummary: record.core.state.summary, resultSummary: record.core.result.summary,
      nextAction: record.core.nextAction, evidenceCount: record.core.state.evidence.length,
      artifactCount: record.core.result.artifacts.length, extensionKind: record.extension.kind,
      overflow: record.metadata.overflow, referenceWarnings: record.metadata.referenceWarnings };
  }

  render(record: HandoffRecord): string {
    const s = this.summary(record);
    const lines = [`[Handoff ${s.id}] ${s.action}`, `Status: ${s.status} · Risk: ${s.risk}`, s.stateSummary];
    if (s.resultSummary) lines.push(`Result: ${s.resultSummary}`);
    if (s.nextAction) lines.push(`Next: ${s.nextAction}`);
    lines.push(`Evidence: ${s.evidenceCount} · Artifacts: ${s.artifactCount}${s.overflow ? " · full record available with read_handoff" : ""}`);
    if (s.referenceWarnings.length) lines.push(`Reference warnings: ${s.referenceWarnings.join("; ")}`);
    return lines.join("\n");
  }

  referenceWarnings(userSessionId: string, refs: HandoffDraft["core"]["state"]["evidence"], resolveRoot?: string): string[] {
    const session = this.deps.repo.getUserSession(userSessionId);
    if (!session) return ["owning user session is missing"];
    const root = path.resolve(resolveRoot ?? this.deps.getWorkspaceRoot(session.workspaceId));
    return refs.flatMap((item) => {
      if (item.kind === "file") {
        const target = path.resolve(root, item.ref.split(":")[0] ?? item.ref);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) return [`file reference escapes workspace: ${item.ref}`];
        return fs.existsSync(target) ? [] : [`file reference does not exist: ${item.ref}`];
      }
      if (item.kind === "url") {
        try { new URL(item.ref); return []; } catch { return [`URL reference is invalid: ${item.ref}`]; }
      }
      if (item.kind === "journal" || item.kind === "artifact" || item.kind === "task") {
        return this.deps.repo.hasDurableReference(item.kind, item.ref) ? [] : [`${item.kind} reference does not exist: ${item.ref}`];
      }
      return [];
    });
  }

}
