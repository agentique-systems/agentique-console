import { MonitorIcon } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

/** Appearance is configured in the single instance Settings form. */
export function ThemeToggle({ className }: { className?: string }) {
  return <Link to="/settings/general" aria-label="Appearance settings" className={cn("flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring", className)}><MonitorIcon className="size-3.5" /></Link>;
}
