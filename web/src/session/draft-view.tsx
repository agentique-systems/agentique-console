/**
 * The draft-session posture, rendered inside the conversation column: pick a
 * mode, say what you want, send. NOTHING exists on the server until the send —
 * that one call creates the session and posts your message; the row then
 * appears in the sidebar. No name is asked for anywhere: the server titles the
 * session from the first message.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useCreateUserSession } from "@/api/mutations";
import type { SessionMode } from "@agentique-console/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

import { ModeToggle, nextMode } from "./session-header";

export function DraftView() {
  const create = useCreateUserSession();
  const cancelDraft = useUiStore((s) => s.cancelDraft);
  const workspaceId = useScopeStore((s) => s.selectedWorkspaceId);
  const [mode, setMode] = useState<SessionMode>("execute");
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const ready = workspaceId !== null && message.trim() !== "";

  const send = () => {
    if (!ready || workspaceId === null) return;
    create.mutate(
      { workspaceId, mode, message: message.trim() },
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
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          New session
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={cancelDraft}
        >
          cancel
        </Button>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-3 p-3">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider">
            What do you want done?
          </Label>
          <Textarea
            ref={textareaRef}
            className="min-h-24 text-xs"
            value={message}
            placeholder="say it like you'd brief a colleague — the orchestrator takes it from here"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
                return;
              }
              if (event.key === "Tab" && event.shiftKey) {
                event.preventDefault();
                setMode(nextMode(mode));
              }
            }}
          />
        </div>
        {/* Mode sits under the box here too, so the gesture is the same one the
            composer teaches once the session exists. */}
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} onChange={setMode} />
          <span className="text-[10px] text-muted-foreground">
            shift+tab to cycle
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground">
          {mode === "plan_execute"
            ? "the orchestrator plans first and waits for your approval"
            : "the orchestrator gets straight to work"}
        </div>
        <Button size="sm" disabled={!ready || create.isPending} onClick={send}>
          {create.isPending ? "starting…" : "send — this starts the session"}
        </Button>
        <div className="text-[10px] text-muted-foreground">
          Nothing is saved until you send. The session names itself from your
          first message.
        </div>
      </div>
    </div>
  );
}
