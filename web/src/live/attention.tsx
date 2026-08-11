/**
 * Telling the operator, when the operator is not looking.
 *
 * Before this, a run waiting on a human announced itself with a 1.5px dot in
 * the sidebar and nothing else: no title change, no favicon badge, no toast, no
 * notification, no count anywhere. An operator on another tab had literally no
 * way to learn a question was open — which is a strange thing for a system
 * whose whole premise is that the human is in the loop.
 *
 * Headless: mounted once, renders nothing, drives browser-level surfaces.
 */
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { useUserSessions } from "@/api/queries";
import { useScopeStore } from "@/stores/scope";
import { useUiStore } from "@/stores/ui";

const BASE_TITLE = "Agentique Console";

/** The icon in index.html, with an attention dot painted into the corner. */
function badgedFavicon(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<text y=".9em" font-size="90">🏭</text>` +
    `<circle cx="76" cy="24" r="22" fill="#e08c3c"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function AttentionBridge(): null {
  const workspaceId = useScopeStore((state) => state.selectedWorkspaceId);
  const sessions = useUserSessions(workspaceId);
  const awaiting = useUiStore((state) => state.awaitingInput);
  /**
   * Already-announced keys. MANDATORY, not an optimisation: the SSE spine
   * resumes from `Last-Event-ID` and replays persisted events, so without this
   * every reconnect would re-toast and re-notify every open question.
   */
  const announced = useRef(new Set<string>());
  const originalIcon = useRef<string | null>(null);

  // Memoized: this array is an effect dependency, and a fresh identity every
  // render would run the effects every render.
  const needsYou = useMemo(
    () => (sessions.data ?? []).filter(
      (session) =>
        session.lifecycle === "open" &&
        (session.pendingInteractions > 0 || session.runState === "awaiting_signoff" || awaiting.has(session.id)),
    ),
    [sessions.data, awaiting],
  );

  // Title + favicon: the two surfaces visible from another tab. Restored only
  // on unmount — a cleanup keyed to the count briefly stripped the badge on
  // every transition.
  useEffect(() => {
    const count = needsYou.length;
    document.title = count === 0 ? BASE_TITLE : `(${count}) ${BASE_TITLE}`;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      if (originalIcon.current === null) originalIcon.current = link.getAttribute("href");
      link.href = count === 0 ? (originalIcon.current ?? link.href) : badgedFavicon();
    }
  }, [needsYou.length]);
  useEffect(() => () => {
    document.title = BASE_TITLE;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && originalIcon.current !== null) link.href = originalIcon.current;
  }, []);

  // Toast + notification on the RISING EDGE only.
  useEffect(() => {
    const live = new Set<string>();
    for (const session of needsYou) {
      // Keyed per session and REASON — never the pending count. Answering one
      // of two open questions must not evict the key and re-toast the other.
      const key = `${session.id}:${session.runState === "awaiting_signoff" ? "signoff" : "ask"}`;
      live.add(key);
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      const label = session.title ?? "Untitled session";
      const reason = session.runState === "awaiting_signoff" ? "is ready for your sign-off" : "needs your answer";
      toast(`${label} ${reason}`, {
        id: session.id,
        duration: Infinity,
        action: {
          label: "Open",
          onClick: () => useUiStore.setState({ activeUserSessionId: session.id }),
        },
      });
      // Only when they are elsewhere — a notification for a tab you are looking
      // at is noise. Permission is never REQUESTED here; see the header prompt.
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const notification = new Notification(`${label} ${reason}`, { tag: session.id });
        notification.onclick = () => {
          window.focus();
          useUiStore.setState({ activeUserSessionId: session.id });
        };
      }
    }
    // A session that stopped needing you takes its toast with it, and its key
    // is forgotten so a later re-ask announces again.
    for (const key of [...announced.current]) {
      if (live.has(key)) continue;
      announced.current.delete(key);
      toast.dismiss(key.slice(0, key.lastIndexOf(":")));
    }
  }, [needsYou]);

  return null;
}
