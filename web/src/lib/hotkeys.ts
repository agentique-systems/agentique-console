import { useEffect } from "react";

/** Whether a key event happened inside a text field, where single-key shortcuts must not fire. */
export function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export type Hotkey = {
  /** `event.key`, compared case-insensitively. */
  key: string;
  /** Requires ⌘ on macOS or Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  /** Fires even while a text field has focus (only sensible with `mod`). */
  inEditor?: boolean;
  handler: (event: KeyboardEvent) => void;
};

/** Global keyboard shortcuts, one listener per hook; single-key shortcuts never fire inside a text field. */
export function useHotkeys(hotkeys: readonly Hotkey[], enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      for (const hotkey of hotkeys) {
        const mod = event.metaKey || event.ctrlKey;
        if ((hotkey.mod ?? false) !== mod) continue;
        if ((hotkey.shift ?? false) !== event.shiftKey) continue;
        if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) continue;
        if (!hotkey.inEditor && !hotkey.mod && isEditing(event.target)) continue;
        event.preventDefault();
        hotkey.handler(event);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkeys, enabled]);
}

/** The platform's modifier glyph for shortcut hints. */
export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
