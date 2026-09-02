import { useState } from "react";
import type { AgentDefinitionSummary, WorkspaceResponse } from "@agentique-console/core";
import { useLoadWorkspaceAgents } from "@/api/mutations";
import { useWorkspaceAgents } from "@/api/queries";
import { Facts, Notice, Panel, Section, errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { allocation, timeAgo } from "@/lib/format";

export function AgentsView({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <AgentsPanel workspaceId={workspace.workspace.id} />
    </div>
  );
}

export function AgentsPanel({ workspaceId }: { workspaceId: string }) {
  const agents = useWorkspaceAgents(workspaceId);
  const load = useLoadWorkspaceAgents(workspaceId);
  return (
    <div className="flex flex-col gap-6" data-testid="agents-panel">
      <Section
        title="Workspace Agent Definitions (.claude/agents/*.md, pinned to a Snapshot)"
        actions={
          <Button size="sm" variant="outline" onClick={() => load.mutate()} disabled={load.isPending} data-testid="load-agents">
            {load.isPending ? "Reading…" : "Read from the Workspace"}
          </Button>
        }
      >
        {load.isError && <Notice tone="error">{errorMessage(load.error)}</Notice>}
        {load.data !== undefined && (
          <Notice testId="load-report">
            Read at Snapshot {load.data.snapshotId.slice(0, 16)}: {load.data.files.filter((f) => f.kind === "loaded").length} loaded, {load.data.files.filter((f) => f.kind === "rejected").length} rejected
            {load.data.files
              .filter((f): f is Extract<typeof f, { kind: "rejected" }> => f.kind === "rejected")
              .map((f) => (
                <span key={f.path} className="block text-status-failed">
                  {f.path}: {f.reasons.map((r) => `${r.field}: ${r.reason}`).join("; ")}
                </span>
              ))}
          </Notice>
        )}
        <Panel query={agents} empty={(a) => a.workspaceFiles.length === 0}>
          {(a) => (
            <ul className="flex flex-col gap-2">
              {a.workspaceFiles.map((summary) => (
                <DefinitionCard key={summary.definition.id} summary={summary} />
              ))}
            </ul>
          )}
        </Panel>
      </Section>
      <Section title="Built-in Agent Definitions">
        <Panel query={agents}>
          {(a) => (
            <ul className="flex flex-col gap-2">
              {a.builtins.map((summary) => (
                <DefinitionCard key={summary.definition.id} summary={summary} />
              ))}
            </ul>
          )}
        </Panel>
      </Section>
    </div>
  );
}

function DefinitionCard({ summary }: { summary: AgentDefinitionSummary }) {
  const [open, setOpen] = useState(false);
  const r = summary.latestRevision;
  return (
    <li className="rounded-md border border-border p-3 text-xs" data-definition={summary.definition.name}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{summary.definition.name}</span>
        <span className="font-mono text-3xs text-muted-foreground">{r.contentHash.slice(0, 12)}</span>
        <span className="text-3xs text-muted-foreground">
          {summary.revisionCount} revision{summary.revisionCount === 1 ? "" : "s"} · {r.provenance.kind === "workspace_file" ? r.provenance.path : r.provenance.kind} · {timeAgo(r.createdAt)}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Details"}
        </Button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <Facts
            items={[
              ["Model", `${r.modelPolicy.model} (${r.modelPolicy.effort}, ${Math.round(r.modelPolicy.maxContextOccupancy * 100)}% context)`],
              ["Capabilities", r.capabilities.tools.join(", ") || "none"],
              ["MCP servers", r.capabilities.mcpServers.join(", ") || "none"],
              ["Default allocation", allocation(r.defaultLimits.allocation)],
              ["Wall clock", r.defaultLimits.maxWallClockMs === null ? "unbounded" : `${r.defaultLimits.maxWallClockMs / 1000}s`],
              ["Pinned", r.provenance.kind === "workspace_file" ? `Snapshot ${r.provenance.snapshotId}` : "built-in"],
            ]}
          />
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 font-mono text-3xs text-muted-foreground">{r.instructions}</pre>
        </div>
      )}
    </li>
  );
}
