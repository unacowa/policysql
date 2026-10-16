// Deployment-owned glue. This file is not part of the published library entrypoint.
import { TursoHttpTransport } from "../src/turso-http.ts";
import type { DatabaseBinding, DatabaseProvider } from "../src/database.ts";
import type { WorkerBindings } from "../src/types.ts";

const required = (env: WorkerBindings, key: string): string => {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new TypeError(`Missing deployment setting: ${key}`);
  return value;
};

export const createDeploymentDatabase = (getSnapshot: () => string) => {
  const binding = (env: WorkerBindings): DatabaseBinding => ({
    version: 1,
    scope: required(env, "POLICYSQL_ENVIRONMENT"),
    databaseId: required(env, "APPLICATION_DATABASE_ID"),
    generation: required(env, "APPLICATION_DATABASE_GENERATION"),
    snapshot: getSnapshot(),
  });
  const provider: DatabaseProvider = {
    check(selected, env) {
      const registered = binding(env);
      return Object.keys(registered).every((key) => registered[key] === selected[key]);
    },
    connect(selected, env, requestId) {
      if (!provider.check(selected, env)) throw new Error("Unregistered database");
      return new TursoHttpTransport({
        url: required(env, "TURSO_DATABASE_URL"),
        authToken: required(env, "TURSO_AUTH_TOKEN"),
      }, requestId);
    },
  };
  return { binding, provider };
};
