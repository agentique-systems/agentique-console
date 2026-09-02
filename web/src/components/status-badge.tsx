import { cn } from "@/lib/utils";
import { statusTone, TONE_CLASS, type Tone } from "@/lib/format";

export function StatusBadge({ status, tone, className, label }: { status: string; tone?: Tone; className?: string; label?: string }) {
  const t = tone ?? statusTone(status);
  return (
    <span data-status={status} className={cn("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-2xs font-medium", TONE_CLASS[t], className)}>
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}
