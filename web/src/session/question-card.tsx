/**
 * The inline AskUserQuestion card: 1..n question blocks, each with option
 * buttons. A single single-select question submits on click; anything richer
 * (multiSelect, several questions) toggles selections and submits once.
 *
 * Answered/dismissed cards render read-only with the chosen options
 * highlighted; stale cards (server restarted under the promise) grey out but
 * stay answerable — "answer anyway" wakes the session (M8 revival).
 */
import { CheckIcon, CircleHelpIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { useResolveInteraction } from "@/api/mutations";
import type { InteractionStatus } from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { QuestionItem } from "./user-fold";

export function QuestionCard({
  sessionId,
  item,
  pendingStatus,
}: {
  sessionId: string;
  item: QuestionItem;
  /** Authoritative live status from GET /:id pendingInteractions, if pending. */
  pendingStatus?: InteractionStatus | undefined;
}) {
  const resolve = useResolveInteraction();
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // A 409 means someone else answered — treat as answered locally.
  const [settled, setSettled] = useState(false);

  const answered = item.answer !== undefined || settled;
  const dismissed = item.answer?.dismissed === true;
  const stale = !answered && pendingStatus === "stale";
  const busy = resolve.isPending;

  // One question, single select → clicking IS the answer.
  const immediate =
    item.questions.length === 1 && item.questions[0]?.multiSelect !== true;

  const submit = (answers: Record<string, string[]>) => {
    resolve.mutate(
      { sessionId, interactionId: item.interactionId, body: { answers } },
      {
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            toast.error("Already answered elsewhere.");
            setSettled(true);
          } else {
            toast.error(`Answer failed: ${error.message}`);
          }
        },
      },
    );
  };

  const toggle = (question: string, label: string, multiSelect: boolean) => {
    setSelections((current) => {
      const chosen = current[question] ?? [];
      const next = multiSelect
        ? chosen.includes(label)
          ? chosen.filter((entry) => entry !== label)
          : [...chosen, label]
        : [label];
      return { ...current, [question]: next };
    });
  };

  const allChosen = item.questions.every(
    (question) => (selections[question.question] ?? []).length > 0,
  );

  return (
    <div
      data-testid="question-card"
      className={cn(
        "my-2 rounded-lg border border-attention/50 bg-attention/10 px-3 py-2",
        answered && "border-border bg-muted/20",
        stale && "opacity-60",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <CircleHelpIcon className="size-3.5 shrink-0 text-attention" />
        <span className="font-medium">the orchestrator asks</span>
        {stale && (
          <span className="text-muted-foreground">
            predates a restart — answer anyway if still relevant
          </span>
        )}
      </div>

      {item.questions.map((question) => {
        const chosenNow = selections[question.question] ?? [];
        const chosenFinal = item.answer?.answers?.[question.question] ?? [];
        return (
          <div key={question.question} className="mb-2 last:mb-0">
            {question.header !== undefined && (
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {question.header}
              </div>
            )}
            <div className="mb-1.5 text-sm">{question.question}</div>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const multiSelect = question.multiSelect === true;
                const picked = answered
                  ? chosenFinal.includes(option.label)
                  : chosenNow.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={answered || busy}
                    title={option.description}
                    className={cn(
                      "flex flex-col items-start rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs transition-colors",
                      !answered && !busy && "hover:bg-accent",
                      picked && "border-status-completed",
                      (answered || busy) && "cursor-default",
                    )}
                    onClick={() => {
                      if (answered || busy) return;
                      if (immediate) {
                        submit({ [question.question]: [option.label] });
                        return;
                      }
                      toggle(question.question, option.label, multiSelect);
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      {picked && (
                        <CheckIcon className="size-3 text-status-completed" />
                      )}
                      {option.label}
                    </span>
                    {option.description !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {!answered && !immediate && (
        <Button
          size="xs"
          className="mt-1"
          disabled={!allChosen || busy}
          onClick={() => submit(selections)}
        >
          {busy ? <Spinner className="size-3" /> : "Submit"}
        </Button>
      )}
      {busy && immediate && <Spinner className="mt-1 size-3" />}
      {dismissed && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          dismissed — you answered in chat instead
        </div>
      )}
    </div>
  );
}
