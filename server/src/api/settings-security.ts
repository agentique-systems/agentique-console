import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { ApiError } from "./errors.ts";

const loopback = (value: string) => value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
/** The existing local operator trust model, with an explicit bearer-token mode for remote administration. No forwarded-header trust. */
export function authorizeSettings(request: FastifyRequest, config: Config): void {
  const policy = config.administration;
  const peer = request.ip;
  const host = request.headers.host ?? "";
  let origin: string;
  try {
    const url = new URL(`http://${host}`);
    if (policy.origin ? url.host !== new URL(policy.origin).host : !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error();
    origin = policy.origin ?? `${request.protocol}://${host}`;
  } catch { throw new ApiError("forbidden", "Settings access requires a trusted application host."); }
  if (policy.token) {
    const value = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const a = Buffer.from(value), b = Buffer.from(policy.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError("forbidden", "Enter the deployment administration token to open Settings.");
    if (!loopback(peer) && (!policy.origin || !policy.origin.startsWith("https://"))) throw new ApiError("forbidden", "Remote administration requires a configured HTTPS public origin and an authenticated deployment.");
  } else if (!loopback(peer)) throw new ApiError("forbidden", "Settings are available only to the local operator. Configure an administration token and public origin for remote access.");
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new ApiError("forbidden", "The request origin is not the configured application origin.");
  if (["cross-site", "same-site"].includes(String(request.headers["sec-fetch-site"] ?? ""))) throw new ApiError("forbidden", "Cross-origin Settings access is refused.");
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers["x-console-settings"] !== "1") throw new ApiError("forbidden", "Settings changes require the application request header.");
}
