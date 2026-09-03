/**
 * A Conversation's messages as the operator reads them: the newest page
 * first, older history on demand, and everything posted afterwards live.
 *
 * Three queries share one anchor, taken once per Conversation from the
 * newest page: the **seed** (that page, kept as it was), the **older**
 * pages (newest-first from the seed's `nextCursor`, fetched only when asked
 * and never refetched — history is append-only), and the **live** pages
 * (oldest-first from the seed's `reverseCursor`, refetched whenever an
 * Event of the Conversation arrives, and followed to their end). Together
 * they cover the Conversation exactly once: below the anchor, the anchor
 * page, above the anchor. An Event never refetches history, and history
 * never hides a new message.
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConversationMessage } from "@agentique-console/core";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { itemsOf, usePage } from "@/api/queries";

export const MESSAGE_PAGE = 50;

export interface ConversationMessages {
  status: "pending" | "error" | "success";
  error: unknown;
  /** Every loaded message, oldest first, each once. */
  messages: ConversationMessage[];
  /** Whether older history exists beyond what is loaded. */
  hasOlder: boolean;
  loadOlder: () => void;
  isLoadingOlder: boolean;
  /** Whether the live side is still following new pages (a burst larger than one page). */
  isFollowing: boolean;
}

export function useConversationMessages(conversationId: string): ConversationMessages {
  // The anchor: the newest page at mount, outside the Conversation's invalidation prefix so an Event never moves it.
  const seed = useQuery({
    queryKey: keys.messagesSeed(conversationId),
    queryFn: () => api("listConversationMessages", { params: { conversationId }, query: { order: "desc", limit: MESSAGE_PAGE } }),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const anchored = seed.data !== undefined;
  // History below the anchor: newest-first pages from the seed's next cursor, on demand, never refetched.
  const older = usePage("listConversationMessages", keys.messagesOlder(conversationId, seed.data?.nextCursor ?? null), { params: { conversationId }, order: "desc", limit: MESSAGE_PAGE, initialCursor: seed.data?.nextCursor ?? null, enabled: false, staleTime: Infinity });
  // Everything above the anchor: oldest-first pages from the seed's reverse cursor, refetched on every Event of the Conversation.
  const live = usePage("listConversationMessages", keys.messagesLive(conversationId, seed.data?.reverseCursor ?? null), { params: { conversationId }, order: "asc", limit: MESSAGE_PAGE, initialCursor: seed.data?.reverseCursor ?? null, enabled: anchored });
  // The live side follows a burst larger than one page to its end.
  useEffect(() => {
    if (live.hasNextPage && !live.isFetching) void live.fetchNextPage();
  }, [live.hasNextPage, live.isFetching, live.data?.pages.length, live]);
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const out: ConversationMessage[] = [];
    const push = (m: ConversationMessage) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      out.push(m);
    };
    for (const m of [...itemsOf(older.data, (m) => m.id)].reverse()) push(m);
    for (const m of [...(seed.data?.items ?? [])].reverse()) push(m);
    for (const m of itemsOf(live.data, (m) => m.id)) push(m);
    return out;
  }, [older.data, seed.data, live.data]);
  const hasOlder = seed.data?.nextCursor !== null && seed.data !== undefined && (older.data === undefined || older.hasNextPage);
  return {
    status: seed.isPending ? "pending" : seed.isError ? "error" : "success",
    error: seed.error ?? older.error ?? live.error,
    messages,
    hasOlder,
    loadOlder: () => {
      if (older.data === undefined) void older.refetch();
      else if (older.hasNextPage) void older.fetchNextPage();
    },
    isLoadingOlder: older.isFetching,
    isFollowing: live.hasNextPage === true,
  };
}
