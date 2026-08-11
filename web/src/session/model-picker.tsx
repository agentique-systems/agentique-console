/**
 * The one orchestrator-model picker, shared by the composer and the draft view
 * exactly as ModeToggle is — and shaped like it too: three inline chips, no
 * dialog, no search, no global hotkey. The list is three compile-time
 * constants; a command palette over it was scaffolding, not affordance.
 *
 * It owns no mutation: the composer patches a live session, the draft view
 * holds the choice in local state until the send that creates the session.
 * Agents are not selectable here and never will be — their models come from
 * profiles, which the Agents view owns.
 */
import { CpuIcon } from "lucide-react";

import {
  ORCHESTRATOR_MODELS,
  orchestratorModelLabel,
} from "@agentique-console/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ModelPicker({
  model,
  disabled = false,
  onChange,
}: {
  model: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const group = (
    <div
      role="radiogroup"
      aria-label={`orchestrator model: ${orchestratorModelLabel(model)}`}
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      <CpuIcon className="ml-1 size-3 shrink-0 text-muted-foreground" aria-hidden />
      {ORCHESTRATOR_MODELS.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          role="radio"
          aria-checked={candidate.id === model}
          disabled={disabled}
          title={candidate.blurb}
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-3xs lowercase tracking-wide transition-colors",
            candidate.id === model
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
          onClick={() => {
            if (candidate.id !== model) onChange(candidate.id);
          }}
        >
          {candidate.label}
        </button>
      ))}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{group}</TooltipTrigger>
      <TooltipContent>orchestrator model</TooltipContent>
    </Tooltip>
  );
}
