/**
 * The one orchestrator-model picker, shared by the composer and the draft view
 * exactly as ModeToggle is. It owns no mutation: the composer patches a live
 * session, the draft view holds the choice in local state until the send that
 * creates the session.
 *
 * Seats are not selectable here and never will be — their models come from
 * profiles, which the Agents view owns.
 */
import { CheckIcon, CpuIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  ORCHESTRATOR_MODELS,
  orchestratorModelLabel,
} from "@agentique-console/shared";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
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
  const [open, setOpen] = useState(false);

  // ⌘K / Ctrl+K opens it from anywhere in the composer, the way the palette
  // gesture is spelled everywhere else.
  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled]);

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      {/*
        asChild is load-bearing: PromptInput is a <form>, and a bare
        DialogTrigger renders a submit-type button — clicking the chip would
        send the message instead of opening the picker. PromptInputButton's
        type="button" wins here. The content portals to body, outside the
        form, so Enter inside the search input cannot submit either.
      */}
      <ModelSelectorTrigger asChild>
        <PromptInputButton
          aria-label={`orchestrator model: ${orchestratorModelLabel(model)}`}
          tooltip={{ content: "orchestrator model", shortcut: "⌘K" }}
          disabled={disabled}
        >
          <CpuIcon className="size-3" />
          <span className="truncate">{orchestratorModelLabel(model)}</span>
        </PromptInputButton>
      </ModelSelectorTrigger>

      <ModelSelectorContent title="Orchestrator model">
        <ModelSelectorInput placeholder="search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No matching model.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Anthropic">
            {ORCHESTRATOR_MODELS.map((candidate) => (
              <ModelSelectorItem
                key={candidate.id}
                value={`${candidate.label} ${candidate.id} ${candidate.blurb}`}
                onSelect={() => {
                  setOpen(false);
                  if (candidate.id !== model) onChange(candidate.id);
                }}
              >
                <CheckIcon
                  className={cn(
                    "size-3",
                    candidate.id === model ? "opacity-100" : "opacity-0",
                  )}
                />
                <ModelSelectorName>
                  <span className="font-medium">{candidate.id}</span>
                  <span className="ml-2 text-2xs text-muted-foreground">
                    {candidate.blurb}
                  </span>
                </ModelSelectorName>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
