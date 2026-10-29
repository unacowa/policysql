import type { PolicySqlRuntime } from "../pkg/policysql_wasm.js";

/**
 * The trusted session a wrapper passes per request after it has authenticated the caller
 * (ADR 0005, ADR 0019). The library never sees a credential; core validates this value.
 */
export type TrustedSession = {
  /** Opaque, wrapper-namespaced stable identity, for example `issuer:subject`. */
  principal: string;
  /** Becomes the reserved `subject_id` session value. */
  subject: string;
  roles: string[];
  defaultRole: string;
  access: Array<"catalog" | "explain" | "execute" | "debug">;
  /** Extra server-owned session values. `subject_id` and `role` are reserved. */
  session: Record<string, string>;
};

/** Per-request input to `app.fetch`, supplied by the wrapper. */
export type RequestContext = {
  database: import("./database.ts").DatabaseBinding;
  /**
   * Required by every authenticated route; a missing or malformed session there fails
   * with 500 before any body read, owner lookup, or database work. Routes that need no
   * authentication (`/healthz`) do not read it.
   */
  session?: TrustedSession;
  /** Correlation ID for logs and error bodies. Defaults to `cf-ray` or a fresh UUID. */
  requestId?: string;
};

/** Canonical result of core's session validation and role selection. */
export type AuthContext = {
  principal: string;
  subject: string;
  role: string;
  roles: string[];
  access: string[];
  session: Record<string, string>;
};

/**
 * The platform bindings `app.fetch` and `app.fetchCallback` still take. Deployment settings
 * are not here: they are the explicit `PolicySqlConfig` (ADR 0021). A wrapper may pass its
 * whole Workers `env`; the library reads only `TRANSACTION_OWNER`.
 *
 * `TRANSACTION_OWNER` is the one remaining platform read, kept until the `TransactionOwner`
 * port replaces the Durable Object namespace (#31).
 */
export type PlatformBindings = {
  TRANSACTION_OWNER: DurableObjectNamespace;
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
  // Hono bindings built by `app.fetch` itself; never the platform `env` object.
  Bindings: {
    transactionOwner?: DurableObjectNamespace;
    databaseBinding?: import("./database.ts").DatabaseBinding;
    /** The wrapper's trusted session, unvalidated until the authorization middleware runs. */
    session?: unknown;
    requestId?: string;
    /** Set only by `fetchCallback`; the commit-check route is not served through `fetch`. */
    callback?: true;
  };
  Variables: AppVariables;
};

export type AppDependencies = {
  getRuntime: () => PolicySqlRuntime;
  database: import("./database.ts").DatabaseProvider;
  /** Deployment settings, validated at construction (ADR 0021). */
  config: import("./engine-config.ts").PolicySqlConfig;
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

/** `AppDependencies` after `createApp` validated them; routes see only this form. */
export type EngineDependencies = Omit<AppDependencies, "config"> & {
  config: import("./engine-config.ts").ValidatedConfig;
};
