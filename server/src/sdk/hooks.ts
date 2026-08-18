import type { SdkHooksFragment } from "./types.ts";

/** Concatenating merge of hook fragments (later fragments append matchers). */
export function mergeHooks(fragments: SdkHooksFragment[]): SdkHooksFragment {
  const merged: SdkHooksFragment = {};
  for (const fragment of fragments) {
    for (const [event, matchers] of Object.entries(fragment)) {
      if (!matchers) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}
