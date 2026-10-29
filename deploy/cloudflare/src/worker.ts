// Worker and Durable Object entry points built from a wrapper-owned `deployment(env)`
// (ADR 0021). Kept free of the WASM import so it can be tested without a bundler.
import { createApp } from "./app.ts";
import type { PolicySqlApp } from "./app.ts";
import { ConfigError } from "./engine-config.ts";
import type { PolicySqlConfig } from "./engine-config.ts";
import { createErrorResponse } from "./errors.ts";
import { TransactionOwnerCore } from "./transaction-owner.ts";
import type { AppDependencies, PlatformBindings, RequestContext } from "./types.ts";

/** What the wrapper builds from its platform environment: the ports that need it. */
export type PolicySqlDeployment = {
  database: import("./database.ts").DatabaseProvider;
  config: PolicySqlConfig;
};

export type PolicySqlWorkerApp<Env extends PlatformBindings> = {
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

export const createWorkerEntrypoints = <Env extends PlatformBindings>({
  getRuntime,
  deployment,
  executionTrace,
  publicConfig,
}: Pick<AppDependencies, "getRuntime" | "executionTrace" | "publicConfig"> & {
  deployment: (env: Env) => PolicySqlDeployment;
}) => {
  const build = (env: Env) => {
    const built = deployment(env);
    return { getRuntime, database: built?.database, config: built?.config };
  };
  // One app per env object: Workers passes the same object for the isolate's lifetime, so
  // the deployment is built and validated once, on the first request that needs it.
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
      return built.fetch(request, env, executionContext, context);
    },
    fetchCallback(request, env, executionContext) {
      let built: PolicySqlApp;
      try { built = appFor(env); } catch (error) { return Promise.resolve(deploymentRejected(error)); }
      return built.fetchCallback(request, env, executionContext);
    },
  };
  return {
    getRuntime,
    app,
    /** The Durable Object class. It builds the same deployment from its own `env`. */
    TransactionOwner: class extends TransactionOwnerCore {
      constructor(state, env: Env) {
        super(state, build(env));
      }
    },
  };
};
