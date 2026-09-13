import type { AttemptExecutionOutcome, ProviderAdapter, TransientOutput } from "./adapter.ts";

/** Redacts exact credentials, including values without recognizable key prefixes. No global secret registry. */
export function protectCredentials(adapter: ProviderAdapter, credentials: string[]): ProviderAdapter {
  const secrets = [...new Set(credentials.filter((value) => value.length > 0))];
  if (!secrets.length) return adapter;
  const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? redact(item) : item)) as T;
  return {
    provider: adapter.provider, supportsContinuation: adapter.supportsContinuation,
    async execute(request): Promise<AttemptExecutionOutcome> {
      let pending = ""; let last: TransientOutput | null = null;
      const output = (event: TransientOutput, final = false) => {
        pending = redact(pending + event.text); last = event;
        // Keep any suffix that could be the beginning of a credential split between streaming chunks.
        let keep = 0;
        if (!final) for (const secret of secrets) for (let n = 1; n < secret.length && n <= pending.length; n++) if (pending.endsWith(secret.slice(0, n))) keep = Math.max(keep, n);
        const ready = pending.slice(0, pending.length - keep); pending = pending.slice(pending.length - keep);
        if (ready) request.output({ ...event, text: redact(ready) });
      };
      try {
        const containsSecret = (value: unknown) => { const text = JSON.stringify(value); return secrets.some((s) => text.includes(s)); };
        const result = await adapter.execute({ ...request, output,
          authorization: { authorize: (call) => containsSecret(call) ? { kind: "invalid", tool: call.tool, message: "Credential-bearing tool input was refused." } : request.authorization.authorize(call) },
          runtimeTools: { tools: request.runtimeTools.tools, call: async (call) => containsSecret(call) ? { kind: "failed", tool: call.tool, message: "Credential-bearing tool input was refused." } : request.runtimeTools.call(call) },
        });
        return { ...result, result: clean(result.result), completion: clean(result.completion), diagnostics: clean(result.diagnostics), transcript: result.transcript ? new TextEncoder().encode(redact(new TextDecoder().decode(result.transcript))) : null,
          // Continuations are opaque: if one contains a credential, discard it rather than persisting a secret or corrupting its format.
          continuation: result.continuation && secrets.some((s) => new TextDecoder().decode(result.continuation!).includes(s)) ? null : result.continuation };
      } catch { throw new Error("Provider execution failed. Credential-bearing error details were withheld."); }
      finally { if (last) output({ ...(last as TransientOutput), text: "" }, true); }
    },
  };
}
