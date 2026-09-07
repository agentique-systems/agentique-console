import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type KeyValueItem = { label: string; value: ReactNode; mono?: boolean; hint?: string } | [string, ReactNode];

/**
 * Labelled facts. Prose values stay in the sans face; ids, commands, and
 * quantities opt into mono per item. `columns` lays items out in a grid on
 * wide screens.
 */
export function KeyValue({ items, className, dense = false, columns = 1 }: { items: KeyValueItem[]; className?: string; dense?: boolean; columns?: 1 | 2 }) {
  const rows = items.map((item) => (Array.isArray(item) ? { label: item[0], value: item[1] } : item));
  return (
    <dl className={cn("grid gap-x-4 text-sm", dense ? "gap-y-1" : "gap-y-2", columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1", className)}>
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{row.label}</dt>
          <dd className={cn("min-w-0 break-words text-foreground", row.mono && "font-mono text-xs")}>
            {row.value === null || row.value === undefined || row.value === "" ? <span className="text-muted-foreground">—</span> : row.value}
          </dd>
          {row.hint !== undefined && <span className="text-2xs text-muted-foreground">{row.hint}</span>}
        </div>
      ))}
    </dl>
  );
}

/** The two-column label/value table: for a longer list of facts read top to bottom. */
export function KeyValueTable({ items, className }: { items: KeyValueItem[]; className?: string }) {
  const rows = items.map((item) => (Array.isArray(item) ? { label: item[0], value: item[1] } : item));
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cn("min-w-0 break-words", row.mono && "font-mono text-xs")}>{row.value === null || row.value === undefined || row.value === "" ? <span className="text-muted-foreground">—</span> : row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
