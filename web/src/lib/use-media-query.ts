import { useSyncExternalStore } from "react";

/** Whether a media query matches, live; `false` where `matchMedia` is unavailable (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Tailwind's `md` and `lg` breakpoints, for layouts that change shape rather than just style. */
export const useIsDesktop = () => useMediaQuery("(min-width: 768px)");
export const useIsWide = () => useMediaQuery("(min-width: 1024px)");
