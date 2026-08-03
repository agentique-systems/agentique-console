/**
 * The conversation's write surface — trimmed from v1's session-composer: the
 * operator only ever talks to the Orchestrator, so there is no mention popover
 * and no addressing. Enter submits; Shift+Enter breaks a line; Shift+Tab cycles
 * the session mode (Claude Code's gesture).
 *
 * The footer owns every control that acts on the textarea: mode on the left,
 * the rewrite pass and the one send/stop/steer button on the right. There is no
 * separate interrupt button — see `sendMode` for the four states.
 */
import {
  CornerDownLeftIcon,
  CornerDownRightIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import {
  useImproveMessage,
  useInterruptUserSession,
  usePatchUserSession,
  usePostUserMessage,
} from "@/api/mutations";
import type { SessionMode, UserSession } from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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
  { session: UserSession; busy: boolean }
>(function Composer({ session, busy }, ref) {
  const post = usePostUserMessage();
  const patch = usePatchUserSession();
  const interrupt = useInterruptUserSession();
  const improve = useImproveMessage();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const archived = session.status === "archived";
  const empty = draft.trim() === "";
  const sendMode: SendMode =
    busy && !archived ? (empty ? "interrupt" : "steer") : "send";

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
    <form
      className="border-t border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="flex flex-col rounded-xl border border-border bg-card shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <textarea
          ref={textareaRef}
          value={draft}
          rows={2}
          placeholder={
            archived ? "session is archived" : "message the orchestrator…"
          }
          disabled={archived || post.isPending}
          className="field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
              return;
            }
            if (event.key === "Tab" && event.shiftKey) {
              event.preventDefault();
              cycleMode();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <ModeToggle
              mode={session.mode}
              disabled={patch.isPending || archived}
              onChange={setMode}
            />
            <span className="truncate text-[10px] text-muted-foreground">
              shift+tab to cycle
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="improve wording"
              title="rewrite this message more effectively"
              disabled={empty || archived || improve.isPending}
              onClick={runImprove}
            >
              {improve.isPending ? (
                <Spinner className="size-3" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
            </Button>
            <Button
              // Enter in the textarea must never reach a stop button.
              type={sendMode === "interrupt" ? "button" : "submit"}
              size="icon-xs"
              aria-label={SEND_LABEL[sendMode]}
              title={SEND_LABEL[sendMode]}
              disabled={
                sendMode === "interrupt"
                  ? interrupt.isPending
                  : archived || post.isPending || empty
              }
              onClick={
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
              {post.isPending ? (
                <Spinner className="size-3" />
              ) : sendMode === "interrupt" ? (
                <SquareIcon className="size-3 fill-current" />
              ) : sendMode === "steer" ? (
                <CornerDownRightIcon className="size-3" />
              ) : (
                <CornerDownLeftIcon className="size-3" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
});
