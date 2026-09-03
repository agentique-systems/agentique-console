/**
 * The closed, sanitized classification of a provider failure. The provider
 * reports many failures as prose, so this coupling is unavoidable — but it
 * lives here, in the adapter layer, and nowhere else: the runtime receives
 * a closed kind, a transient/permanent verdict, and a bounded message that
 * carries no credential, payload, or environment.
 *
 * Transient failures (transport, capacity, overload, server errors, a
 * subprocess that died) are the infrastructure's fault: the runtime may
 * retry them under its own policy. Permanent failures (authentication,
 * billing, an invalid request, an unavailable model, an exhausted turn
 * bound) would fail the same way again and are never retried by the
 * adapter or by the runtime as transient.
 */
import { boundedFailureMessage } from "@agentique-console/core";

export const PROVIDER_FAILURE_KINDS = [
  /** The API could not be reached or answered with a client-side transport error. */
  "transport",
  /** The provider rate-limited the request. */
  "rate_limited",
  /** A plan or subscription usage cap; temporary by definition ("resets at …"). */
  "capacity",
  /** The provider is overloaded. */
  "overloaded",
  /** A provider-side server error. */
  "server_error",
  /** Credentials are missing, invalid, or not permitted for the organization. */
  "authentication",
  /** A billing problem on the account. */
  "billing",
  /** The request was rejected as invalid (a prompt too long, a malformed tool schema). */
  "invalid_request",
  /** The requested model does not exist or is not available to the account. */
  "model_unavailable",
  /** The adapter's turn bound was exhausted before the model returned a result. */
  "max_turns",
  /** The subprocess ended without a result message. */
  "process_exit",
  /** The SDK reported a failure the adapter cannot place. */
  "unknown",
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

const TRANSIENT: ReadonlySet<ProviderFailureKind> = new Set(["transport", "rate_limited", "capacity", "overloaded", "server_error", "process_exit", "unknown"]);

export function isTransientFailure(kind: ProviderFailureKind): boolean {
  return TRANSIENT.has(kind);
}

/** A transport failure: DNS, connection, timeout, or a client-side API error surfaced as prose (the legacy classifier's rule, kept). */
export function isTransportFailure(text: string | null): boolean {
  if (text === null) return false;
  return /API Error: 4\d\d/.test(text) || /\b(ENOTIMP|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE)\b/.test(text) || /Connection error|Unable to connect to API|fetch failed/i.test(text);
}

/** A plan or subscription cap ("You've hit your … limit · resets …"); never spends a permanent failure. */
export function isCapacityFailure(text: string | null): boolean {
  if (text === null) return false;
  return /hit your .{0,20}limit/i.test(text) || /(session|usage|weekly|plan) limit\b.*\breset/i.test(text) || /limit reached\b.*\breset/i.test(text);
}

/** The SDK's closed assistant error names, mapped to the adapter's closed kinds. */
export function classifyAssistantError(error: string): ProviderFailureKind {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "authentication";
    case "billing_error":
      return "billing";
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
      return "overloaded";
    case "invalid_request":
      return "invalid_request";
    case "model_not_found":
      return "model_unavailable";
    case "server_error":
      return "server_error";
    case "max_output_tokens":
      // The model exhausted its output budget for one request; another request may finish the work.
      return "unknown";
    default:
      return "unknown";
  }
}

/** Classifies failure prose the SDK reports without a closed error name. */
export function classifyFailureText(text: string | null): ProviderFailureKind {
  if (text === null || text.trim() === "") return "unknown";
  if (isCapacityFailure(text)) return "capacity";
  if (/\b429\b|rate.?limit/i.test(text)) return "rate_limited";
  if (/\b(401|403)\b|authentication|unauthori[sz]ed|invalid api key|not logged in|login/i.test(text)) return "authentication";
  if (/billing|credit balance|payment/i.test(text)) return "billing";
  if (/\b404\b.*model|model.*(not found|does not exist|not available)/i.test(text)) return "model_unavailable";
  if (/\b529\b|overloaded/i.test(text)) return "overloaded";
  if (/\b5\d\d\b|internal server error|server error/i.test(text)) return "server_error";
  if (isTransportFailure(text)) return "transport";
  if (/\b400\b|invalid request|prompt is too long|too long/i.test(text)) return "invalid_request";
  return "unknown";
}

const SECRET_MARKERS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|token|apikey|api_key|x-api-key)\s*[:=]?\s*[A-Za-z0-9_\-.]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Strips anything that looks like a credential and bounds the text to the Attempt failure message limit. */
export function sanitizeFailureMessage(text: string): string {
  let out = text.replace(/\r?\n+/g, " ");
  for (const pattern of SECRET_MARKERS) out = out.replace(pattern, "[redacted]");
  return boundedFailureMessage(out.trim() === "" ? "provider failure" : out.trim());
}

export interface ClassifiedProviderFailure {
  kind: ProviderFailureKind;
  transient: boolean;
  message: string;
}

/** One closed classification from an optional error name and the failure prose; the message is sanitized and bounded. */
export function classifyProviderFailure(input: { error?: string | null; text?: string | null; kind?: ProviderFailureKind }): ClassifiedProviderFailure {
  const kind = input.kind ?? (input.error ? classifyAssistantError(input.error) : classifyFailureText(input.text ?? null));
  const resolved = kind === "unknown" && input.text ? classifyFailureText(input.text) : kind;
  return { kind: resolved, transient: isTransientFailure(resolved), message: sanitizeFailureMessage(`${resolved}: ${input.text ?? input.error ?? "provider failure"}`) };
}
