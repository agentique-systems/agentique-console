import { create } from "zustand";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * Shared with the no-flash boot script inlined in index.html. That script runs
 * before React and stamps the class on <html>; if this key ever changes, change
 * it there too.
 */
export const THEME_STORAGE_KEY = "console:theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

function paint(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

interface ThemeState {
  readonly preference: ThemePreference;
  /** What is actually painted right now — "system" already collapsed. */
  readonly resolved: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
}

const initialPreference = readPreference();

export const useThemeStore = create<ThemeState>((set) => ({
  preference: initialPreference,
  resolved: resolve(initialPreference),
  setPreference: (preference) => {
    const resolved = resolve(preference);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
    paint(resolved);
    set({ preference, resolved });
  },
}));

/**
 * Follow the OS while the preference is "system". Registered once at module
 * scope — there is exactly one document to paint, so this needs no component
 * lifecycle and no cleanup.
 */
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    const { preference } = useThemeStore.getState();
    if (preference !== "system") return;
    const resolved = systemTheme();
    paint(resolved);
    useThemeStore.setState({ resolved });
  });
}

// The boot script already painted the right class; this only re-syncs if the
// module somehow loads into a document it didn't stamp (tests, for one).
paint(resolve(initialPreference));
