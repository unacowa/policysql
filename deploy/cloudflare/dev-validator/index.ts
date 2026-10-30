// Development-only commit-check validator for the release smoke (#42). Not part of the
// library or of the reference wrapper; scripts/provision-dev.mjs deploys it as its own Worker
// next to the development deployment and points the dev policy's `smoke_check` at it.
//
// It follows the validator side of the hook protocol (website/sql/commit-checks.md):
// it checks the hook version, timestamp and HMAC signature, accepts a callback URL only on
// the configured PolicySQL origin, runs one callback SELECT through PolicySQL on the
// validating transaction, and decides from what that SELECT returns:
//   newest smoke_checks row verdict `allow`   -> allowed
//   newest smoke_checks row verdict `deny`    -> denied (SMOKE_DENIED)
//   newest smoke_checks row verdict `timeout` -> answers only after the hook deadline
//   no row, or the callback failed             -> denied
// The row is the uncommitted one the transaction under validation inserted, so an `allow`
// also proves the callback query ran on that transaction. Probe ids increase with time
// (`ccp_<ms>_<n>`), so the newest row is always the current transaction's.
// It never logs the capability token, the signature, or the secret.
import { fetchNoFollow } from "../src/redirects.ts";

type Env = {
  /** HMAC-SHA256 key shared with the PolicySQL Worker (`SMOKE_VALIDATOR_HMAC_SECRET` there). */
  HOOK_SECRET?: string;
  /** The PolicySQL Worker's origin; the only origin a callback may go to. */
  POLICYSQL_ORIGIN?: string;
  CF_VERSION_METADATA?: { id?: unknown };
};

const VERSION_HEADER = "policysql-deployment-version";
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 65_536;
// Longer than any hook deadline (policy `timeout_ms` is at most 1500), so `timeout` always
// expires the check before this validator answers.
const TIMEOUT_DELAY_MS = 3_000;
// Below the hook deadline (`timeout_ms: 1500`, the policy maximum), so a slow callback is
// reported here as CALLBACK_FAILED (`callback_failed` with `TimeoutError` in the log) instead of
// looking like an expired hook. The logs record `elapsedMs` (hook receipt to decision) and
// `callbackMs`, the allow path's margin against that deadline.
const CALLBACK_TIMEOUT_MS = 1_000;
const CALLBACK_PATH = /^\/v1\/commit-checks\/cval_[a-f0-9]{32}\/query$/u;
const CALLBACK_SQL = "SELECT id, verdict FROM smoke_checks ORDER BY id DESC LIMIT :limit";

const version = (env: Env) => {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" ? id : "unknown";
};

const reply = (env: Env, value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", [VERSION_HEADER]: version(env) },
});

const decision = (env: Env, allowed: boolean, code?: string) =>
  reply(env, allowed ? { version: "1", allowed: true } : { version: "1", allowed: false, error: { code } });

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu) as string[], (pair) => Number.parseInt(pair, 16));
};

const signatureValid = async (secret: string, timestamp: string, body: string, header: string | null) => {
  const signature = header?.startsWith("v1=") ? hexBytes(header.slice(3)) : null;
  if (!signature || signature.length !== 32) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // A constant-time comparison.
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${timestamp}.${body}`));
};

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ event: "smoke_validator", ...event }));

const check = async (request: Request, env: Env): Promise<Response> => {
  const received = Date.now();
  const secret = env.HOOK_SECRET ?? "";
  const origin = env.POLICYSQL_ORIGIN ?? "";
  if (secret.length < 16 || !origin.startsWith("https://")) return reply(env, { error: "misconfigured" }, 500);
  if (request.headers.get("policysql-hook-version") !== "1") return reply(env, { error: "version" }, 400);
  const timestamp = request.headers.get("policysql-hook-timestamp") ?? "";
  if (!/^[0-9]{1,12}$/u.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return reply(env, { error: "timestamp" }, 401);
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return reply(env, { error: "size" }, 413);
  if (!await signatureValid(secret, timestamp, body, request.headers.get("policysql-hook-signature"))) {
    return reply(env, { error: "signature" }, 401);
  }
  let payload: any;
  try { payload = JSON.parse(body); } catch { return reply(env, { error: "json" }, 400); }
  if (payload?.version !== "1" || payload?.check !== "smoke_check") return decision(env, false, "UNKNOWN_CHECK");
  let callback: URL;
  try { callback = new URL(payload.query?.url); } catch { return decision(env, false, "CALLBACK_URL"); }
  if (callback.origin !== new URL(origin).origin || !CALLBACK_PATH.test(callback.pathname) || callback.search !== "") {
    return decision(env, false, "CALLBACK_URL");
  }
  const token = payload.query?.token;
  if (typeof token !== "string" || token === "") return decision(env, false, "CALLBACK_TOKEN");

  let verdict: unknown = null;
  const callbackStarted = Date.now();
  try {
    const response = await fetchNoFollow(callback, {
      method: "POST",
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sequence: 1, sql: CALLBACK_SQL, params: { limit: 1 } }),
    });
    const result = await response.json() as any;
    if (!response.ok) {
      log({ validationId: payload.validationId, outcome: "callback_rejected", status: response.status, code: result?.error?.code ?? null, callbackMs: Date.now() - callbackStarted });
      return decision(env, false, "CALLBACK_FAILED");
    }
    verdict = result?.rows?.[0]?.verdict ?? null;
  } catch (error) {
    log({ validationId: payload.validationId, outcome: "callback_failed", errorClass: (error as Error)?.name ?? "Error", callbackMs: Date.now() - callbackStarted });
    return decision(env, false, "CALLBACK_FAILED");
  }
  log({ validationId: payload.validationId, outcome: "decided", verdict, callbackMs: Date.now() - callbackStarted, elapsedMs: Date.now() - received });
  if (verdict === "allow") return decision(env, true);
  if (verdict === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_DELAY_MS));
    return decision(env, true);
  }
  return decision(env, false, verdict === "deny" ? "SMOKE_DENIED" : "NO_PROBE");
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" && request.method === "GET") return reply(env, { ready: true });
    if (pathname === "/check" && request.method === "POST") return check(request, env);
    return reply(env, { error: "not_found" }, 404);
  },
};
