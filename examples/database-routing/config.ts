import type { PolicySqlConfig } from "@unacowa/policysql/cloudflare";

// Application-owned: this wrapper's env names for the library's `PolicySqlConfig`
// (ADR 0021). The library reads none of these names; they are this example's convention.

export type ConfigEnv = {
  POLICYSQL_ENVIRONMENT?: string;
  POLICYSQL_PUBLIC_BASE_URL?: string;
  POLICYSQL_COST_CATALOG_JSON?: string;
  VALIDATOR_URL?: string;
  VALIDATOR_SECRET?: string;
};

const json = (text: string | undefined, name: string) => {
  if (text === undefined || text === "") return undefined;
  try { return JSON.parse(text); } catch { throw new TypeError(`${name} is not valid JSON`); }
};

/**
 * Builds the configuration from env. The library validates it once, before any database,
 * Durable Object, or validator call; an invalid or missing required value is a 500
 * `POLICYSQL_INTERNAL` with a `deployment_config_rejected` log naming only the setting.
 * `policy.yaml` defines the `consistency` commit check, so its endpoint is required here.
 */
// A missing value becomes "", which the library rejects for that setting.
export const configFromEnv = (env: ConfigEnv): PolicySqlConfig => ({
  environment: env.POLICYSQL_ENVIRONMENT ?? "",
  publicBaseUrl: env.POLICYSQL_PUBLIC_BASE_URL,
  costCatalog: json(env.POLICYSQL_COST_CATALOG_JSON, "POLICYSQL_COST_CATALOG_JSON"),
  commitChecks: {
    consistency: { url: env.VALIDATOR_URL ?? "", hmacSecret: env.VALIDATOR_SECRET ?? "" },
  },
});
