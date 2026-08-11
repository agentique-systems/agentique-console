/**
 * Provider-prose failure classification. The provider reports failures as
 * strings, so this coupling is unavoidable — but it lives HERE, in the SDK
 * adapter layer, acknowledged, and nowhere else. A transport failure is the
 * infrastructure's fault, not the model's: retrying it costs no redelivery
 * attempt, e.g. an ISP DNS hijack surfacing as
 * `getaddrinfo ENOTIMP api.anthropic.com`, or a provider 4xx during an outage.
 */
export function isTransportFailure(failure: string | null): boolean {
  if (failure === null) return false;
  return /API Error: 4\d\d/.test(failure)
    || /\b(ENOTIMP|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(failure)
    || /Connection error|Unable to connect to API/i.test(failure);
}
