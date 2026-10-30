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

/**
 * Answers `GET /healthz/owner` for an authenticated request. A fresh object (a new unique id,
 * as each transaction gets its own) reports the version it runs; it holds no transaction and
 * stores nothing.
 */
export const ownerVersionRoute = async (request: Request, env: VersionBindings & { TRANSACTION_OWNER?: DurableObjectNamespace }) => {
  if (request.method !== "GET") return json({ error: { code: "POLICYSQL_NOT_FOUND", message: "Not found." } }, 404);
  const namespace = env.TRANSACTION_OWNER;
  let owner = UNKNOWN;
  if (namespace && typeof namespace.newUniqueId === "function") {
    try {
      const reply = await namespace.get(namespace.newUniqueId()).fetch(OWNER_PROBE_URL, { method: "GET" });
      const body = await reply.json() as { version?: unknown };
      owner = typeof body?.version === "string" ? body.version : UNKNOWN;
    } catch { owner = UNKNOWN; }
  }
  return json({ worker: deploymentVersion(env), owner });
};

/** Object side: true for the probe message, which never reaches the transaction owner core. */
export const isOwnerVersionProbe = (request: Request): boolean =>
  request.method === "GET" && new URL(request.url).href === OWNER_PROBE_URL;

export const ownerVersionReply = (env: VersionBindings) => json({ version: deploymentVersion(env) });
