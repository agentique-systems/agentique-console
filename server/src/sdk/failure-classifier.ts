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

/**
 * A plan/subscription usage cap — temporary by definition ("resets at …"),
 * so it must never spend redelivery attempts, escalate failures, or trigger
 * salvage. The observed prose in a live run was "You've hit your session
 * limit · resets 2:20am (Europe/Stockholm)"; that run hot-spun 14 zero-token
 * failing turns in 75 seconds and archived a seat's finished work off main
 * because nothing recognized the message.
 */
export function isCapacityFailure(failure: string | null): boolean {
  if (failure === null) return false;
  return /hit your .{0,20}limit/i.test(failure)
    || /(session|usage|weekly|plan) limit\b.*\breset/i.test(failure)
    || /limit reached\b.*\breset/i.test(failure);
}
