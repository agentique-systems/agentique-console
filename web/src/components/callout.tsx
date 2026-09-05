import type { ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type CalloutTone = "info" | "warning" | "error" | "success";

const TONE: Record<CalloutTone, { icon: typeof InfoIcon; box: string; icon_: string }> = {
  info: { icon: InfoIcon, box: "border-border bg-card text-foreground", icon_: "text-muted-foreground" },
  warning: { icon: TriangleAlertIcon, box: "border-status-waiting/40 bg-status-waiting/8 text-foreground", icon_: "text-status-waiting" },
  error: { icon: CircleAlertIcon, box: "border-status-failed/40 bg-status-failed/8 text-foreground", icon_: "text-status-failed" },
  success: { icon: CircleCheckIcon, box: "border-status-completed/40 bg-status-completed/8 text-foreground", icon_: "text-status-completed" },
};

/** A message with a tone: what is happening, what went wrong, what was done. */
export function Callout({ tone = "info", title, children, action, icon, className, testId }: { tone?: CalloutTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; icon?: typeof InfoIcon | null; className?: string; testId?: string }) {
  const spec = TONE[tone];
  const Icon = icon === undefined ? spec.icon : icon;
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid={testId} data-tone={tone} className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm", spec.box, className)}>
      {Icon !== null && <Icon className={cn("mt-0.5 size-4 shrink-0", spec.icon_)} aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title !== undefined && <div className="font-medium">{title}</div>}
        {children !== undefined && <div className={cn(title !== undefined && "text-muted-foreground")}>{children}</div>}
      </div>
      {action !== undefined && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
