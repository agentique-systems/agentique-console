/**
 * Session titling: the first operator message, word-boundary truncated (D5).
 * The interface stays a function so a model-based titler can drop in later.
 */
export function titleFromFirstMessage(text: string, max = 60): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 24 ? lastSpace : max)}…`;
}
