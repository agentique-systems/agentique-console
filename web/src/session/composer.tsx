/**
 * The conversation's write surface — trimmed from v1's session-composer: the
 * operator only ever talks to the Orchestrator, so there is no mention popover
 * and no addressing. Enter submits; Shift+Enter breaks a line; Shift+Tab cycles
 * the session mode (Claude Code's gesture).
 *
 * Built on the vendored AI Elements prompt-input, which owns the shell, the
 * composition-safe Enter handling (a bare keydown submits mid-IME-composition
 * and breaks every CJK input method), and the ChatStatus-driven submit button.
 *
 * The footer owns every control that acts on the turn about to be sent: mode
 * and orchestrator model on the left, the rewrite pass and the one
 * send/stop/steer button on the right. There is no separate interrupt button —
 * see `sendMode` for the states.
 */
import { CornerDownRightIcon, SparklesIcon } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import {
  useImproveMessage,
  useInterruptUserSession,
  usePatchUserSession,
  usePostUserMessage,
} from "@/api/mutations";
import { useConfig } from "@/api/queries";
import type { SessionMode, UserSession } from "@agentique-console/shared";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type ChatStatus,
} from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";

import { ModelPicker } from "./model-picker";
import { ModeToggle, nextMode } from "./session-header";

export interface ComposerHandle {
  focus(): void;
}

/**
 * What the primary button does right now. Steering is queueing: a message sent
 * mid-turn becomes the next turn rather than interrupting this one, so a draft
 * with text always sends — the square is only offered when there is nothing to
 * send.
 */
type SendMode = "send" | "steer" | "interrupt";

const SEND_LABEL: Record<SendMode, string> = {
  send: "send message",
  steer: "steer the running turn",
  interrupt: "interrupt the running turn",
};

export const Composer = forwardRef<
  ComposerHandle,
  { session: UserSession; busy: boolean; lockMode?: boolean }
>(function Composer({ session, busy, lockMode = false }, ref) {
  const post = usePostUserMessage();
  const patch = usePatchUserSession();
  const interrupt = useInterruptUserSession();
  const improve = useImproveMessage();
  const config = useConfig();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const archived = session.status === "archived";
  const empty = draft.trim() === "";
  /**
   * A session with no recorded model tracks the server's default, so the chip
   * shows that. Undefined until `/api/config` lands — the chip is held back
   * rather than flashing a guess that a `CONSOLE_MODEL` override would correct.
   */
  const model = session.model ?? config.data?.defaultModel;
  const sendMode: SendMode =
    busy && !archived ? (empty ? "interrupt" : "steer") : "send";

  /** The console's send modes, mapped onto prompt-input's four ChatStatuses. */
  const status: ChatStatus = post.isPending
    ? "submitted"
    : sendMode === "interrupt"
      ? "streaming"
      : "ready";

  const send = () => {
    const text = draft.trim();
    if (text === "" || archived || post.isPending) return;
    post.mutate(
      { id: session.id, text },
      {
        // The textarea is controlled — clearing the draft IS the reset.
        onSuccess: () => setDraft(""),
        onError: (error) => {
          toast.error(
            error instanceof ApiError && error.status === 409
              ? "The session is archived."
              : `Send failed: ${error.message}`,
          );
        },
      },
    );
  };

  const cycleMode = () => {
    if (archived || patch.isPending) return;
    patch.mutate(
      { id: session.id, mode: nextMode(session.mode) },
      {
        onError: (error) => toast.error(`Mode change failed: ${error.message}`),
      },
    );
  };

  const setMode = (mode: SessionMode) => {
    if (mode === session.mode) return;
    patch.mutate(
      { id: session.id, mode },
      {
        onError: (error) => toast.error(`Mode change failed: ${error.message}`),
      },
    );
  };

  // The lane's options are frozen at spawn, so the server recycles it — a turn
  // already running finishes on the model it started with.
  const setModel = (model: string) => {
    if (model === session.model) return;
    patch.mutate(
      { id: session.id, model },
      {
        onSuccess: () =>
          toast.success(`Next turn runs on ${model}`, { duration: 3000 }),
        onError: (error) => toast.error(`Model change failed: ${error.message}`),
      },
    );
  };

  const runImprove = () => {
    const original = draft;
    if (original.trim() === "" || archived || improve.isPending) return;
    improve.mutate(
      { text: original },
      {
        onSuccess: ({ text }) => {
          // Typing during the round trip wins — don't clobber newer keystrokes.
          setDraft((current) => (current === original ? text : current));
          // Programmatic setState breaks native undo, so offer it here.
          toast.success("Wording improved", {
            action: { label: "Undo", onClick: () => setDraft(original) },
          });
        },
        onError: (error) => toast.error(`Improve failed: ${error.message}`),
      },
    );
  };

  return (
    <div className="border-t border-border p-3">
      <PromptInput
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            value={draft}
            rows={2}
            placeholder={
              archived ? "session is archived" : "message the orchestrator…"
            }
            disabled={archived || post.isPending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (!lockMode && event.key === "Tab" && event.shiftKey) {
                // preventDefault also stops prompt-input's own Enter handling,
                // which is exactly the contract it documents.
                event.preventDefault();
                cycleMode();
              }
            }}
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {lockMode ? (
              <span className="truncate text-3xs text-muted-foreground">
                plan approval required
              </span>
            ) : (
              <ModeToggle
                mode={session.mode}
                disabled={patch.isPending || archived}
                onChange={setMode}
              />
            )}
            {/* Null means "the server's default" — render that, not "null". */}
            {model !== undefined && (
              <ModelPicker
                model={model}
                disabled={patch.isPending || archived}
                onChange={setModel}
              />
            )}
          </PromptInputTools>

          <PromptInputTools className="shrink-0 gap-1">
            <PromptInputButton
              aria-label="improve wording"
              tooltip="rewrite this message more effectively"
              disabled={empty || archived || improve.isPending}
              onClick={runImprove}
            >
              {improve.isPending ? (
                <Spinner className="size-3" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
            </PromptInputButton>

            <PromptInputSubmit
              aria-label={SEND_LABEL[sendMode]}
              title={SEND_LABEL[sendMode]}
              status={status}
              disabled={
                sendMode === "interrupt"
                  ? interrupt.isPending
                  : archived || post.isPending || empty
              }
              onStop={
                sendMode === "interrupt"
                  ? () =>
                      interrupt.mutate(
                        { id: session.id },
                        {
                          onError: (error) =>
                            toast.error(`Interrupt failed: ${error.message}`),
                        },
                      )
                  : undefined
              }
            >
              {sendMode === "steer" && !post.isPending ? (
                <CornerDownRightIcon className="size-3" />
              ) : undefined}
            </PromptInputSubmit>
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
});
