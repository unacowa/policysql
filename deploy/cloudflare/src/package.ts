import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
// Wrangler turns an imported Wasm module into WebAssembly.Module; wasm-pack's generated
// declaration describes raw exports instead, so consumers need this bundler-specific override.
// @ts-ignore
import wasm from "../pkg/policysql_cloudflare_bg.wasm";
import { createApp } from "./app.ts";

export { createApp } from "./app.ts";
export { TransactionOwnerCore } from "./transaction-owner.ts";
export type {
  AppDependencies,
  AppEnv,
  AuthContext,
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
    runtime = PolicySqlRuntime.newWithPhysicalSchema(
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
    return runtime;
  };
};

export const createPolicySqlWorker = (configuration: RuntimeConfiguration) => {
  const getRuntime = createRuntimeFactory(configuration);
  return {
    getRuntime,
    app: createApp({
      getRuntime,
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
