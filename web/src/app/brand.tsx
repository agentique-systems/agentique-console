import { cn } from "@/lib/utils";

/** The Agentique mark: a single stroke "A" on a filled tile. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background", className)} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-[62%]">
        <path d="M5 19 12 5l7 14" />
        <path d="M8.6 13.5h6.8" />
      </svg>
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("text-sm font-semibold tracking-tight", className)}>Agentique</span>;
}
