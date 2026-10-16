// Compile-only regressions for the public embedding API.
import { createApp, createPolicySqlWorker, createRuntimeFactory } from "../../src/package.ts";
import type { DatabaseProvider, DatabaseBinding, RuntimeConfiguration, WorkerBindings } from "../../src/package.ts";

declare const configuration: Omit<RuntimeConfiguration, "database">;
declare const database: DatabaseProvider;
declare const binding: DatabaseBinding;
declare const request: Request;
declare const env: WorkerBindings;
declare const context: ExecutionContext;

const checkTypes = () => {
  // Compiler-only construction needs no database.
  const getRuntime = createRuntimeFactory(configuration);
  // @ts-expect-error Execution requires an explicitly supplied provider.
  createApp({ getRuntime });
  // @ts-expect-error The Worker factory also requires an explicit provider.
  createPolicySqlWorker(configuration);
  const app = createApp({ getRuntime, database });
  // @ts-expect-error Each ordinary request must carry its selected database.
  app.fetch(request, env, context);
  app.fetch(request, env, context, binding);
  app.fetchCallback(request, env, context);
  // @ts-expect-error DB providers do not select from an identity or JWT.
  database.select({}, env);
};
void checkTypes;
