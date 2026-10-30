// Outbound adapter for the commit-check validator call (ADR 0007, ADR 0019): one signed HTTP
// request per triggered check. It makes no decision. The engine (src/commit-checks.ts)
// chooses the endpoint, issues the capability, and judges the reply.
import { fetchNoFollow } from "../redirects.ts";
import type { OutboundFetch } from "../redirects.ts";
import { callbackQueryUrl } from "../http/routes.ts";
import { stringifyExact } from "../exact-json.ts";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const signature = async (secret: string, timestamp: string, body: string) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `v1=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)))}`;
};

export type CommitCheckHookCall = {
  /** The validator endpoint, already checked by the engine. */
  url: URL;
  hmacSecret: string;
  /** The deployment's public base URL; the callback URL is built under it. */
  publicBaseUrl: URL;
  validationId: string;
  /** The hook body without `query`, in its wire key order. */
  payload: Record<string, unknown>;
  /** The opaque capability for callback queries and its expiry. */
  capability: { token: string; expiresAtMs: number };
  timeoutMs: number;
  fetchImpl?: OutboundFetch;
};

/**
 * Sends the hook request. Resolves with whether the response was 2xx and its JSON body
 * (null when it is not JSON). Rejects when no response arrived, including a redirect, which
 * fetchNoFollow discards unread because following it would forward the signed body.
 */
export const callCommitCheckHook = async (call: CommitCheckHookCall): Promise<{ ok: boolean; decision: unknown }> => {
  // An integer beyond 2^53 - 1 in the payload (a session value core kept) is written with its
  // digits, not rounded (ADR 0024 pull request 5 obligation).
  const body = stringifyExact({
    ...call.payload,
    query: {
      token: call.capability.token,
      url: callbackQueryUrl(call.publicBaseUrl, call.validationId),
      expiresAt: new Date(call.capability.expiresAtMs).toISOString(),
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await fetchNoFollow(call.url, {
    method: "POST",
    signal: AbortSignal.timeout(call.timeoutMs),
    headers: {
      "content-type": "application/json",
      "policysql-hook-version": "1",
      "policysql-hook-timestamp": timestamp,
      "policysql-hook-signature": await signature(call.hmacSecret, timestamp, body),
    },
    body,
  }, call.fetchImpl);
  let decision: unknown;
  try { decision = await response.json(); } catch { decision = null; }
  return { ok: response.ok, decision };
};
