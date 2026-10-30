// Deployment-owned configuration (ADR 0021). Not part of the published library.
// These env names are this wrapper's convention, kept from earlier releases so existing
// deployments keep working; the library reads none of them and takes `PolicySqlConfig`.
import type { CommitCheckEndpoint, PolicySqlConfig } from "../src/engine-config.ts";

export type WrapperBindings = {
  /** The Durable Object namespace this wrapper routes transaction owners to (wrangler.jsonc). */
  TRANSACTION_OWNER?: DurableObjectNamespace;
  POLICYSQL_ENVIRONMENT?: string;
  POLICYSQL_PUBLIC_BASE_URL?: string;
  POLICYSQL_COST_CATALOG_JSON?: string;
  APPLICATION_DATABASE_ID?: string;
  APPLICATION_DATABASE_GENERATION?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  [key: string]: unknown;
};

/**
 * Policy commit-check id -> the env names holding its validator URL and HMAC secret, one
 * entry per check id the policy defines. Both are required: a missing value rejects the
 * whole configuration (500 before any database, owner, or validator call).
 * The development policy's only check is `smoke_check`, answered by the dev validator Worker
 * (dev-validator/, #42); the release smoke drives it.
 */
export const COMMIT_CHECK_ENV: Readonly<Record<string, Readonly<{ url: string; hmacSecret: string }>>> = Object.freeze({
  smoke_check: Object.freeze({ url: "SMOKE_VALIDATOR_URL", hmacSecret: "SMOKE_VALIDATOR_HMAC_SECRET" }),
});

const text = (env: WrapperBindings, name: string) => {
  const value = env[name];
  return typeof value === "string" ? value : "";
};

const json = (value: string, name: string) => {
  if (value === "") return undefined;
  try { return JSON.parse(value); } catch { throw new TypeError(`${name} is not valid JSON`); }
};

/**
 * Builds the library configuration from env. Missing values become "", which the library
 * rejects for that setting (500 before any database, Durable Object, or validator call).
 */
export const configFromEnv = (
  env: WrapperBindings,
  commitCheckEnv: typeof COMMIT_CHECK_ENV = COMMIT_CHECK_ENV,
): PolicySqlConfig => {
  const commitChecks: Record<string, CommitCheckEndpoint> = {};
  for (const [id, names] of Object.entries(commitCheckEnv)) {
    commitChecks[id] = { url: text(env, names.url), hmacSecret: text(env, names.hmacSecret) };
  }
  const publicBaseUrl = text(env, "POLICYSQL_PUBLIC_BASE_URL");
  return {
    environment: text(env, "POLICYSQL_ENVIRONMENT"),
    ...(publicBaseUrl === "" ? {} : { publicBaseUrl }),
    costCatalog: json(text(env, "POLICYSQL_COST_CATALOG_JSON"), "POLICYSQL_COST_CATALOG_JSON"),
    commitChecks,
  };
};
