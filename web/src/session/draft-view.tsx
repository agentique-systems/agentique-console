/**
 * The draft-session posture, rendered inside the conversation column: pick a
 * mode and a model, say what you want, send. NOTHING exists on the server until
 * the send — that one call creates the session and posts your message; the row
 * then appears in the sidebar. No name is asked for anywhere: the server titles
 * the session from the first message.
 *
 * The project picker is the continuation affordance: "start a new project" is
 * the default, and any project whose previous run ended (or sits quota-paused)
 * can be continued explicitly — same requirement graph, same decisions, plus
 * the prior run's continuation checkpoint. Continuing a project whose session
 * is still open (paused) HANDS IT OFF on send: the old session is archived
 * with its checkpoint and can never execute again; a fresh session takes over.
 * Nothing is ever attached silently — the selection and its consequence are
 * both on screen before the send.
 *
 * Built on the same vendored prompt-input the composer uses: a hand-rolled
 * `event.key === "Enter"` check submits mid-IME-composition and breaks every
 * CJK input method. One shell, one Enter contract, one footer, on both write
 * surfaces.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useContinueUserSession, useCreateUserSession } from "@/api/mutations";
import { useConfig, useWorkspaceProjects } from "@/api/queries";
import type { SessionMode } from "@agentique-console/shared";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

import { ModelPicker } from "./model-picker";
import {
  continuationRequiresHandoff,
  isContinuationCandidate,
  projectStatusLabel,
} from "./project-status";
import { ModeToggle, nextMode } from "./session-header";

export function DraftView() {
  const create = useCreateUserSession();
  const continueProject = useContinueUserSession();
  const config = useConfig();
  const cancelDraft = useUiStore((s) => s.cancelDraft);
  const draftContinuation = useUiStore((s) => s.draftContinuation);
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const projects = useWorkspaceProjects(workspaceId);
  const [mode, setMode] = useState<SessionMode>("execute");
  const [message, setMessage] = useState("");
  /** Null = start a new project; else the project the new session continues. */
  const [projectId, setProjectId] = useState<string | null>(
    () => draftContinuation?.projectId ?? null,
  );
  /**
   * Null until the operator picks, and until then it means "whatever the server
   * defaults to" — so the create call omits `model` entirely and a
   * `CONSOLE_MODEL` override keeps working without the client echoing a stale
   * copy of it back.
   */
  const [model, setModel] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // A "continue in a fresh session" click while the draft is already open
  // re-seeds the selection.
  useEffect(() => {
    if (draftContinuation !== null) setProjectId(draftContinuation.projectId);
  }, [draftContinuation]);

  /** Offered rows: no open session, or an open session held by a pause. */
  const candidates = (projects.data ?? []).filter(isContinuationCandidate);
  const selected =
    projectId === null
      ? null
      : (candidates.find((item) => item.id === projectId) ?? null);
  /** The still-open (paused) session the send hands off; null = plain attach. */
  const handoffSessionId =
    selected !== null && continuationRequiresHandoff(selected)
      ? selected.openSession!.id
      : null;

  const pending = create.isPending || continueProject.isPending;
  const ready = workspaceId !== null && message.trim() !== "";
  /** Undefined until `/api/config` lands; the chip waits rather than guess. */
  const shownModel = model ?? config.data?.defaultModel;

  const send = () => {
    if (!ready || workspaceId === null || pending) return;
    const callbacks = {
      onSuccess: ({ session }: { session: { id: string } }) => {
        setMessage("");
        useUiStore.getState().openSession(session.id);
      },
      onError: (error: Error) => toast.error(`Create failed: ${error.message}`),
    };
    if (handoffSessionId !== null) {
      // The explicit handoff path: the server archives the paused session
      // (recording its continuation checkpoint) and creates the successor.
      continueProject.mutate(
        {
          id: handoffSessionId,
          message: message.trim(),
          mode,
          ...(model === null ? {} : { model }),
        },
        callbacks,
      );
      return;
    }
    create.mutate(
      {
        workspaceId,
        mode,
        message: message.trim(),
        ...(model === null ? {} : { model }),
        ...(selected === null ? {} : { projectId: selected.id }),
      },
      callbacks,
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="draft-session">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          New session
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-2xs"
          onClick={cancelDraft}
        >
          cancel
        </Button>
      </div>

      <div className="flex flex-1 flex-col justify-end gap-3 p-3">
        {candidates.length > 0 && (
          <div className="flex flex-col gap-1" data-testid="draft-project-picker">
            <div className="text-3xs uppercase tracking-wider text-muted-foreground">
              Project
            </div>
            <div
              role="radiogroup"
              aria-label="project"
              className="flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1"
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected === null}
                className={cn(
                  "rounded-sm px-2 py-1 text-left text-2xs transition-colors",
                  selected === null
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setProjectId(null)}
              >
                Start a new project
              </button>
              {candidates.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected?.id === item.id}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-sm px-2 py-1 text-left text-2xs transition-colors",
                    selected?.id === item.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setProjectId(item.id)}
                >
                  <span className="truncate">
                    Continue: {item.name ?? item.id}
                  </span>
                  <span className="truncate text-3xs text-muted-foreground">
                    {projectStatusLabel(item)}
                    {` · ${item.sessionCount} ${item.sessionCount === 1 ? "session" : "sessions"}`}
                    {item.openRequirements > 0 && ` · ${item.openRequirements} open requirements`}
                    {item.hasCheckpoint && " · checkpoint ready"}
                    {item.intentPreview !== null && ` · ${item.intentPreview}`}
                  </span>
                </button>
              ))}
            </div>
            {selected !== null && (
              <div className="text-3xs text-muted-foreground" data-testid="draft-continuation-consequence">
                {handoffSessionId !== null
                  ? `Sending hands off the paused session${selected.openSession?.title === null || selected.openSession?.title === undefined ? "" : ` "${selected.openSession.title}"`} — it is archived with its continuation checkpoint and will not resume — and starts a fresh session on this project.`
                  : "The new session continues this project's requirements, decisions, and continuation checkpoint. Prior agent sessions stay archived."}
              </div>
            )}
          </div>
        )}

        <div className="text-3xs uppercase tracking-wider text-muted-foreground">
          {selected === null
            ? "What do you want done?"
            : "How should this project continue?"}
        </div>

        <PromptInput
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={message}
              rows={4}
              className="min-h-24"
              placeholder={
                selected === null
                  ? "say it like you'd brief a colleague — the orchestrator takes it from here"
                  : "your continuation direction outranks the prior run's strategy — e.g. what to prioritize now"
              }
              disabled={pending}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Tab" && event.shiftKey) {
                  // preventDefault also stops prompt-input's own Enter
                  // handling, which is exactly the contract it documents.
                  event.preventDefault();
                  setMode(nextMode(mode));
                }
              }}
            />
          </PromptInputBody>

          {/* The same two chips the composer teaches, in the same place, so
              the gesture is already learned once the session exists. */}
          <PromptInputFooter>
            <PromptInputTools>
              <ModeToggle mode={mode} onChange={setMode} />
              {shownModel !== undefined && (
                <ModelPicker model={shownModel} onChange={setModel} />
              )}
            </PromptInputTools>

            <PromptInputTools className="shrink-0">
              <PromptInputSubmit
                aria-label="send — this starts the session"
                title="send — this starts the session"
                status={pending ? "submitted" : "ready"}
                disabled={!ready || pending}
              />
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>

        <div className="text-3xs text-muted-foreground">
          {mode === "plan_execute"
            ? "the orchestrator plans first and waits for your approval"
            : "the orchestrator gets straight to work"}
        </div>
        <div className="text-3xs text-muted-foreground">
          Nothing is saved until you send — that send starts the session, and it
          names itself from your first message.
        </div>
      </div>
    </div>
  );
}
