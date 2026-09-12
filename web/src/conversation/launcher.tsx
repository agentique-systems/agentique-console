import { useState } from "react";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import { useNavigate } from "react-router";
import type { ConversationResponse, WorkspaceResponse } from "@agentique-console/core";

import { useCreateRun } from "@/api/mutations";
import { useConfig } from "@/api/queries";
import { Callout } from "@/components/callout";
import { errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { MOD_KEY } from "@/lib/hotkeys";
import { usd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Starting a Run: the goal is the whole ask; the completion check and the
 * Budget have validated server defaults the operator may override.
 */
export function RunLauncher({ conversation, workspace, className }: { conversation: ConversationResponse; workspace: WorkspaceResponse; className?: string }) {
  const config = useConfig();
  const navigate = useNavigate();
  const create = useCreateRun(conversation.conversation.id, (overview) => void navigate(`/runs/${overview.run.id}`));
  const [goal, setGoal] = useState("");
  const [check, setCheck] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [evaluator, setEvaluator] = useState<"reviewer" | "none" | "">("");
  const defaults = config.data?.defaults;
  const selectedProvider = provider ?? defaults?.provider ?? config.data?.provider.name ?? "claude";
  const catalog = config.data?.providers ?? [];
  const backend = catalog.find((p) => p.id === selectedProvider);
  const selectedModel = model ?? (selectedProvider === defaults?.provider ? defaults.model : backend?.defaultModel) ?? defaults?.model ?? "";
  const modelInfo = backend?.models.find((m) => m.id === selectedModel);
  const unavailable = backend?.availability.configured === false || modelInfo?.availability?.configured === false;
  const command = check ?? defaults?.completionCheck?.command ?? "";
  const target = workspace.defaultTarget?.kind === "branch" ? workspace.defaultTarget.branch : "the directory";
  const submit = () => {
    if (goal.trim() === "" || create.isPending || unavailable || !defaults) return;
    const budget = defaults && maxCostUsd.trim() !== "" && Number.isFinite(Number(maxCostUsd)) ? { ...defaults.budget, maxCostUsd: Number(maxCostUsd) } : undefined;
    create.mutate(
      {
        goal,
        ...(backend === undefined ? {} : { provider: selectedProvider, model: selectedModel }),
        completionCheck: command.trim() === "" ? null : { command: command.trim(), expectedExitCode: 0 },
        ...(budget === undefined ? {} : { budget }),
        ...(evaluator === "" ? {} : { evaluator }),
      },
    );
  };
  return (
    <form
      className={cn("surface-raised flex flex-col gap-3 rounded-lg border border-border bg-card p-3", className)}
      data-testid="start-run"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">Start a Run</h2>
          <p className="text-xs text-muted-foreground">
            Describe the goal. The Orchestrator reads the Workspace, proposes Requirements for your review, plans the work, and runs it in isolated worktrees. Nothing touches <span className="font-mono text-foreground">{target}</span> until you sign off and publish.
          </p>
        </div>
      </div>
      <Textarea
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
        placeholder="Add a --version flag to the CLI that prints the package version."
        aria-label="goal"
        rows={3}
        data-testid="goal"
      />
      {catalog.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Provider</span>
            <NativeSelect aria-label="provider" value={selectedProvider} onChange={(event) => { setProvider(event.target.value); setModel(null); }}>
              {catalog.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Model</span>
            <NativeSelect aria-label="model" value={selectedModel} onChange={(event) => setModel(event.target.value)}>
              {backend?.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.availability?.configured === false ? " (credentials required)" : ""}</option>)}
            </NativeSelect>
          </label>
          {unavailable && <p role="status" className="text-xs text-muted-foreground sm:col-span-2">{modelInfo?.availability?.configured === false ? modelInfo.availability.detail : backend?.availability.detail}</p>}
          {backend?.capabilities.usage?.status === "limited" && !modelInfo?.pricing && <p className="text-xs text-muted-foreground sm:col-span-2">USD cost is unknown without configured model pricing. Token, time, and attempt limits still apply.</p>}
          {backend && (
            <details className="text-xs text-muted-foreground sm:col-span-2">
              <summary className="cursor-pointer">Provider capabilities</summary>
              <dl className="mt-2 grid gap-1">
                {Object.entries(backend.capabilities).map(([name, capability]) => <div key={name}><dt className="inline font-medium">{name}: </dt><dd className="inline">{capability.detail}</dd></div>)}
              </dl>
            </details>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Completion check</span>
          <Input value={command} onChange={(event) => setCheck(event.target.value)} aria-label="completion check" className="font-mono text-xs" placeholder="npm test" />
          <span className="text-2xs text-muted-foreground">A command whose exit code decides completion; it runs against the integrated result.</span>
        </label>
        <button type="button" className="flex h-8 items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground sm:self-end sm:pb-5" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          <ChevronDownIcon className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
          Budget & evaluator
        </button>
      </div>
      {advanced && defaults && (
        <div className="grid gap-3 rounded-md border border-border-subtle bg-muted/30 p-3 text-xs sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Max cost (USD)</span>
            <Input value={maxCostUsd} onChange={(event) => setMaxCostUsd(event.target.value)} placeholder={String(defaults.budget.maxCostUsd)} aria-label="max cost" className="font-mono text-xs" inputMode="decimal" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Gate Evaluator</span>
            <NativeSelect value={evaluator} onChange={(event) => setEvaluator(event.target.value as "reviewer" | "none" | "")} aria-label="evaluator" className="text-xs">
              <option value="">Default ({defaults.evaluator})</option>
              <option value="reviewer">reviewer</option>
              <option value="none">none (deterministic only)</option>
            </NativeSelect>
          </label>
          <dl className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>Default Budget</dt>
              <dd className="font-mono">
                {usd(defaults.budget.maxCostUsd)} · {defaults.budget.maxAttempts} attempts
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Orchestrator per turn</dt>
              <dd className="font-mono">{usd(defaults.orchestratorAllocation.costUsd)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Final reserve</dt>
              <dd className="font-mono">{usd(defaults.finalReserve.code.costUsd)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Model</dt>
              <dd className="font-mono">{selectedModel}</dd>
            </div>
          </dl>
        </div>
      )}
      {create.isError && (
        <Callout tone="error" testId="start-run-error">
          {errorMessage(create.error)}
        </Callout>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:flex">
          <Kbd>{MOD_KEY}</Kbd>
          <Kbd>↵</Kbd>
          to start
        </span>
        <Button type="submit" disabled={create.isPending || goal.trim() === "" || unavailable || !defaults} data-testid="start-run-button">
          <PlayIcon />
          {create.isPending ? "Starting…" : "Start Run"}
        </Button>
      </div>
    </form>
  );
}
