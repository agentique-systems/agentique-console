import { CopyButton } from "@/components/copy-button";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

/** An identifier, shortened for reading, whole on hover, copied in one click. */
export function IdChip({ id, full = false, copy = true, className }: { id: string; full?: boolean; copy?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5 font-mono text-xs text-muted-foreground", className)} title={id}>
      <span className="truncate">{full ? id : shortId(id)}</span>
      {copy && <CopyButton value={id} label="Copy id" className="size-5" />}
    </span>
  );
}
