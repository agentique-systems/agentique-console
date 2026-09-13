import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ValidationError, settingsEndpointSchema, type ConnectionTestRequest, type ConnectionTestResult } from "@agentique-console/core";

/** Deliberately conservative: private, link-local, multicast and transition address ranges are not public endpoints. */
export function isPublicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  return /^[23]/.test(value) && !value.startsWith("2001:db8:") && !value.startsWith("2002:") && !value.startsWith("2001:0:");
}
export function validateEndpoint(value: string, nativeOrigins: string[], trustedOrigins: string[]): URL {
  if (!value || !settingsEndpointSchema.safeParse(value).success) throw new ValidationError("Use an HTTP(S) endpoint without credentials, query parameters, or a fragment.");
  const url = new URL(value);
  const trusted = trustedOrigins.includes(url.origin);
  if (!trusted && !nativeOrigins.includes(url.origin)) throw new ValidationError("This endpoint origin is not trusted. Add its exact origin to CONSOLE_TRUSTED_ENDPOINT_ORIGINS and restart before configuring it.");
  if (url.protocol !== "https:" && !trusted) throw new ValidationError("HTTP endpoints require explicit deployment trust.");
  return url;
}

/** Pins a validated DNS answer into the socket lookup. Redirects can never forward an Authorization header. */
export function guardedFetch(origin: string, trustedOrigins: string[], maxResponseBytes?: number): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || url.username || url.password) throw new Error("Endpoint origin changed; credential forwarding refused.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const signal = AbortSignal.any([init?.signal ?? AbortSignal.timeout(10_000), AbortSignal.timeout(10_000)]);
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await new Promise<Awaited<ReturnType<typeof dns.lookup>>[]>((resolve, reject) => {
      const abort = () => reject(new Error("Endpoint DNS resolution timed out or was cancelled."));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      void dns.lookup(host, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    if (!addresses.length || (!trustedOrigins.includes(origin) && addresses.some((a) => !isPublicAddress(a.address)))) throw new Error("Endpoint resolved to a non-public address without explicit deployment trust.");
    const selected = addresses[0]!;
    const agent = new Agent({ connect: { lookup: (_host, options, callback) => {
      if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
      else callback(null, selected.address, selected.family);
    } }, headersTimeout: 15_000, bodyTimeout: 60_000 });
    try {
      const response = await undiciFetch(url, { ...init, body: init?.body as never, signal: init?.signal ?? undefined, redirect: "manual", dispatcher: agent });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("Endpoint redirects are refused. Configure the final trusted endpoint."); }
      // Closing a dispatcher waits for outstanding response bodies; callers can still stream normally.
      void agent.close().catch(() => undefined);
      if (maxResponseBytes && response.body) {
        let size = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > maxResponseBytes) throw new Error("Endpoint response exceeds the configured bound."); controller.enqueue(chunk); } }));
        return new Response(body as never, { status: response.status, headers: response.headers as never });
      }
      return response as unknown as Response;
    } catch (error) { await agent.destroy(); throw error; }
  };
}
export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1_048_576) throw new Error("Catalog exceeds response limit"); chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}
export type CheckHttp = (url: string, init: RequestInit) => Promise<Response>;

