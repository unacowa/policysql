import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
// Wrangler turns an imported Wasm module into WebAssembly.Module; wasm-pack's generated
// declaration describes raw exports instead, so consumers need this bundler-specific override.
// @ts-ignore
import wasm from "../pkg/policysql_wasm_bg.wasm";
import { createApp } from "./app.ts";
import { runtimeBytesLimit } from "./binary.ts";
import { TransactionOwnerCore } from "./transaction-owner.ts";

export { createApp } from "./app.ts";
export type { PolicySqlApp } from "./app.ts";
export { TransactionOwnerCore } from "./transaction-owner.ts";
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
  WorkerBindings,
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
  database: import("./database.ts").DatabaseProvider;
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
export const createRuntimeFactory = (configuration: Omit<RuntimeConfiguration, "database">) => {
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

export const createPolicySqlWorker = (configuration: RuntimeConfiguration) => {
  const getRuntime = createRuntimeFactory(configuration);
  return {
    getRuntime,
    TransactionOwner: class extends TransactionOwnerCore {
      constructor(state, env) {
        super(state, env, getRuntime, configuration.database);
      }
    },
    app: createApp({
      getRuntime,
      database: configuration.database,
      executionTrace: {
        enabled: configuration.developer?.executionTrace === true,
        sink: configuration.developer?.executionTraceSink,
      },
      publicConfig: {
        schemaVersion: configuration.schemaVersion,
        policyVersion: configuration.policyVersion,
        limits: configuration.limits,
      },
    }),
  };
};
