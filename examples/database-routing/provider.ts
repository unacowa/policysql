import type {
  DatabaseBinding, DatabaseProvider, DatabaseTransport, WorkerBindings,
} from "@unacowa/policysql/cloudflare";

export type Route = Readonly<{
  environment: string;
  tenant: string;
  databaseId: string;
  generation: string;
  url: string;
  tokenEnv: string;
  enabledEnv: string;
}>;

/** Application-owned registry. No request, authentication, or JWT dependency. */
export const createDatabaseRegistry = (
  configuredRoutes: readonly Route[],
  getSnapshot: () => string,
  createTransport: (credentials: { url: string; authToken: string }, requestId: string) => DatabaseTransport,
) => {
  const routes = configuredRoutes.map((route) => Object.freeze({ ...route }));
  const identities = routes.map((route) => `${route.environment}:${route.databaseId}`);
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate database route");
  const bindingFor = (route: Route): DatabaseBinding => ({
    version: 1,
    scope: `${route.environment}:${route.tenant}`,
    databaseId: route.databaseId,
    generation: route.generation,
    snapshot: getSnapshot(),
  });
  const find = (binding: DatabaseBinding, env: WorkerBindings) => routes.find((route) =>
    route.environment === env.POLICYSQL_ENVIRONMENT &&
    env[route.enabledEnv] === "true" &&
    binding.scope === `${route.environment}:${route.tenant}` &&
    binding.databaseId === route.databaseId && binding.generation === route.generation &&
    binding.snapshot === getSnapshot());
  const provider: DatabaseProvider = {
    check(binding, env) { return Boolean(find(binding, env)); },
    connect(binding, env, requestId) {
      const route = find(binding, env);
      const token = route && env[route.tokenEnv];
      if (!route || typeof token !== "string" || !token) throw new Error("Database unavailable");
      return createTransport({ url: route.url, authToken: token }, requestId);
    },
  };
  return {
    provider,
    binding(databaseId: string, env: WorkerBindings): DatabaseBinding {
      const route = routes.find((item) => item.environment === env.POLICYSQL_ENVIRONMENT && item.databaseId === databaseId);
      if (!route) throw new Error("Unregistered database");
      return bindingFor(route);
    },
  };
};
