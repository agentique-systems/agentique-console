import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useThemeStore, type ThemePreference } from "@/stores/theme";

const OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof SunIcon;
}[] = [
  { value: "light", label: "light", Icon: SunIcon },
  { value: "dark", label: "dark", Icon: MoonIcon },
  { value: "system", label: "follow system", Icon: MonitorIcon },
];

/**
 * A three-way segmented control rather than a two-state flip, because
 * "follow the OS" is a real answer and a flip cannot express it. Same shape as
 * the session ModeToggle so the console has one segmented-control idiom.
 */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  return (
    <div
      role="radiogroup"
      aria-label="colour theme"
      className="flex items-center rounded-md border border-border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          className={cn(
            "rounded-sm p-1 transition-colors",
            preference === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setPreference(value)}
        >
          <Icon className="size-3" />
        </button>
      ))}
    </div>
  );
}
