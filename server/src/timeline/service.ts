import type { ConsoleEvent, TimelineItem, TimelineLane, TimelinePageResponse } from "@agentique-console/shared";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { NotFoundError } from "../errors.ts";

type Payload = Record<string, unknown>;

function payload(event: ConsoleEvent): Payload { return event.payload as unknown as Payload; }
function str(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }

export class TimelineService {
  constructor(private readonly repo: Repo, private readonly bus: EventBus) {}

  page(userSessionId: string, beforeSeq?: number, limit = 1_000): TimelinePageResponse {
    const session = this.repo.getUserSession(userSessionId);
    if (!session) throw new NotFoundError(`no user session ${userSessionId}`);
    const { events, nextBeforeSeq } = this.bus.pageForUserSession(userSessionId, beforeSeq, Math.min(Math.max(limit, 50), 2_000));
    const lanes: TimelineLane[] = [
      { id: "operator", kind: "operator", label: "Human Operator", parentId: null, order: 0 },
      { id: "orchestrator", kind: "orchestrator", label: "Orchestrator Agent", parentId: null, order: 1 },
    ];
    let order = 2;
    // Children lane directly under their parent, with REAL depth: a child
    // session's lane parents on the parent session's, not on the root.
    const all = this.repo.listAgentSessions(userSessionId);
    const ordered = all.filter((row) => row.parentAgentSessionId === null)
      .flatMap((root) => [root, ...all.filter((row) => row.parentAgentSessionId === root.id)]);
    for (const agentSession of ordered) {
      const parent = `agent-session:${agentSession.id}`;
      lanes.push({ id: parent, kind: "agent_session", label: agentSession.title,
        parentId: agentSession.parentAgentSessionId === null ? null : `agent-session:${agentSession.parentAgentSessionId}`, order: order++ });
      for (const participant of this.repo.listParticipants(agentSession.id)) {
        lanes.push({ id: `agent:${agentSession.id}:${participant.name}`, kind: "agent", label: participant.name, parentId: parent, order: order++ });
      }
    }

    const starts = new Map<string, TimelineItem>();
    const items: TimelineItem[] = [];
    const finish = (key: string, event: ConsoleEvent, status: string | null) => {
      const item = starts.get(key); if (!item) return;
      item.end = event.ts; item.status = status; if (event.seq !== undefined) item.eventSeqs.push(event.seq); item.detail.end = payload(event);
      starts.delete(key);
    };
    for (const event of events) {
      const p = payload(event); const seqs = event.seq === undefined ? [] : [event.seq];
      if (event.type === "user_session.turn.started") {
        const item: TimelineItem = { id: `turn:${str(p.turnId)}`, laneId: "orchestrator", kind: "turn", label: `turn · ${str(p.trigger)}`, start: event.ts, end: null, status: "running", eventSeqs: seqs, detail: p };
        starts.set(item.id, item); items.push(item); continue;
      }
      if (event.type === "user_session.turn.settled") { finish(`turn:${str(p.turnId)}`, event, str(p.status)); continue; }
      if (event.type === "agent_session.turn.started") {
        const lane = `agent:${str(p.agentSessionId)}:${str(p.participant)}`;
        const item: TimelineItem = { id: `agent-turn:${str(p.turnId)}`, laneId: lane, kind: "turn", label: "agent turn", start: event.ts, end: null, status: "running", eventSeqs: seqs, detail: p };
        starts.set(item.id, item); items.push(item); continue;
      }
      if (event.type === "agent_session.turn.settled") { finish(`agent-turn:${str(p.turnId)}`, event, str(p.status)); continue; }
      if (event.type === "user_session.tool.call" || event.type === "agent_session.tool.call") {
        const lane = event.type.startsWith("agent_") ? `agent:${event.agentSessionId ?? ""}:${str(p.participant)}` : "orchestrator";
        const item: TimelineItem = { id: `tool:${str(p.callId)}`, laneId: lane, kind: "tool", label: str(p.name, "tool"), start: event.ts, end: null, status: "running", eventSeqs: seqs, detail: p };
        starts.set(item.id, item); items.push(item); continue;
      }
      if (event.type === "user_session.tool.result" || event.type === "agent_session.tool.result") { finish(`tool:${str(p.callId)}`, event, p.isError ? "error" : "completed"); continue; }
      if (event.type === "agent_session.process.started") {
        const item: TimelineItem = { id: `process:${str(p.processId)}`, laneId: `agent:${str(p.agentSessionId)}:${str(p.participant)}`, kind: "process", label: str(p.command, "process"), start: event.ts, end: null, status: "running", eventSeqs: seqs, detail: p };
        starts.set(item.id, item); items.push(item); continue;
      }
      if (event.type === "agent_session.process.exited") { finish(`process:${str(p.processId)}`, event, p.code === 0 ? "completed" : "error"); continue; }
      const message = p.message as Record<string, unknown> | undefined;
      if (event.type === "user_session.message" && message) {
        const speaker = message.speaker as Record<string, unknown> | undefined;
        const lane = speaker?.kind === "operator" ? "operator" : "orchestrator";
        items.push({ id: `event:${event.seq}`, laneId: lane, kind: "message", label: str(message.text, "message").slice(0, 80), start: event.ts, end: null, status: null, eventSeqs: seqs, detail: p }); continue;
      }
      if (event.type === "agent_session.message" && message) {
        const speaker = message.speaker as Record<string, unknown> | undefined;
        items.push({ id: `event:${event.seq}`, laneId: `agent:${event.agentSessionId ?? ""}:${str(speaker?.name)}`, kind: "message", label: str(message.text, "message").slice(0, 80), start: event.ts, end: null, status: null, eventSeqs: seqs, detail: p }); continue;
      }
      const mapped = event.type.startsWith("task") ? "task" : event.type.startsWith("handoff") || event.type.startsWith("flow") ? "handoff" : event.type.includes("question") || event.type.includes("plan") ? "decision" : event.type.includes("context.rotated") ? "rotation" : event.type === "usage.recorded" ? "usage" : event.type.includes("runtime") ? "runtime" : null;
      if (mapped) {
        const lane = event.agentSessionId ? `agent:${event.agentSessionId}:${str(p.participant, "orchestrator")}` : "orchestrator";
        items.push({ id: `event:${event.seq}`, laneId: lane, kind: mapped, label: event.type.replaceAll("_", " "), start: event.ts, end: null, status: null, eventSeqs: seqs, detail: p });
      }
    }
    return { lanes, items, nextBeforeSeq };
  }
}
