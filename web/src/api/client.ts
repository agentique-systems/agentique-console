/**
 * The one HTTP client over the core contract: every call names a route of
 * `API_ROUTES`, the path is built by the contract, and every error is the
 * server's typed envelope. Tests point it at a listening server through
 * `setApiBase`.
 */
import { API_ROUTES, apiPath, type ApiErrorBody, type ApiErrorCode, type ApiResponses, type ApiRouteName } from "@agentique-console/core";

let apiBase = "";

/** The origin the client calls; empty for the page's own origin. */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/$/, "");
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network",
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export type JsonRoute = Exclude<ApiRouteName, "events" | "getArtifactContent" | "downloadArtifact" | "getAttemptTranscript">;

export async function api<N extends JsonRoute>(name: N, options: CallOptions = {}): Promise<ApiResponses[N]> {
  const route = API_ROUTES[name];
  const response = await fetch(apiUrl(apiPath(name, options.params ?? {}, options.query ?? {})), {
    method: route.method,
    headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch((error: unknown) => {
    throw new ApiError(0, "network", error instanceof Error ? error.message : "the console server is unreachable");
  });
  if (!response.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await response.json()) as Partial<ApiErrorBody>;
    } catch {
      // A non-JSON error body keeps the status line.
    }
    throw new ApiError(response.status, body.error?.code ?? "internal", body.error?.message ?? `${response.status} ${response.statusText}`, body.error?.details ?? null);
  }
  return (await response.json()) as ApiResponses[N];
}

/** Bounded text content of an Artifact (or an Attempt transcript) through the inline content route. */
export async function apiText(path: string, query: Record<string, string | number | undefined> = {}): Promise<{ text: string; byteSize: number; truncated: boolean }> {
  const search = Object.entries(query)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const response = await fetch(apiUrl(search === "" ? path : `${path}?${search}`)).catch((error: unknown) => {
    throw new ApiError(0, "network", error instanceof Error ? error.message : "the console server is unreachable");
  });
  if (!response.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await response.json()) as Partial<ApiErrorBody>;
    } catch {
      // keep the status line
    }
    throw new ApiError(response.status, body.error?.code ?? "internal", body.error?.message ?? `${response.status} ${response.statusText}`, body.error?.details ?? null);
  }
  return { text: await response.text(), byteSize: Number(response.headers.get("x-artifact-byte-size") ?? "0"), truncated: response.headers.get("x-artifact-truncated") === "true" };
}
