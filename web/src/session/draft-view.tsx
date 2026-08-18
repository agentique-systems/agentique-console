/**
 * The draft-session posture, rendered inside the conversation column: pick a
 * mode and a model, say what you want, send. NOTHING exists on the server until
 * the send — that one call creates the session and posts your message; the row
 * then appears in the sidebar. No name is asked for anywhere: the server titles
 * the session from the first message.
 *
 * Built on the same vendored prompt-input the composer uses: a hand-rolled
 * `event.key === "Enter"` check submits mid-IME-composition and breaks every
 * CJK input method. One shell, one Enter contract, one footer, on both write
 * surfaces.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCreateUserSession } from "@/api/mutations";
import { useConfig } from "@/api/queries";
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
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

import { ModelPicker } from "./model-picker";
import { ModeToggle, nextMode } from "./session-header";

export function DraftView() {
  const create = useCreateUserSession();
  const config = useConfig();
  const cancelDraft = useUiStore((s) => s.cancelDraft);
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const [mode, setMode] = useState<SessionMode>("execute");
  const [message, setMessage] = useState("");
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

  const ready = workspaceId !== null && message.trim() !== "";
  /** Undefined until `/api/config` lands; the chip waits rather than guess. */
  const shownModel = model ?? config.data?.defaultModel;

  const send = () => {
    if (!ready || workspaceId === null) return;
    create.mutate(
      {
        workspaceId,
        mode,
        message: message.trim(),
        ...(model === null ? {} : { model }),
      },
      {
        onSuccess: ({ session }) => {
          setMessage("");
          useUiStore.getState().openSession(session.id);
        },
        onError: (error) => toast.error(`Create failed: ${error.message}`),
      },
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
        <div className="text-3xs uppercase tracking-wider text-muted-foreground">
          What do you want done?
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
              placeholder="say it like you'd brief a colleague — the orchestrator takes it from here"
              disabled={create.isPending}
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
                status={create.isPending ? "submitted" : "ready"}
                disabled={!ready || create.isPending}
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
