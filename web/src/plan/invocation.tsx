import { useState } from "react";
import type { Attempt } from "@agentique-console/core";
import { useAttempt, useInvocation, useTranscript } from "@/api/queries";
import { ArtifactLink } from "@/artifacts/viewer";
import { Facts, Panel, Section } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { allocation, timeAgo, usage } from "@/lib/format";
import { useOutputStore } from "@/stores/output";

export function InvocationView({ invocationId, runId }: { invocationId: string; runId: string }) {
  const invocation = useInvocation(invocationId);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  void runId;
  return (
    <Panel query={invocation}>
      {(v) => (
        <div className="flex flex-col gap-4" data-testid="invocation-view">
          <div className="grid gap-4 md:grid-cols-2">
            <Section title={`Invocation ${v.invocation.role} · ${v.invocation.purpose}`}>
              <Facts
                items={[
                  ["Status", <StatusBadge key="s" status={v.invocation.status} />],
                  ["Definition", `${v.definition.provenance.kind === "workspace_file" ? v.definition.provenance.path : "built-in"} @ ${v.definition.contentHash.slice(0, 12)}`],
                  ["Model", `${v.definition.modelPolicy.model} (${v.definition.modelPolicy.effort})`],
                  ["Allocation", allocation(v.invocation.allocation)],
                  ["Usage", usage(v.usage)],
                  ["Blocked by", v.invocation.blockedByDecisionId ?? "—"],
                  ["Failure", v.invocation.failureReason ?? "—"],
                  ["Tasks", v.invocation.taskIds.join(", ") || "—"],
                  ["Inputs", v.manifest.content.inputs.map((i) => i.kind).join(", ") || "—"],
                  ["Runtime tools", v.manifest.content.runtimeTools.join(", ")],
                  ["Capabilities", v.manifest.content.capabilities.tools.join(", ") || "none"],
                ]}
              />
              {v.invocation.result !== null && (
                <div className="rounded-md border border-border p-2 text-xs">
                  <div className="text-3xs text-muted-foreground">Result ({v.invocation.result.status})</div>
                  <p>{v.invocation.result.summary}</p>
                  {v.invocation.result.blocker !== null && <p className="text-status-failed">Blocker: {v.invocation.result.blocker}</p>}
                </div>
              )}
            </Section>
            <Section title="Attempts">
              <ul className="flex flex-col gap-1 text-xs">
                {v.attempts.map((a: Attempt) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => setAttemptId(a.id === attemptId ? null : a.id)} className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-left hover:bg-muted/40" aria-pressed={attemptId === a.id}>
                      <span className="font-mono text-3xs">#{a.number}</span>
                      <StatusBadge status={a.status} />
                      <span className="text-muted-foreground">
                        {a.kind} · {a.startMode}
                      </span>
                      {a.failureClass !== null && <span className="text-3xs text-status-failed">{a.failureClass}</span>}
                      <span className="flex-1" />
                      <span className="text-3xs text-muted-foreground">{timeAgo(a.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {v.runtimeToolCalls.length > 0 && (
                <div className="text-2xs text-muted-foreground">
                  Runtime tool calls: {v.runtimeToolCalls.map((c) => c.tool).join(", ")}
                </div>
              )}
              {v.artifacts.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-2xs">
                  {v.artifacts.map((a) => (
                    <li key={a.id}>
                      <ArtifactLink artifact={a} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
          {attemptId !== null && <AttemptView attemptId={attemptId} />}
        </div>
      )}
    </Panel>
  );
}

function AttemptView({ attemptId }: { attemptId: string }) {
  const attempt = useAttempt(attemptId);
  const [showTranscript, setShowTranscript] = useState(false);
  const transcript = useTranscript(showTranscript ? attemptId : null);
  const live = useOutputStore((s) => s.byAttempt[attemptId] ?? null);
  return (
    <Panel query={attempt}>
      {(a) => (
        <Section title={`Attempt #${a.attempt.number}`}>
          <Facts
            items={[
              ["Status", <StatusBadge key="s" status={a.attempt.status} />],
              ["Failure", a.attempt.failureDetail === null ? "—" : `${a.attempt.failureClass ?? ""}: ${a.attempt.failureDetail.message}`],
              ["Retry", a.attempt.retryDecision === null ? "—" : `${a.attempt.retryDecision.permitted ? "permitted" : "refused"} (${a.attempt.retryDecision.reason})`],
              ["Usage rows", a.usage.length],
              ["Cost", `$${a.usage.reduce((sum, u) => sum + u.costUsd, 0).toFixed(3)}`],
              ["Tool calls", a.runtimeToolCalls.map((c) => c.tool).join(", ") || "—"],
            ]}
          />
          {live !== null && live.chunks.length > 0 && <pre className="max-h-40 overflow-auto rounded-md border border-border p-2 font-mono text-3xs text-muted-foreground">{live.chunks.map((c) => (c.kind === "tool_call" ? `▶ ${c.text}` : c.text)).join("\n")}</pre>}
          {a.transcript !== null && (
            <div className="flex flex-col gap-1">
              <Button size="sm" variant="outline" className="self-start" onClick={() => setShowTranscript((v) => !v)} data-testid="show-transcript">
                {showTranscript ? "Hide transcript" : "Show transcript (diagnostic)"}
              </Button>
              {showTranscript && (
                <Panel query={transcript}>
                  {(t) => (
                    <pre className="max-h-96 overflow-auto rounded-md border border-border p-2 font-mono text-3xs">
                      {t.text}
                      {t.truncated ? "\n… (truncated)" : ""}
                    </pre>
                  )}
                </Panel>
              )}
            </div>
          )}
        </Section>
      )}
    </Panel>
  );
}
