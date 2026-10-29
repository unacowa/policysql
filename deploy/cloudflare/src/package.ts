import { initSync, PolicySqlRuntime } from "../pkg/policysql_wasm.js";
// Wrangler turns an imported Wasm module into WebAssembly.Module; wasm-pack's generated
// declaration describes raw exports instead, so consumers need this bundler-specific override.
// @ts-ignore
import wasm from "../pkg/policysql_wasm_bg.wasm";
import { runtimeBytesLimit } from "./binary.ts";
import { createWorkerEntrypoints } from "./worker.ts";
import type { PolicySqlDeployment } from "./worker.ts";

// The engine's operations (ADR 0019 stage 3, ADR 0023) and the HTTP inbound adapter.
// `createEngine` is the entry for non-HTTP callers; `createApp` is the engine with the
// canonical HTTP mapping; `createHttpAdapter` puts that mapping over a given engine.
export { createApp } from "./app.ts";
export type { PolicySqlApp } from "./app.ts";
export { checkRequestContext, createEngine } from "./engine.ts";
export type {
  BeginInput, BodyText, CallbackContext, CallbackQueryInput, ExecuteInput, ExplainInput, OperationFailure,
  OperationResult, PolicySqlEngine, SnapshotInput, SnapshotResult, TransactionCommandInput,
} from "./engine.ts";
export { EngineError } from "./errors.ts";
export type { OperationError } from "./errors.ts";
export { createHttpAdapter } from "./http/adapter.ts";
export type { PolicySqlHttpApp } from "./http/adapter.ts";
export { ERROR_STATUS, statusFor } from "./http/status.ts";
export { TransactionOwnerCore } from "./transaction-owner.ts";
export type { PolicySqlDeployment, PolicySqlWorkerApp } from "./worker.ts";
export type { TransactionOwnerDependencies } from "./transaction-owner.ts";
// The TransactionOwner port (ADR 0022) and its Cloudflare Durable Objects adapter, which
// the wrapper assembles. A custom adapter implements the port types instead.
export type {
  BackgroundTasks, OwnerAtomicInput, OwnerBeginInput, OwnerCallbackInput, OwnerCommandInput, OwnerCommandKind,
  OwnerFacilities, OwnerReply, OwnerStore, OwnerTimer, TransactionOwnerHandle, TransactionOwnerPort,
} from "./transaction-owner-port.ts";
export {
  durableObjectFacilities, durableObjectTransactionOwnerClass, durableObjectTransactionOwners, executionContextTasks,
} from "./adapters/durable-objects.ts";
// The deployment configuration contract, in one place (ADR 0021).
export { ConfigError, validateConfig } from "./engine-config.ts";
export type { CommitCheckEndpoint, CostCatalog, PolicySqlConfig } from "./engine-config.ts";
export { TursoHttpTransport } from "./turso-http.ts";
export { createErrorResponse } from "./http/responses.ts";
export type { ErrorResponseOptions } from "./http/responses.ts";
// Optional identity adapter for wrappers. The engine never imports it (ADR 0019).
export { createJwtSessionVerifier, JwtAuthenticationError } from "./adapters/jwt.ts";
export type { JwtSessionVerifierOptions } from "./adapters/jwt.ts";
export type {
  DatabaseBinding, DatabaseProvider, DatabaseTransport, DatabaseTransportOptions,
  DatabaseTransaction, DatabaseResult, DatabaseUsage,
} from "./database.ts";
export type {
  AppDependencies,
  AuthContext,
  RequestContext,
  TrustedSession,
  ExecutionTrace,
  ExecutionTraceParameter,
  ExecutionTraceSink,
  ExecutionTraceStatement,
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

export type PolicySqlWorkerConfiguration<Env extends object = Record<string, unknown>> = RuntimeConfiguration & {
  /**
   * Wrapper-owned. Builds the database provider, `PolicySqlConfig`, and the
   * TransactionOwner port from the Workers `env` (ADR 0021, ADR 0022). Workers delivers
   * `env` per request and to the Durable Object constructor, not at module load, so the
   * library calls this with the `env` it was handed. The Worker calls it at most once per
   * `env` object; a request that arrives with a different `env` object rebuilds (and
   * revalidates) the deployment for that object. Each owner instance calls it once, through
   * `ownerDependencies`. The Worker and an owner therefore share a configuration only if
   * this is a pure function of the bindings. The library reads nothing from `env` itself.
   */
  deployment: (env: Env) => PolicySqlDeployment;
};

export const createPolicySqlWorker = <Env extends object>(configuration: PolicySqlWorkerConfiguration<Env>) => {
  if (typeof configuration?.deployment !== "function") {
    throw new TypeError("deployment is required: (env) => ({ database, config, transactionOwners })");
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
