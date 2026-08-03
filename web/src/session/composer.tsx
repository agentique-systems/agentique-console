/**
 * The conversation's write surface — trimmed from v1's session-composer: the
 * operator only ever talks to the Orchestrator, so there is no mention popover
 * and no addressing. Enter submits; Shift+Enter breaks a line.
 *
 * A lean equivalent of v1's PromptInput look: bordered rounded shell, bare
 * textarea, footer with the submit button.
 */
import { CornerDownLeftIcon } from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { ApiError } from "@/api/client";
import { usePostUserMessage } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface ComposerHandle {
  focus(): void;
}

export const Composer = forwardRef<
  ComposerHandle,
  { sessionId: string | null; archived?: boolean }
>(function Composer({ sessionId, archived = false }, ref) {
  const post = usePostUserMessage();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const disabled = sessionId === null || archived;

  const send = () => {
    const text = draft.trim();
    if (text === "" || sessionId === null || archived || post.isPending) return;
    post.mutate(
      { id: sessionId, text },
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
            archived
              ? "session is archived"
              : "message the orchestrator…"
          }
          disabled={disabled || post.isPending}
          className="field-sizing-content max-h-48 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center justify-end px-2 pb-2">
          <Button
            type="submit"
            size="icon-xs"
            aria-label="send message"
            disabled={disabled || post.isPending || draft.trim() === ""}
          >
            {post.isPending ? (
              <Spinner className="size-3" />
            ) : (
              <CornerDownLeftIcon className="size-3" />
            )}
          </Button>
        </div>
      </div>
    </form>
  );
});
