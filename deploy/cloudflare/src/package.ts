import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
// Wrangler turns an imported Wasm module into WebAssembly.Module; wasm-pack's generated
// declaration describes raw exports instead, so consumers need this bundler-specific override.
// @ts-ignore
import wasm from "../pkg/policysql_wasm_bg.wasm";
import { runtimeBytesLimit } from "./binary.ts";
import { createWorkerEntrypoints } from "./worker.ts";
import type { PolicySqlDeployment } from "./worker.ts";
import type { PlatformBindings } from "./types.ts";

export { createApp } from "./app.ts";
export type { PolicySqlApp } from "./app.ts";
export { TransactionOwnerCore } from "./transaction-owner.ts";
export type { PolicySqlDeployment, PolicySqlWorkerApp } from "./worker.ts";
export type { TransactionOwnerDependencies } from "./transaction-owner.ts";
// The deployment configuration contract, in one place (ADR 0021).
export { ConfigError, validateConfig } from "./engine-config.ts";
export type { CommitCheckEndpoint, CostCatalog, PolicySqlConfig } from "./engine-config.ts";
export { TursoHttpTransport } from "./turso-http.ts";
export { createErrorResponse } from "./errors.ts";
export type { ErrorResponseOptions } from "./errors.ts";
// Optional identity adapter for wrappers. The engine never imports it (ADR 0019).
export { createJwtSessionVerifier, JwtAuthenticationError } from "./adapters/jwt.ts";
export type { JwtSessionVerifierOptions } from "./adapters/jwt.ts";
export type {
  DatabaseBinding, DatabaseProvider, DatabaseTransport, DatabaseTransportOptions,
  DatabaseTransaction, DatabaseResult, DatabaseUsage,
} from "./database.ts";
export type {
  AppDependencies,
  AppEnv,
  AuthContext,
  RequestContext,
  TrustedSession,
  ExecutionTrace,
  ExecutionTraceParameter,
  ExecutionTraceSink,
  ExecutionTraceStatement,
  PlatformBindings,
} from "./types.ts";

export type RuntimeLimits = {
  maxRows: number;
  maxResultBytes: number;
  timeoutMs: number;
  maxStatements: number;
};

export type RuntimeConfiguration = {
  catalog: string;
  policy: string;
  physicalSchema: string | Record<string, unknown>;
  schemaVersion: string;
  policyVersion: string;
  limits: RuntimeLimits;
  developer?: {
    executionTrace?: boolean;
    executionTraceSink?: import("./types.ts").ExecutionTraceSink;
  };
};

let wasmInitialized = false;

/**
 * Creates an isolate-local, lazily initialized PolicySQL runtime factory.
 * Configuration belongs to the deployment; authorization and SQL compilation remain in Rust/Wasm.
 */
export const createRuntimeFactory = (configuration: RuntimeConfiguration) => {
  let runtime: PolicySqlRuntime | undefined;
  return () => {
    if (runtime) return runtime;
    if (!wasmInitialized) {
      initSync({ module: wasm });
      wasmInitialized = true;
    }
    const physicalSchema = typeof configuration.physicalSchema === "string"
      ? configuration.physicalSchema
      : JSON.stringify(configuration.physicalSchema);
    const candidate = PolicySqlRuntime.newWithPhysicalSchema(
      configuration.catalog,
      configuration.policy,
      configuration.schemaVersion,
      configuration.policyVersion,
      JSON.stringify({
        max_rows: configuration.limits.maxRows,
        max_result_bytes: configuration.limits.maxResultBytes,
        timeout_ms: configuration.limits.timeoutMs,
        max_statements: configuration.limits.maxStatements,
      }),
      physicalSchema,
    );
    // The adapter takes the per-value BLOB limit only from the runtime. Reject
    // malformed metadata at construction rather than on a request's BLOB path.
    try { runtimeBytesLimit(candidate); } catch (error) { candidate.free(); throw error; }
    runtime = candidate;
    return runtime;
  };
};

export type PolicySqlWorkerConfiguration<Env extends PlatformBindings = PlatformBindings> = RuntimeConfiguration & {
  /**
   * Wrapper-owned. Builds the database provider and `PolicySqlConfig` from the Workers
   * `env` (ADR 0021). Workers delivers `env` per request and to the Durable Object
   * constructor, not at module load, so the library calls this with the `env` it was
   * handed. The Worker calls it at most once per `env` object; a request that arrives with
   * a different `env` object rebuilds (and revalidates) the deployment for that object.
   * Each Durable Object instance calls it once, in its constructor. The Worker and a Durable
   * Object therefore share a configuration only if this is a pure function of the bindings.
   * The library itself reads nothing from `env` except `TRANSACTION_OWNER`.
   */
  deployment: (env: Env) => PolicySqlDeployment;
};

export const createPolicySqlWorker = <Env extends PlatformBindings>(configuration: PolicySqlWorkerConfiguration<Env>) => {
  if (typeof configuration?.deployment !== "function") {
    throw new TypeError("deployment is required: (env) => ({ database, config })");
  }
  if ("database" in configuration) {
    throw new TypeError("database moved into deployment(env); see PolicySqlDeployment");
  }
  return createWorkerEntrypoints<Env>({
    getRuntime: createRuntimeFactory(configuration),
    deployment: configuration.deployment,
    executionTrace: {
      enabled: configuration.developer?.executionTrace === true,
      sink: configuration.developer?.executionTraceSink,
    },
    publicConfig: {
      schemaVersion: configuration.schemaVersion,
      policyVersion: configuration.policyVersion,
      limits: configuration.limits,
    },
  });
};
