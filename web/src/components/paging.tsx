import type { ReactNode } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { Page } from "@agentique-console/core";
import { itemsOf, type PagedQuery } from "@/api/queries";
import { Panel, errorMessage } from "@/components/panel";
import { Button } from "@/components/ui/button";

/** The button that follows a collection's next cursor; absent once the server reports no further page. */
export function LoadMore<T>({ query, label = "Load more", testId = "load-more" }: { query: PagedQuery<T>; label?: string; testId?: string }) {
  if (!query.hasNextPage) return null;
  return (
    <div className="flex items-center gap-2 py-1">
      <Button size="sm" variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} data-testid={testId}>
        {query.isFetchingNextPage ? "Loading…" : label}
      </Button>
      {query.isError && <span className="text-2xs text-status-failed">{errorMessage(query.error)}</span>}
    </div>
  );
}

/** Loading, error, and empty states of a paged collection, then its loaded items (each id once) and the next-page control. */
export function PagedList<T>({ query, idOf, empty, children, more, className }: { query: PagedQuery<T>; idOf: (item: T) => string; empty?: ReactNode; children: (items: T[]) => ReactNode; more?: { label?: string; testId?: string }; className?: string }) {
  return (
    <Panel query={query as unknown as { isPending: boolean; isError: boolean; error: unknown; data: InfiniteData<Page<T>, string | null> | undefined }} className={className}>
      {(data) => {
        const items = itemsOf(data, idOf);
        if (items.length === 0 && !query.hasNextPage) return <>{empty ?? <div className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing here yet.</div>}</>;
        return (
          <>
            {children(items)}
            <LoadMore query={query} {...more} />
          </>
        );
      }}
    </Panel>
  );
}
