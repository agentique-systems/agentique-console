import type { ComponentProps } from "react";
import { BanIcon, CircleCheckIcon, CircleDotIcon, CircleIcon, CircleXIcon, GitMergeIcon, HourglassIcon, LoaderCircleIcon, MessageCircleQuestionMarkIcon, PauseIcon, PenLineIcon, RocketIcon, ShieldCheckIcon, UploadIcon, WalletIcon } from "lucide-react";
import type { RunPhase } from "@agentique-console/core";

import { PHASE_LABELS, phaseTone, statusTone, TONE_BG, TONE_SOFT, TONE_TEXT, words, type RowPhase, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A small filled dot in the tone's colour; a running dot breathes. */
export function StatusDot({ tone, live, className }: { tone: Tone; live?: boolean; className?: string }) {
  const breathing = live ?? tone === "running";
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONE_BG[tone], TONE_TEXT[tone], breathing && "console-live-dot", className)} />;
}

/**
 * A status label. `dot` (default) is a neutral label beside a coloured dot, for
 * dense lists; `pill` is a tinted chip, for the one status a card is about.
 */
export function StatusBadge({ status, tone, label, variant = "dot", className, ...props }: { status: string; tone?: Tone; label?: string; variant?: "dot" | "pill" } & Omit<ComponentProps<"span">, "children">) {
  const t = tone ?? statusTone(status);
  const text = label ?? words(status);
  if (variant === "pill") {
    return (
      <span data-status={status} className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-2xs font-medium whitespace-nowrap", TONE_SOFT[t], className)} {...props}>
        <StatusDot tone={t} className="size-1.5" />
        {text}
      </span>
    );
  }
  return (
    <span data-status={status} className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-foreground", className)} {...props}>
      <StatusDot tone={t} />
      {text}
    </span>
  );
}

export const PHASE_ICONS: Record<RunPhase, typeof CircleIcon> = {
  created: CircleIcon,
  running: LoaderCircleIcon,
  waiting_decision: MessageCircleQuestionMarkIcon,
  waiting_budget: WalletIcon,
  waiting_capacity: HourglassIcon,
  waiting_conflict: GitMergeIcon,
  paused: PauseIcon,
  verifying: ShieldCheckIcon,
  awaiting_signoff: PenLineIcon,
  completed_unpublished: CircleCheckIcon,
  publishing: UploadIcon,
  publish_failed: CircleXIcon,
  publish_unsupported: CircleCheckIcon,
  published: RocketIcon,
  failed: CircleXIcon,
  cancelled: BanIcon,
};

/** The Run's phase as a pill with its icon: the one place the phase is stated in full. */
export function PhaseBadge({ phase, label, size = "md", className }: { phase: RowPhase; label?: string; size?: "sm" | "md"; className?: string }) {
  const tone: Tone = phase === "completed" ? "completed" : phaseTone(phase);
  const Icon = phase === "completed" ? CircleCheckIcon : PHASE_ICONS[phase];
  const text = label ?? (phase === "completed" ? "Completed" : PHASE_LABELS[phase]);
  return (
    <span data-phase={phase} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap", TONE_SOFT[tone], size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-2xs", className)}>
      <Icon className={cn("shrink-0", size === "md" ? "size-3.5" : "size-3", phase === "running" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {text}
    </span>
  );
}

/** A count chip that draws the eye: open Decisions, pending proposals. */
export function CountBadge({ count, className, ...props }: { count: number } & ComponentProps<"span">) {
  if (count <= 0) return null;
  return (
    <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-alert px-1 font-mono text-3xs font-semibold text-background", className)} {...props}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

export { CircleDotIcon as CurrentIcon };
