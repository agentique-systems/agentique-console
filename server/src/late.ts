/**
 * A forward reference for the composition root's genuine cycles (host→runner,
 * MCP builder→profile manager). Throws on use-before-wire and on double-wire,
 * so a broken construction order fails loudly instead of dereferencing
 * undefined at some later runtime moment.
 */
export function late<T>(name: string): { get(): T; set(value: T): void } {
  let value: T | undefined;
  let wired = false;
  return {
    get(): T {
      if (!wired) throw new Error(`late reference "${name}" used before it was wired`);
      return value as T;
    },
    set(next: T): void {
      if (wired) throw new Error(`late reference "${name}" wired twice`);
      wired = true;
      value = next;
    },
  };
}
