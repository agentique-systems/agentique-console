import { useCapacity, useConfig, useHealth } from "@/api/queries";
import { Facts, Notice, Panel, Section } from "@/components/panel";
import { allocation } from "@/lib/format";

export function SystemView() {
  const health = useHealth();
  const capacity = useCapacity();
  const config = useConfig();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="system-view">
      <Section title="Health">
        <Panel query={health}>
          {(h) => (
            <>
              {h.admission === "recovery_incomplete" && (
                <Notice tone="error" testId="recovery-incomplete">
                  Startup recovery left {h.recovery?.blobFailures ?? 0} pending Artifact obligation(s) unresolved. The console serves reads only until it is restarted; the next start retries the reconciliation.
                </Notice>
              )}
              <Facts
                items={[
                  ["Admission", h.admission],
                  ["Database", `${h.database.disposition}, schema ${h.database.schemaVersion}`],
                  ["Started", h.startedAt],
                  ["Recovery", h.recovery === null ? "not run" : `${h.recovery.interruptedAttempts} interrupted, ${h.recovery.cancelledAttempts} cancelled, ${h.recovery.retryEligible} retry-eligible, ${h.recovery.workspaceReleased} worktrees released, blobs ${h.recovery.blobsComplete ? "complete" : "incomplete"}, ${h.recovery.outstandingPublications} outstanding publications`],
                ]}
              />
            </>
          )}
        </Panel>
      </Section>
      <Section title="Resource Governor">
        <Panel query={capacity}>
          {(c) => (
            <Facts
              items={[
                ["Process", `${c.process.active} / ${c.process.maxConcurrency} Attempts`],
                ["Worktrees", `${c.worktrees.active} / ${c.worktrees.max ?? "∞"}`],
                ...c.providers.map((p): [string, string] => [`Provider ${p.provider}`, `${p.active} / ${p.maxConcurrency}${p.availability.available ? "" : ` (unavailable until ${p.availability.retryAfter ?? "further notice"})`}`]),
                ["Active leases", c.activeLeases.length === 0 ? "none" : c.activeLeases.map((l) => `${l.runId.slice(0, 12)} / ${l.attemptId.slice(0, 12)}`).join("; ")],
              ]}
            />
          )}
        </Panel>
      </Section>
      <Section title="Defaults">
        <Panel query={config}>
          {(c) => (
            <Facts
              items={[
                ["Model", `${c.defaults.model} (${c.defaults.effort})`],
                ["Provider", `${c.provider.name}${c.provider.continuation ? ", session resumption on" : ""}`],
                ["Run Budget", `$${c.defaults.budget.maxCostUsd} · ${c.defaults.budget.maxTokens} tokens · ${c.defaults.budget.maxAttempts} attempts · concurrency ${c.defaults.budget.maxConcurrency ?? "∞"}`],
                ["Orchestrator allocation", allocation(c.defaults.orchestratorAllocation)],
                ["Node allocation", allocation(c.defaults.nodeAllocation)],
                ["Final reserve (code)", allocation(c.defaults.finalReserve.code)],
                ["Completion check", c.defaults.completionCheck?.command ?? "none"],
                ["Evaluator", c.defaults.evaluator],
                ["Workspace kinds", c.workspaceKinds.map((k) => `${k.kind}: ${k.publicationStrategies.length === 0 ? "no publication" : k.publicationStrategies.join("/")}`).join("; ")],
              ]}
            />
          )}
        </Panel>
      </Section>
    </div>
  );
}
