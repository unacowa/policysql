// Deployment-owned glue. This file is not part of the published library entrypoint.
import { TursoHttpTransport } from "../src/turso-http.ts";
import type { DatabaseBinding, DatabaseProvider } from "../src/database.ts";
import type { WrapperBindings } from "./config.ts";

const required = (env: WrapperBindings, key: string): string => {
  const value = env[key];
  if (typeof value !== "string" || !value) throw new TypeError(`Missing deployment setting: ${key}`);
  return value;
};

export const createDeploymentDatabase = (getSnapshot: () => string) => {
  const binding = (env: WrapperBindings): DatabaseBinding => ({
    version: 1,
    scope: required(env, "POLICYSQL_ENVIRONMENT"),
    databaseId: required(env, "APPLICATION_DATABASE_ID"),
    generation: required(env, "APPLICATION_DATABASE_GENERATION"),
    snapshot: getSnapshot(),
  });
  // The library passes the provider no env (ADR 0021), so it is bound to the env it was
  // built from, and reads it on every call.
  const provider = (env: WrapperBindings): DatabaseProvider => {
    const check = (selected: DatabaseBinding) => {
      const registered = binding(env);
      return Object.keys(registered).every((key) => registered[key] === selected[key]);
    };
    return {
      check,
      connect(selected, requestId) {
        if (!check(selected)) throw new Error("Unregistered database");
        return new TursoHttpTransport({
          url: required(env, "TURSO_DATABASE_URL"),
          authToken: required(env, "TURSO_AUTH_TOKEN"),
        }, requestId);
      },
    };
  };
  return { binding, provider };
};
