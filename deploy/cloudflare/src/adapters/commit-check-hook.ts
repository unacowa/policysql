// Outbound adapter for the commit-check validator call (ADR 0007, ADR 0019): one signed HTTP
// request per triggered check. It makes no decision. Core's step machine issues the capability,
// builds the payload, and judges the reply; the owner (src/transaction-owner.ts) chooses the
// endpoint by check id.
import { discardBody, fetchNoFollow } from "../redirects.ts";
import { BodyReadError, readBoundedText } from "../bounded-body.ts";
import type { OutboundFetch } from "../redirects.ts";
import { callbackQueryUrl } from "../http/routes.ts";
import { stringifyExact } from "../exact-json.ts";

// A validator answers allow or deny with a small JSON object, so its reply bound is a fixed
// protocol constant, not a configured limit (ADR 0027 "Fixed protocol constants"). A longer
// reply is a failed validator: the commit is denied, never allowed.
const VALIDATOR_RESPONSE_BYTES = 65_536;

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
 * fetchNoFollow discards unread because following it would forward the signed body, and when
 * the reply is longer than 65,536 bytes (read as a byte stream and cancelled at the first
 * chunk over the bound, so a hostile validator cannot make the engine buffer it).
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
  const signal = AbortSignal.timeout(call.timeoutMs);
  const response = await fetchNoFollow(call.url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "policysql-hook-version": "1",
      "policysql-hook-timestamp": timestamp,
      "policysql-hook-signature": await signature(call.hmacSecret, timestamp, body),
    },
    body,
  }, call.fetchImpl);
  if (!response.ok) {
    await discardBody(response);
    return { ok: false, decision: null };
  }
  // BodyTooLargeError and an abort propagate: the validator failed. Malformed UTF-8 or JSON
  // is an answer that is not a decision.
  let text: string;
  try { text = await readBoundedText(response, VALIDATOR_RESPONSE_BYTES, signal); } catch (error) {
    if (error instanceof BodyReadError) return { ok: true, decision: null };
    throw error;
  }
  let decision: unknown;
  try { decision = JSON.parse(text); } catch { decision = null; }
  return { ok: true, decision };
};
