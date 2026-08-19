import { HttpError } from "./errors.ts";

export const enforceRateLimit = async (env, auth, endpoint, request = undefined) => {
  if (!env.POLICYSQL_RATE_LIMITER?.limit) {
    throw new HttpError(503, "POLICYSQL_RATE_LIMIT_UNAVAILABLE", "Rate limiting is temporarily unavailable.");
  }
  const tenant = auth.session?.tenant_id ?? "no_tenant";
  const ip = request?.headers.get("cf-connecting-ip") ?? "unknown_ip";
  const material = `${env.POLICYSQL_JWT_ISSUER ?? "unknown_issuer"}:${ip}:${auth.subject}:${auth.role}:${tenant}:${endpoint}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const { success } = await env.POLICYSQL_RATE_LIMITER.limit({
    key,
  });
  if (!success) {
    throw new HttpError(429, "POLICYSQL_RATE_LIMITED", "Too many requests.");
  }
};
