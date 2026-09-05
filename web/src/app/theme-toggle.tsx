import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useThemeStore, type ThemePreference } from "@/stores/theme";

const OPTIONS: readonly { value: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "Follow system", Icon: MonitorIcon },
];

/** A three-way segmented control: "follow the OS" is a real answer and a flip cannot express it. */
export function ThemeToggle({ className }: { className?: string }) {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  return (
    <div role="radiogroup" aria-label="Colour theme" className={cn("inline-flex items-center rounded-md border border-border bg-background p-0.5", className)}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <button type="button" role="radio" aria-checked={preference === value} aria-label={label} className={cn("flex size-6 items-center justify-center rounded-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60", preference === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => setPreference(value)}>
              <Icon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
