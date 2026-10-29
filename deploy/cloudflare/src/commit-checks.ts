import { EngineError } from "./errors.ts";
import { sha256 } from "./idempotency.ts";
import { callCommitCheckHook } from "./adapters/commit-check-hook.ts";
import type { OutboundFetch } from "./redirects.ts";
import type { ValidatedConfig } from "./engine-config.ts";

const rejected = () => new EngineError("POLICYSQL_COMMIT_CHECK_REJECTED",
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
  config,
  requestId,
  validationId,
  activate,
  deactivate,
  // Omitted: fetchNoFollow uses the host fetch.
  fetchImpl = undefined as OutboundFetch | undefined,
  deadlineMs = Number.POSITIVE_INFINITY,
}: {
  compiled: any;
  results: any;
  auth: any;
  /** Validated deployment configuration (ADR 0021); the validator endpoints live here. */
  config: ValidatedConfig;
  requestId: string;
  validationId: string;
  activate: (session: any) => Promise<unknown>;
  deactivate: () => Promise<unknown>;
  fetchImpl?: OutboundFetch;
  deadlineMs?: number;
}) => {
  const { changed, checks } = triggeredCommitChecks(compiled, results);
  if (checks.length === 0) return "not_triggered";
  // Resolve every triggered check before the first capability or hook, so a missing
  // endpoint rejects the commit without contacting any validator.
  const endpoints = checks.map((check) => {
    const endpoint = config?.commitCheck(check.id);
    if (endpoint === undefined || config.publicBaseUrl === undefined) {
      console.log(JSON.stringify({ event: "commit_check_unconfigured", requestId, check: check.id }));
      throw rejected();
    }
    return endpoint;
  });
  const publicBase = secureUrl(config.publicBaseUrl);
  for (const [index, check] of checks.entries()) {
    // Validated at construction; re-checked here because this is the outbound exit.
    const url = secureUrl(endpoints[index].url);
    const secret = endpoints[index].hmacSecret;
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
    let reply: { ok: boolean; decision: any };
    try {
      // The hook adapter never follows a redirect; a failed call revokes the capability
      // like any other failure.
      reply = await callCommitCheckHook({
        url,
        hmacSecret: secret,
        publicBaseUrl: publicBase,
        validationId,
        payload: {
          version: "1",
          validationId,
          check: check.id,
          requestId,
          policyVersion: compiled.policyVersion,
          schemaVersion: compiled.schemaVersion,
          role: callbackRole,
          session: callbackAuth.session,
          statements: changed,
        },
        capability: { token, expiresAtMs },
        timeoutMs: remainingMs,
        fetchImpl,
      });
    } catch {
      await deactivate();
      throw rejected();
    }
    await deactivate();
    if (!reply.ok || !exactDecision(reply.decision) || !reply.decision.allowed) throw rejected();
  }
  return "passed";
};

/** Checks a presented capability (the opaque token itself) against the active validation. */
export const verifyCapabilityToken = async (capability: unknown, session) => {
  const token = typeof capability === "string" && /^[A-Za-z0-9_-]{43}$/u.test(capability) ? capability : undefined;
  if (!token || !session || Date.now() >= session.expiresAtMs) return false;
  const actual = await sha256(token);
  if (actual.length !== session.tokenHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ session.tokenHash.charCodeAt(index);
  }
  return difference === 0;
};
