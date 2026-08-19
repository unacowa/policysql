import { HttpError } from "./errors.ts";
import { sha256 } from "./idempotency.ts";

const rejected = () => new HttpError(
  409,
  "POLICYSQL_COMMIT_CHECK_REJECTED",
  "A commit check rejected the transaction.",
);

const base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const opaqueToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const signature = async (secret, timestamp, body) => {
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

const secureUrl = (raw) => {
  let url;
  try { url = new URL(raw); } catch { throw rejected(); }
  if (url.protocol !== "https:" || url.username || url.password) throw rejected();
  return url;
};

const exactDecision = (value) => {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (!Object.keys(value).every((key) => ["version", "allowed", "error"].includes(key))) return false;
  if (value.version !== "1" || typeof value.allowed !== "boolean") return false;
  if (value.error !== undefined && (
    !value.error || Array.isArray(value.error) || typeof value.error !== "object" ||
    Object.keys(value.error).length !== 1 || typeof value.error.code !== "string"
  )) return false;
  return true;
};

export const triggeredCommitChecks = (compiled, results) => {
  const changed = compiled.statements.flatMap((statement, index) =>
    statement.operation !== "select" && (results[index]?.affectedRows ?? 0) > 0 && statement.resource
      ? [{ index, type: statement.operation, resource: statement.resource }]
      : [],
  );
  const resources = new Set(changed.map((statement) => statement.resource));
  const checks = (compiled.commitChecks ?? [])
    .filter((check) => check.triggeredBy.some((resource) => resources.has(resource)))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { changed, checks };
};

export const runCommitChecks = async ({
  compiled,
  results,
  auth,
  env,
  requestId,
  validationId,
  activate,
  deactivate,
  fetchImpl = fetch,
  deadlineMs = Number.POSITIVE_INFINITY,
}) => {
  const { changed, checks } = triggeredCommitChecks(compiled, results);
  if (checks.length === 0) return "not_triggered";
  const publicBase = secureUrl(env.POLICYSQL_PUBLIC_BASE_URL);
  for (const check of checks) {
    const url = secureUrl(env[check.urlEnv]);
    const secret = env[check.hmacSecretEnv];
    if (typeof secret !== "string" || secret.length < 16) throw rejected();
    const token = opaqueToken();
    const expiresAtMs = Math.min(Date.now() + check.timeoutMs, deadlineMs);
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) throw rejected();
    const callbackRole = check.role ?? auth.role;
    const callbackAuth = {
      ...auth,
      role: callbackRole,
      roles: [...new Set([...(auth.roles ?? []), callbackRole])],
      access: ["execute"],
    };
    await activate({
      validationId,
      tokenHash: await sha256(token),
      expiresAtMs,
      nextSequence: 1,
      last: null,
      rowsReturned: 0,
      resultBytes: 0,
      auth: callbackAuth,
      check: check.id,
    });
    const queryUrl = new URL(`/v1/commit-checks/${validationId}/query`, publicBase).toString();
    const body = JSON.stringify({
      version: "1",
      validationId,
      check: check.id,
      requestId,
      policyVersion: compiled.policyVersion,
      schemaVersion: compiled.schemaVersion,
      role: callbackRole,
      session: callbackAuth.session,
      statements: changed,
      query: { token, url: queryUrl, expiresAt: new Date(expiresAtMs).toISOString() },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(remainingMs),
        headers: {
          "content-type": "application/json",
          "policysql-hook-version": "1",
          "policysql-hook-timestamp": timestamp,
          "policysql-hook-signature": await signature(secret, timestamp, body),
        },
        body,
      });
    } catch {
      await deactivate();
      throw rejected();
    }
    let decision;
    try { decision = await response.json(); } catch { decision = null; }
    await deactivate();
    if (!response.ok || !exactDecision(decision) || !decision.allowed) throw rejected();
  }
  return "passed";
};

export const verifyCapabilityToken = async (authorization, session) => {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (!token || !session || Date.now() >= session.expiresAtMs) return false;
  const actual = await sha256(token);
  if (actual.length !== session.tokenHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ session.tokenHash.charCodeAt(index);
  }
  return difference === 0;
};
