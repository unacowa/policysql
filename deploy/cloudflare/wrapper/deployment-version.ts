// Deployment-owned release identification (#42). Not part of the published library: the
// library reads no platform binding, and the version id is a fact of this Cloudflare
// deployment, not of PolicySQL.
//
// Cloudflare's version metadata binding (`version_metadata` in wrangler.jsonc) gives the id of
// the Worker version that runs the code. The wrapper reports it
// - in the `policysql-deployment-version` header of every response, so a caller can tell
//   which version answered, and
// - on `GET /healthz/owner` (authenticated) together with the version of a Durable Object
//   the request reached, so a caller can tell that transaction owners run it too.
// scripts/provision-dev.mjs waits for consecutive answers that all name the version it just
// deployed before the release smoke starts, and fails the smoke on any other version.
import { createErrorResponse } from "../src/http/responses.ts";
import type { TrustedSession } from "../src/types.ts";
import type { FetchHandler } from "./rate-limit.ts";

export const DEPLOYMENT_VERSION_HEADER = "policysql-deployment-version";
/** Authenticated wrapper route: the Worker's and a fresh Durable Object's version ids. */
export const OWNER_VERSION_PATH = "/healthz/owner";
// The internal message the Worker sends to the object. No owner command uses this path.
const OWNER_PROBE_URL = "https://owner/deployment-version";
const UNKNOWN = "unknown";

export type VersionBindings = { CF_VERSION_METADATA?: { id?: unknown } };

/** The version id of the running code, or "unknown" without the binding. */
export const deploymentVersion = (env: VersionBindings | undefined): string => {
  const id = env?.CF_VERSION_METADATA?.id;
  return typeof id === "string" && /^[0-9a-f-]{1,64}$/u.test(id) ? id : UNKNOWN;
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
});

/** Adds the version header to every response of `handler`. */
export const withDeploymentVersion = (handler: FetchHandler): FetchHandler => async (request, env, context) => {
  const response = await handler(request, env, context);
  const tagged = new Response(response.body, response);
  tagged.headers.set(DEPLOYMENT_VERSION_HEADER, deploymentVersion(env as VersionBindings));
  return tagged;
};

/** The access a session needs for `/healthz/owner`: the one transaction endpoints require. */
export const OWNER_VERSION_ACCESS = "execute";

/**
 * Answers `GET /healthz/owner` for an authenticated request whose session has `execute`
 * access, the access that lets it start a transaction and so create an owner anyway; any
 * other session gets 403 before an object is created. A fresh object (a new unique id, as
 * each transaction gets its own) reports the version it runs; it holds no transaction and
 * stores nothing. When the probe fails, `owner` is "unknown" and `ownerError` says why.
 */
export const ownerVersionRoute = async (
  request: Request,
  env: VersionBindings & { TRANSACTION_OWNER?: DurableObjectNamespace },
  session: TrustedSession | undefined,
  requestId: string,
) => {
  if (request.method !== "GET") return createErrorResponse(404, "POLICYSQL_NOT_FOUND", "The resource was not found.", { requestId });
  const access = (session as { access?: unknown } | undefined)?.access;
  if (!Array.isArray(access) || !access.includes(OWNER_VERSION_ACCESS)) {
    return createErrorResponse(403, "POLICYSQL_FORBIDDEN_ACCESS", "The session cannot perform this operation.", { requestId });
  }
  const namespace = env.TRANSACTION_OWNER;
  let owner = UNKNOWN;
  let ownerError: string | null = null;
  if (!namespace || typeof namespace.newUniqueId !== "function") {
    ownerError = "no_owner_namespace";
  } else {
    try {
      const reply = await namespace.get(namespace.newUniqueId()).fetch(OWNER_PROBE_URL, { method: "GET" });
      let body: { version?: unknown } | null = null;
      try { body = await reply.json() as { version?: unknown }; } catch { body = null; }
      if (!reply.ok) ownerError = `owner_status_${reply.status}`;
      else if (typeof body?.version !== "string") ownerError = "owner_reply_without_version";
      else owner = body.version;
    } catch (error) {
      ownerError = `owner_unreachable_${(error as Error)?.name ?? "Error"}`;
    }
  }
  return json({ worker: deploymentVersion(env), owner, ...(ownerError ? { ownerError } : {}) });
};

/** Object side: true for the probe message, which never reaches the transaction owner core. */
export const isOwnerVersionProbe = (request: Request): boolean =>
  request.method === "GET" && new URL(request.url).href === OWNER_PROBE_URL;

export const ownerVersionReply = (env: VersionBindings) => json({ version: deploymentVersion(env) });

type OwnerClass = new (...args: any[]) => { fetch(request: Request): Promise<Response> };

/**
 * The wrapper's TransactionOwner class: the library's Durable Object class plus the version
 * probe. Every message except the exact probe goes to the library's `fetch`.
 */
export const withOwnerVersionProbe = <Base extends OwnerClass>(Library: Base) => {
  class Probed extends Library {
    versionEnv: VersionBindings;
    constructor(...args: any[]) {
      super(args[0], args[1]);
      this.versionEnv = { CF_VERSION_METADATA: (args[1] as VersionBindings | undefined)?.CF_VERSION_METADATA };
    }
    fetch(request: Request): Promise<Response> {
      return isOwnerVersionProbe(request) ? Promise.resolve(ownerVersionReply(this.versionEnv)) : super.fetch(request);
    }
  }
  return Probed;
};
