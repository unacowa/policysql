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
  TRANSACTION_OWNER: DurableObjectNamespace;
  [key: string]: unknown;
};

export type ExecutionTraceParameter = {
  name: string;
  source: "client" | "server";
  value: "[redacted]";
};

export type ExecutionTraceStatement = {
  index: number;
  operation: "select" | "insert" | "update" | "delete";
  resource?: string;
  inputSql: string;
  executedSql: string;
  parameters: ExecutionTraceParameter[];
};

export type ExecutionTrace = {
  source: "turso-egress";
  requestId: string;
  disposition: "executed" | "idempotency_replay";
  attempt: 1;
  statements: ExecutionTraceStatement[];
};

export type ExecutionTraceSink = (trace: ExecutionTrace) => void | Promise<void>;

export type AppVariables = {
  requestId: string;
  runtime: PolicySqlRuntime;
  auth: AuthContext;
};

export type AppEnv = {
  Bindings: { deployment: WorkerBindings; databaseBinding?: import("./database.ts").DatabaseBinding };
  Variables: AppVariables;
};

export type AppDependencies = {
  getRuntime: () => PolicySqlRuntime;
  database: import("./database.ts").DatabaseProvider;
  executionTrace?: {
    enabled: boolean;
    sink?: ExecutionTraceSink;
  };
  publicConfig?: {
    schemaVersion: string;
    policyVersion: string;
    limits: Record<string, number>;
  };
};
