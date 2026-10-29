// Worker entry points built from a wrapper-owned `deployment(env)` (ADR 0021, ADR 0022).
// Kept free of the WASM import so it can be tested without a bundler.
import { createApp } from "./app.ts";
import type { PolicySqlApp } from "./app.ts";
import { executionContextTasks } from "./adapters/durable-objects.ts";
import { ConfigError } from "./engine-config.ts";
import type { PolicySqlConfig } from "./engine-config.ts";
import { createErrorResponse } from "./errors.ts";
import type { TransactionOwnerDependencies } from "./transaction-owner.ts";
import type { TransactionOwnerPort } from "./transaction-owner-port.ts";
import type { AppDependencies, RequestContext } from "./types.ts";

/** What the wrapper builds from its platform environment: the ports that need it. */
export type PolicySqlDeployment = {
  database: import("./database.ts").DatabaseProvider;
  config: PolicySqlConfig;
  /**
   * Routing to transaction owners. On Workers:
   * `durableObjectTransactionOwners(<the wrapper's namespace binding>)` (ADR 0022).
   */
  transactionOwners: TransactionOwnerPort;
};

export type PolicySqlWorkerApp<Env extends object> = {
  fetch(request: Request, env: Env, executionContext: ExecutionContext | undefined, context: RequestContext): Promise<Response>;
  fetchCallback(request: Request, env: Env, executionContext: ExecutionContext | undefined): Promise<Response>;
};

// A rejected deployment is a wrapper fault: 500 before any database, owner, or validator
// call. Only the setting name (ConfigError) or the error class is logged, never a value.
const deploymentRejected = (error: unknown) => {
  console.log(JSON.stringify({
    event: "deployment_config_rejected",
    setting: error instanceof ConfigError ? error.setting : null,
    errorClass: (error as { constructor?: { name?: string } })?.constructor?.name ?? "UnknownError",
  }));
  return createErrorResponse(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
};

export const createWorkerEntrypoints = <Env extends object>({
  getRuntime,
  deployment,
  executionTrace,
  publicConfig,
}: Pick<AppDependencies, "getRuntime" | "executionTrace" | "publicConfig"> & {
  deployment: (env: Env) => PolicySqlDeployment;
}) => {
  const build = (env: Env) => {
    const built = deployment(env);
    return { getRuntime, database: built?.database, config: built?.config, transactionOwners: built?.transactionOwners };
  };
  // At most one app per env object, built and validated on the first request that carries
  // it. A different env object (the platform does not promise to reuse one) gets its own
  // build; nothing is shared across env objects.
  const apps = new WeakMap<object, PolicySqlApp>();
  const appFor = (env: Env): PolicySqlApp => {
    if (env === null || typeof env !== "object") throw new TypeError("env must be the Workers environment object");
    let app = apps.get(env);
    if (!app) {
      app = createApp({ ...build(env), executionTrace, publicConfig });
      apps.set(env, app);
    }
    return app;
  };
  const app: PolicySqlWorkerApp<Env> = {
    fetch(request, env, executionContext, context) {
      let built: PolicySqlApp;
      try { built = appFor(env); } catch (error) { return Promise.resolve(deploymentRejected(error)); }
      return built.fetch(request, context, executionContextTasks(executionContext));
    },
    fetchCallback(request, env) {
      let built: PolicySqlApp;
      try { built = appFor(env); } catch (error) { return Promise.resolve(deploymentRejected(error)); }
      return built.fetchCallback(request);
    },
  };
  /**
   * The transaction owner's ports, built from an owner's own `env` with the same
   * `deployment(env)`. The owner adapter calls it once per owner instance, for example
   * `durableObjectTransactionOwnerClass(worker.ownerDependencies)`.
   */
  const ownerDependencies = (env: Env): TransactionOwnerDependencies => {
    const { getRuntime: runtime, database, config } = build(env);
    return { getRuntime: runtime, database, config };
  };
  return { getRuntime, app, ownerDependencies };
};
