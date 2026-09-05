import { useState } from "react";
import { BotIcon, ChevronDownIcon, FileTextIcon, RefreshCwIcon } from "lucide-react";
import type { AgentDefinitionSummary, WorkspaceResponse } from "@agentique-console/core";

import { useLoadWorkspaceAgents } from "@/api/mutations";
import { useWorkspaceAgents } from "@/api/queries";
import { Callout } from "@/components/callout";
import { EmptyState } from "@/components/empty-state";
import { KeyValue } from "@/components/key-value";
import { CodeBlock } from "@/components/log-view";
import { PageBody, PageHeader } from "@/components/page";
import { Panel, Section, errorMessage } from "@/components/panel";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { allocation, count, duration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AgentsView({ workspace }: { workspace: WorkspaceResponse }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Agents" description="The Agent Definitions Runs in this Workspace may execute: its own files, pinned to a Snapshot, and the built-ins." />
      <PageBody>
        <AgentsPanel workspaceId={workspace.workspace.id} />
      </PageBody>
    </div>
  );
}

export function AgentsPanel({ workspaceId }: { workspaceId: string }) {
  const agents = useWorkspaceAgents(workspaceId);
  const load = useLoadWorkspaceAgents(workspaceId);
  const skeleton = (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14" />
      <Skeleton className="h-14" />
    </div>
  );
  return (
    <div className="flex flex-col gap-6" data-testid="agents-panel">
      <Section
        title="Workspace Agent Definitions"
        description={
          <>
            Read from <span className="font-mono">.claude/agents/*.md</span> at a pinned Snapshot; a Run executes the revision it was created with.
          </>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => load.mutate()} disabled={load.isPending} data-testid="load-agents">
            <RefreshCwIcon className={cn(load.isPending && "animate-spin")} />
            {load.isPending ? "Reading…" : "Read from the Workspace"}
          </Button>
        }
      >
        {load.isError && <Callout tone="error">{errorMessage(load.error)}</Callout>}
        {load.data !== undefined && (
          <Callout tone={load.data.files.some((f) => f.kind === "rejected") ? "warning" : "success"} testId="load-report" title={`Read at Snapshot ${load.data.snapshotId.slice(0, 16)}: ${load.data.files.filter((f) => f.kind === "loaded").length} loaded, ${load.data.files.filter((f) => f.kind === "rejected").length} rejected`}>
            {load.data.files
              .filter((f): f is Extract<typeof f, { kind: "rejected" }> => f.kind === "rejected")
              .map((f) => (
                <span key={f.path} className="block text-status-failed">
                  <span className="font-mono">{f.path}</span>: {f.reasons.map((r) => `${r.field}: ${r.reason}`).join("; ")}
                </span>
              ))}
          </Callout>
        )}
        <Panel query={agents} skeleton={skeleton} empty={(a) => a.workspaceFiles.length === 0} emptyState={<EmptyState compact icon={BotIcon} title="No Workspace definitions" description="Add Markdown agent files under .claude/agents/ in the Workspace and read them in." />}>
          {(a) => (
            <ul className="flex flex-col gap-2">
              {a.workspaceFiles.map((summary) => (
                <DefinitionCard key={summary.definition.id} summary={summary} />
              ))}
            </ul>
          )}
        </Panel>
      </Section>
      <Section title="Built-in Agent Definitions" description="Shipped with the console: the Orchestrator, the Worker roles, and the reviewer Evaluator.">
        <Panel query={agents} skeleton={skeleton}>
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
    <li className={cn("surface-raised rounded-lg border bg-card", open ? "border-foreground/30" : "border-border")} data-definition={summary.definition.name}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <BotIcon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{summary.definition.name}</span>
            <span className="rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground">
              {r.modelPolicy.model} · {r.modelPolicy.effort}
            </span>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {r.provenance.kind === "workspace_file" ? <span className="font-mono">{r.provenance.path}</span> : r.provenance.kind} · {count(summary.revisionCount, "revision")} · <RelativeTime iso={r.createdAt} /> · <span className="font-mono">{r.contentHash.slice(0, 12)}</span>
          </span>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border-subtle px-4 py-3">
          <KeyValue
            dense
            columns={2}
            items={[
              { label: "Model", value: `${r.modelPolicy.model} (${r.modelPolicy.effort}, ${Math.round(r.modelPolicy.maxContextOccupancy * 100)}% context before a fresh Attempt)` },
              { label: "Capabilities", value: r.capabilities.tools.length === 0 ? "none" : r.capabilities.tools.join(", ") },
              { label: "MCP servers", value: r.capabilities.mcpServers.length === 0 ? "none" : r.capabilities.mcpServers.join(", ") },
              { label: "Default allocation", value: allocation(r.defaultLimits.allocation), mono: true },
              { label: "Wall clock", value: r.defaultLimits.maxWallClockMs === null ? "unbounded" : duration(r.defaultLimits.maxWallClockMs) },
              { label: "Pinned", value: r.provenance.kind === "workspace_file" ? `Snapshot ${r.provenance.snapshotId}` : "built-in", mono: r.provenance.kind === "workspace_file" },
            ]}
          />
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              <FileTextIcon className="size-3" />
              Instructions
            </span>
            <CodeBlock text={r.instructions} maxHeight="20rem" />
          </div>
        </div>
      )}
    </li>
  );
}
