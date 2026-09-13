import type { SettingsValues } from "@agentique-console/core";
import { MODEL_EFFORTS } from "@agentique-console/core";
import { Group, NumberField, SelectField, TextField, ToggleField } from "./fields";
import type { EditorProps } from "./connections";

export const budgetFields = [
  { key: "maxCostUsd", label: "Cost budget (USD)", nullable: false, min: 0, step: 0.01 },
  { key: "maxTokens", label: "Token budget", nullable: false, min: 1, step: 1 },
  { key: "maxAttempts", label: "Attempt budget", nullable: false, min: 1, step: 1 },
  { key: "maxWallClockMs", label: "Total time (milliseconds)", nullable: true, min: 1, step: 1 },
  { key: "maxConcurrency", label: "Concurrent attempts", nullable: true, min: 1, step: 1 },
] as const;
export function BudgetFields({ budget, prefix, change, lock }: { budget: SettingsValues["execution"]["budget"]; prefix: string; change: EditorProps["change"]; lock: EditorProps["lock"] }) {
  return <>{budgetFields.map(({ key, ...field }) => <NumberField key={key} {...field} value={budget[key]} locked={lock(`${prefix}.${key}`)} onChange={(v) => change(`${prefix}.${key}`, v)} />)}</>;
}
export function ExecutionEditor({ values: v, change, lock }: EditorProps) {
  const e = v.execution;
  return <>
    <Group title="Agent defaults" description="These limits are captured when the runtime starts. Save, then restart the console to use them for new work. Existing manifests and allocations remain unchanged.">
      <SelectField label="Reasoning effort" value={e.effort} options={MODEL_EFFORTS.map((v) => ({ value: v, label: v }))} locked={lock("execution.effort")} onChange={(v) => change("execution.effort", v)} description="The selected model must support this effort, or have no configurable effort. Model capability declarations live in Providers & models." />
      <NumberField label="Invocation time (milliseconds)" value={e.maxWallClockMs} min={1000} onChange={(v) => change("execution.maxWallClockMs", v)} locked={lock("execution.maxWallClockMs")} />
    </Group>
    <Group title="Default work budget" description="New conversations and work inherit these limits. Dollar accounting is partial when a model does not report cost and has no configured pricing."><BudgetFields budget={e.budget} prefix="execution.budget" change={change} lock={lock} /></Group>
    <Group title="Verification" description="Coding work requires a deterministic completion check. Review, operator signoff, and publication keep their independent safeguards.">
      <TextField label="Completion command" value={e.completionCheck?.command ?? ""} onChange={(v) => change("execution.completionCheck", v ? { command: v, expectedExitCode: e.completionCheck?.expectedExitCode ?? 0 } : null)} locked={lock("execution.completionCheck")} description="Executed in an isolated verification workspace when the runtime verifies coding work. Leaving it blank prevents coding work from starting until a check is provided." />
      {e.completionCheck && <NumberField label="Expected exit code" value={e.completionCheck.expectedExitCode} onChange={(v) => change("execution.completionCheck.expectedExitCode", v)} locked={lock("execution.completionCheck")} />}
      <SelectField label="Default evaluator" value={e.evaluator} onChange={(v) => change("execution.evaluator", v)} locked={lock("execution.evaluator")} options={[{ value: "reviewer", label: "Reviewer" }, { value: "none", label: "No default evaluator" }]} description="Controls the default review agent; it does not remove deterministic checks, operator signoff, or publication approval." />
      <NumberField label="Check timeout (milliseconds)" value={e.checkTimeoutMs} min={1000} onChange={(v) => change("execution.checkTimeoutMs", v)} locked={lock("execution.checkTimeoutMs")} />
    </Group>
    <Group title="Continuation"><ToggleField label="Resume provider sessions" value={e.continuation} onChange={(v) => change("execution.continuation", v)} locked={lock("execution.continuation")} description="Reuses compatible provider state on retries. Provider and model identity must match." /><NumberField label="Continuation retention (milliseconds)" value={e.continuationTtlMs} nullable min={1} onChange={(v) => change("execution.continuationTtlMs", v)} locked={lock("execution.continuationTtlMs")} description="Bounds resumability; this is not a data-deletion schedule." /></Group>
    <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-semibold">Advanced allocation and concurrency limits</summary><div className="mt-5 space-y-7">
      {(["orchestratorAllocation", "nodeAllocation"] as const).map((allocation) => <Group key={allocation} title={allocation === "orchestratorAllocation" ? "Orchestrator allocation per turn" : "Default plan-node allocation"}>{(["costUsd", "tokens", "attempts"] as const).map((key) => <NumberField key={key} label={`${allocation === "orchestratorAllocation" ? "Orchestrator" : "Node"} ${key === "costUsd" ? "cost (USD)" : key}`} value={e[allocation][key]} step={key === "costUsd" ? 0.01 : 1} min={key === "costUsd" ? 0 : 1} onChange={(v) => change(`execution.${allocation}.${key}`, v)} locked={lock(`execution.${allocation}.${key}`)} />)}</Group>)}
      <Group title="Process capacity">{([{ key: "providerMaxConcurrency", label: "Attempts per provider" }, { key: "processMaxAttempts", label: "Attempts in this process" }, { key: "maxConcurrentRuns", label: "Concurrent conversations and work" }, { key: "maxWorktrees", label: "Concurrent worktrees" }] as const).map((f) => <NumberField key={f.key} label={f.label} value={e[f.key]} min={1} nullable={f.key === "maxWorktrees"} onChange={(v) => change(`execution.${f.key}`, v)} locked={lock(`execution.${f.key}`)} />)}</Group>
    </div></details>
  </>;
}
