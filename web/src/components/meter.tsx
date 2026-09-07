import { percent, TONE_BG, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface MeterSegment {
  value: number;
  tone: Tone;
  label?: string;
}

/**
 * A horizontal bar of one or more segments against a total: budget consumed,
 * plan nodes by status, capacity in use. Colour is the status vocabulary.
 */
export function Meter({ segments, total, className, label, thin = false }: { segments: MeterSegment[]; total: number; className?: string; label?: string; thin?: boolean }) {
  const used = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={Math.max(total, used)} aria-valuenow={used} className={cn("flex w-full overflow-hidden rounded-full bg-muted", thin ? "h-1" : "h-1.5", className)}>
      {segments.map((segment, i) =>
        segment.value > 0 ? <div key={i} title={segment.label} className={cn("h-full transition-[width] duration-300", TONE_BG[segment.tone])} style={{ width: `${percent(segment.value, Math.max(total, used))}%` }} /> : null,
      )}
    </div>
  );
}

/** A labelled meter row: what it measures, used of limit, and the bar. */
export function MeterRow({ label, used, limit, format, tone, hint }: { label: string; used: number; limit: number; format: (v: number) => string; tone?: Tone; hint?: string }) {
  const p = percent(used, limit);
  const t: Tone = tone ?? (p >= 100 ? "failed" : p >= 85 ? "waiting" : "running");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">
          {format(used)} <span className="text-muted-foreground">/ {format(limit)}</span>
        </span>
      </div>
      <Meter segments={[{ value: used, tone: t }]} total={limit} label={label} />
      {hint !== undefined && <span className="text-2xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
