import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code === "network" ? "The console server is unreachable." : error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Loading, error, and empty states rendered the same way everywhere. */
export function Panel<T>({ query, empty, children, className }: { query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined }; empty?: (data: T) => boolean; children: (data: T) => ReactNode; className?: string }) {
  if (query.isPending) {
    return (
      <div className={cn("flex items-center justify-center py-10", className)} data-testid="panel-loading">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className={cn("flex items-center gap-2 rounded-md border border-status-failed/40 p-3 text-xs text-status-failed", className)} data-testid="panel-error">
        <TriangleAlert className="size-4 shrink-0" />
        {errorMessage(query.error)}
      </div>
    );
  }
  const data = query.data as T;
  if (empty?.(data)) return <div className={cn("px-3 py-8 text-center text-xs text-muted-foreground", className)}>Nothing here yet.</div>;
  return <>{children(data)}</>;
}

export function Section({ title, children, actions, className }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-2xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone = "info", children, testId }: { tone?: "info" | "warning" | "error"; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("rounded-md border p-3 text-xs", tone === "error" ? "border-status-failed/40 text-status-failed" : tone === "warning" ? "border-status-waiting/40 text-foreground" : "border-border text-muted-foreground")}>
      {children}
    </div>
  );
}