/** No generation, tools, CLI query, package installation, or provider work occurs here. */
export async function checkConnection(request: ConnectionTestRequest, credential: string | undefined, localPresent: boolean, http: CheckHttp, clock = () => new Date().toISOString()): Promise<ConnectionTestResult> {
  const base: ConnectionTestResult = { status: "unverified", checkedAt: clock(), check: "Credential source", authentication: "not_tested", modelAccess: "not_tested", ...(request.model ? { model: request.model } : {}), models: [], message: "" };
  if (!request.config.enabled) return { ...base, status: "failed", message: "Enable this connection before testing it." };
  if (request.config.auth === "local_login" || request.config.auth === "deployment") return { ...base, status: localPresent || request.config.auth === "deployment" ? "unverified" : "failed", message: request.config.auth === "deployment" ? "Deployment authentication is selected. The SDK owns this flow; no safe account/model probe is available. Authentication and model access remain unverified." : localPresent ? "A local login source is present. Its validity and model entitlement cannot be checked without a provider session. No session or generation was started." : "No local login file was detected. Sign in on the server using the configured SDK home. OS-keychain logins may not expose a detectable file; authentication remains unverified." };
  if (request.config.auth === "api_key" && !credential) return { ...base, status: "failed", message: "Enter a credential or configure a deployment credential before testing." };
  const anthropic = request.connection === "claude" || request.connection === "anthropic";
  const gateway = request.connection === "gateway";
  const root = request.config.endpoint.replace(/\/$/, "");
  const url = gateway ? `${new URL(root).origin}/v1/models` : `${root}${anthropic && !root.endsWith("/v1") ? "/v1" : ""}/models`;
  // Gateway's model listing is public; never send a key or report this as authentication.
  const headers: Record<string, string> = gateway || request.config.auth === "none" ? {} : anthropic ? { "x-api-key": credential!, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential!}` };
  const signal = AbortSignal.timeout(12_000);
  try {
    const response = await http(url, { method: "GET", headers, signal });
    const check = gateway ? "Public model catalog (no authentication)" : "GET models (non-generating request)";
    if (!response.ok) {
      await response.body?.cancel();
      const authFailure = response.status === 401 || response.status === 403;
      return { ...base, check, status: "failed", authentication: authFailure ? "failed" : "not_tested", message: authFailure ? "The provider refused these credentials. Check the key, account, and endpoint." : response.status === 404 || response.status === 405 ? "This endpoint does not support model discovery. Configure model ids manually; authentication and generation access remain unverified." : response.status === 429 ? "The provider rate-limited the check. Wait and retry." : "The provider could not complete the check. Check its service status and endpoint." };
    }
    const payload = await boundedJson(response) as { data?: { id?: unknown }[] };
    if (!Array.isArray(payload.data)) throw new Error("Invalid catalog");
    const models = [...new Set(payload.data.map((m) => m.id).filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v) && (!credential || !v.includes(credential))))].slice(0, 500);
    const model = request.model?.replace(/^pi\//, "").replace(/^(openai|anthropic|gateway)\//, "");
    const visible = model !== undefined && models.includes(model);
    const native = new URL(root).origin === (anthropic ? "https://api.anthropic.com" : "https://api.openai.com");
    let publicCatalog = gateway;
    if (!native && !gateway && request.config.auth === "api_key") {
      const anonymous = await http(url, { method: "GET", headers: anthropic ? { "anthropic-version": "2023-06-01" } : {}, signal });
      publicCatalog = anonymous.status !== 401 && anonymous.status !== 403;
      await anonymous.body?.cancel();
    }
    const authentication = publicCatalog ? "not_tested" : request.config.auth === "none" ? "not_required" : "verified";
    return { ...base, check, models, authentication, modelAccess: model === undefined ? "not_tested" : visible ? "visible" : "not_visible", status: !publicCatalog && visible ? "verified" : "unverified", message: publicCatalog ? "The model catalog is reachable without proving authentication. This does not authenticate the key or prove account access. No generation was requested." : visible ? "The connection responded and the selected model is listed. This verifies catalog visibility, not generation entitlement or tool support. No generation was requested." : model === undefined ? "The connection responded. Choose a model and test again to check catalog visibility." : "The connection responded, but the selected model was not in this bounded catalog. Check the model id and account access; manually configured models can still be saved." };
  } catch { return { ...base, status: "failed", check: "Bounded model catalog request", message: signal.aborted ? "The connection check timed out after 12 seconds." : "The endpoint could not be checked. Verify DNS, TLS, endpoint trust, and model-list support. Redirects and oversized or invalid responses are refused." }; }
}
