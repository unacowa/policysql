import type { PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";

export type AuthContext = {
  subject: string;
  role: string;
  access: string[];
  session: Record<string, string>;
  [key: string]: unknown;
};

export type WorkerBindings = {
  POLICYSQL_ENVIRONMENT?: string;
  POLICYSQL_JWKS_JSON?: string;
  POLICYSQL_JWKS_URL?: string;
  POLICYSQL_JWT_ISSUER?: string;
  POLICYSQL_JWT_AUDIENCE?: string;
  POLICYSQL_PUBLIC_BASE_URL?: string;
  POLICYSQL_COST_CATALOG_JSON?: string;
  POLICYSQL_IDEMPOTENCY_SECRET?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  POLICYSQL_RATE_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
  TRANSACTION_OWNER: DurableObjectNamespace;
  [key: string]: unknown;
};

export type AppVariables = {
  requestId: string;
  runtime: PolicySqlRuntime;
  auth: AuthContext;
};

export type AppEnv = {
  Bindings: WorkerBindings;
  Variables: AppVariables;
};

export type AppDependencies = {
  getRuntime: () => PolicySqlRuntime;
  transportFactory?: (...args: any[]) => any;
  costTransportFactory?: (...args: any[]) => any;
  publicConfig?: {
    schemaVersion: string;
    policyVersion: string;
    limits: Record<string, number>;
  };
};
