/**
 * The inline AskUserQuestion card: 1..n question blocks, each with option
 * buttons, the asking seat's own words (context) and recommendation, and —
 * when the asker allowed it — a free-text answer box. A single single-select
 * question submits on option click; anything richer (multiSelect, several
 * questions, typed answers) toggles selections and submits once.
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
import { Card, CardContent, CardEyebrow, CardHeader } from "@/components/ui/card";
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
  const [freeTexts, setFreeTexts] = useState<Record<string, string>>({});
  // A 409 means someone else answered — treat as answered locally.
  const [settled, setSettled] = useState(false);

  const answered = item.answer !== undefined || settled;
  const dismissed = item.answer?.dismissed === true;
  const stale = !answered && pendingStatus === "stale";
  const busy = resolve.isPending;
  const allowFreeText = item.allowFreeText === true;

  const typedNow = (question: string) => (freeTexts[question] ?? "").trim();
  const anyTyped = item.questions.some((question) => typedNow(question.question) !== "");

  // One question, single select, nothing typed → clicking IS the answer.
  const immediate =
    item.questions.length === 1 && item.questions[0]?.multiSelect !== true && !anyTyped;

  const submit = (answers: Record<string, string[]>) => {
    const freeText = Object.fromEntries(
      item.questions
        .map((question) => [question.question, typedNow(question.question)] as const)
        .filter(([, text]) => text !== ""),
    );
    resolve.mutate(
      {
        sessionId,
        interactionId: item.interactionId,
        body: Object.keys(freeText).length > 0 ? { answers, freeText } : { answers },
      },
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
    (question) =>
      (selections[question.question] ?? []).length > 0 ||
      typedNow(question.question) !== "",
  );

  return (
    <Card
      data-testid="question-card"
      className={cn(
        "my-2 border-attention/50 bg-attention/10",
        answered && "border-border bg-muted/20",
        stale && "opacity-60",
      )}
    >
      <CardHeader>
        <CardEyebrow className={cn(!answered && "text-attention")}>
          <CircleHelpIcon className="size-3.5 shrink-0" />
          <span>{item.askedBy === undefined ? "the orchestrator asks" : `${item.askedBy} asks`}</span>
        </CardEyebrow>
        {stale && (
          <span className="text-2xs normal-case text-muted-foreground">
            predates a restart — answer anyway if still relevant
          </span>
        )}
      </CardHeader>

      <CardContent className="pt-0">
      {item.questions.map((question) => {
        const chosenNow = selections[question.question] ?? [];
        const chosenFinal = item.answer?.answers?.[question.question] ?? [];
        const typedFinal = item.answer?.freeText?.[question.question];
        return (
          <div key={question.question} className="mb-2 last:mb-0">
            {question.header !== undefined && (
              <div className="text-3xs uppercase tracking-wider text-muted-foreground">
                {question.header}
              </div>
            )}
            <div className="mb-1.5 text-sm">{question.question}</div>
            {question.context !== undefined && (
              <div className="mb-1.5 whitespace-pre-wrap text-2xs text-muted-foreground">
                {question.context}
              </div>
            )}
            {question.recommendation !== undefined && (
              <div className="mb-1.5 text-2xs text-muted-foreground">
                <span className="font-medium text-foreground/80">recommends:</span>{" "}
                {question.recommendation}
              </div>
            )}
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
                      <span className="text-3xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {allowFreeText && !answered && (
              <textarea
                rows={1}
                placeholder="Or answer in your own words…"
                disabled={busy}
                value={freeTexts[question.question] ?? ""}
                onChange={(event) =>
                  setFreeTexts((current) => ({ ...current, [question.question]: event.target.value }))
                }
                className="mt-1.5 w-full resize-y rounded-md border border-border bg-card px-2.5 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
            {answered && typedFinal !== undefined && (
              <div className="mt-1 text-2xs text-muted-foreground">
                answered in your words: “{typedFinal}”
              </div>
            )}
          </div>
        );
      })}

      {!answered && (!immediate || anyTyped) && (
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
        <div className="mt-1 text-2xs text-muted-foreground">
          dismissed — you answered in chat instead
        </div>
      )}
      </CardContent>
    </Card>
  );
}
