import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { SendIcon, Settings2Icon } from "lucide-react";
import type { ConversationResponse, MessageBody, WorkspaceId } from "@agentique-console/core";
import { useCreateConversation, usePostMessage } from "@/api/mutations";
import { ApiError } from "@/api/client";
import { errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/settings/preferences";
import { Textarea } from "@/components/ui/textarea";

const outboxKey = (id: string) => `agentique-conversation-outbox:${id}`;
function readOutbox(id: string): MessageBody | null {
  try { return JSON.parse(localStorage.getItem(outboxKey(id)) ?? "null") as MessageBody | null; } catch { return null; }
}

/** One composer with a durable retry key. An uncertain response is retried with the exact original body. */
export function Composer({ conversation, workspaceId }: { conversation?: ConversationResponse; workspaceId: WorkspaceId }) {
  const id = conversation?.conversation.id;
  const draftKey = `agentique-conversation-draft:${id ?? workspaceId}`;
  const [content, setContent] = useState(() => localStorage.getItem(draftKey) ?? (id ? readOutbox(id)?.content : null) ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const shortcut = usePreferences((s) => s.sendShortcut);
  const create = useCreateConversation();
  const post = usePostMessage(id ?? "");
  const navigate = useNavigate();
  const sending = useRef(false);
  const pinned = conversation?.dialogueRun?.execution;
  const selectedModel = pinned?.model ?? "Provider settings";

  async function deliver(body: MessageBody) {
    if (!id || sending.current) return;
    sending.current = true;
    setFailure(null);
    try {
      await post.mutateAsync(body);
      localStorage.removeItem(outboxKey(id));
      localStorage.removeItem(draftKey);
      setContent("");
    } catch (error) {
      setFailure(errorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) localStorage.removeItem(outboxKey(id));
    } finally { sending.current = false; }
  }

  useEffect(() => {
    if (id) {
      const pending = readOutbox(id);
      if (pending) void deliver(pending);
    }
    // A mount/reconnect may replay the outbox; the server receipt makes it one operation.
  }, [id]);

  async function submit() {
    if (sending.current || create.isPending || post.isPending || !content.trim()) return;
    const body: MessageBody = (id ? readOutbox(id) : null) ?? { content: content.trim(), requestId: crypto.randomUUID() };
    if (id) {
      localStorage.setItem(outboxKey(id), JSON.stringify(body));
      await deliver(body);
      return;
    }
    setFailure(null);
    try {
      const created = await create.mutateAsync({ workspaceId, title: null });
      localStorage.setItem(outboxKey(created.conversation.id), JSON.stringify(body));
      localStorage.removeItem(draftKey);
      void navigate(`/conversations/${created.conversation.id}`);
    } catch (error) { setFailure(errorMessage(error)); }
  }

  return <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-4 pt-2 md:px-6">
    {failure && <p role="alert" className="mb-2 text-sm text-status-failed">{failure} <button type="button" className="underline" onClick={() => void submit()}>Retry message</button></p>}
    <form data-testid="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }} className="rounded-2xl border border-input bg-card p-3 shadow-sm">
      <Textarea aria-label="message" value={content} onChange={(event) => { setContent(event.target.value); localStorage.setItem(draftKey, event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (shortcut === "enter" || event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }}
        placeholder="Message the Orchestrator" rows={2} disabled={post.isPending || create.isPending || (failure !== null && id !== undefined && readOutbox(id) !== null)}
        className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" />
      <div className="flex items-center justify-between gap-2 pt-2">
        <Link to="/settings/providers" className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground" aria-label="Provider settings"><Settings2Icon className="size-3.5 shrink-0" /><span className="truncate">{selectedModel || "Configure a provider"}</span></Link>
        <Button type="submit" size="icon-sm" aria-label="Send" data-testid="send-message" disabled={!content.trim() || post.isPending || create.isPending}><SendIcon /></Button>
      </div>
    </form>
    <p className="mt-2 text-center text-2xs text-muted-foreground">{shortcut === "enter" ? "Enter" : "Ctrl / Command + Enter"} to send · Shift+Enter for a new line</p>
  </div>;
}
