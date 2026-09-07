import type { ReactNode } from "react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { ApiError } from "@/api/client";
import { Callout, type CalloutTone } from "@/components/callout";
import { KeyValue, type KeyValueItem } from "@/components/key-value";
import { Button } from "@/components/ui/button";
import { SkeletonLines } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code === "network" ? "The console server is unreachable." : error.message;
  return error instanceof Error ? error.message : String(error);
}

interface QueryLike<T> {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: T | undefined;
  refetch?: () => unknown;
}

/** Loading, error, and empty states rendered the same way everywhere; the children render the data. */
export function Panel<T>({ query, empty, emptyState, children, className, skeleton }: { query: QueryLike<T>; empty?: (data: T) => boolean; emptyState?: ReactNode; children: (data: T) => ReactNode; className?: string; skeleton?: ReactNode }) {
  if (query.isPending) {
    return (
      <div className={cn("py-2", className)} data-testid="panel-loading" aria-busy="true" aria-live="polite">
        {skeleton ?? <SkeletonLines />}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className={className} data-testid="panel-error">
        <Callout
          tone="error"
          icon={TriangleAlertIcon}
          action={
            query.refetch !== undefined ? (
              <Button size="sm" variant="outline" onClick={() => void query.refetch?.()}>
                <RefreshCwIcon />
                Retry
              </Button>
            ) : undefined
          }
        >
          {errorMessage(query.error)}
        </Callout>
      </div>
    );
  }
  const data = query.data as T;
  if (empty?.(data)) return <>{emptyState ?? <div className={cn("px-3 py-8 text-center text-xs text-muted-foreground", className)}>Nothing here yet.</div>}</>;
  return <>{children(data)}</>;
}

/**
 * A titled block of a page. `card` frames it as a surface; the default is an
 * open section with a small heading, for stacking inside a card or a column.
 */
export function Section({ title, description, children, actions, className, card = false, contentClassName, testId }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; card?: boolean; contentClassName?: string; testId?: string }) {
  if (card) {
    return (
      <section data-testid={testId} className={cn("surface-raised flex flex-col rounded-lg border border-border bg-card", className)}>
        <header className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-sm font-medium leading-5">{title}</h3>
            {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
        <div className={cn("flex flex-col gap-3 px-4 pb-4", contentClassName)}>{children}</div>
      </section>
    );
  }
  return (
    <section data-testid={testId} className={cn("flex flex-col gap-2", className)}>
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
          {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className={cn("flex flex-col gap-2", contentClassName)}>{children}</div>
    </section>
  );
}

/** Labelled facts in a grid (the KeyValue primitive, with the historical name). */
export function Facts({ items, columns = 2, dense }: { items: KeyValueItem[]; columns?: 1 | 2; dense?: boolean }) {
  return <KeyValue items={items} columns={columns} dense={dense} />;
}

/** A message with a tone (the Callout primitive, with the historical name). */
export function Notice({ tone = "info", children, testId, title, action }: { tone?: CalloutTone; children?: ReactNode; testId?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <Callout tone={tone} testId={testId} title={title} action={action}>
      {children}
    </Callout>
  );
}
