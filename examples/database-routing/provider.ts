import type {
  DatabaseBinding, DatabaseProvider, DatabaseTransport,
} from "@unacowa/policysql/cloudflare";

/** The settings this registry reads. Its own convention; the library reads none of them. */
export type RegistryEnv = { POLICYSQL_ENVIRONMENT?: string; [key: string]: unknown };

export type Route = Readonly<{
  environment: string;
  tenant: string;
  databaseId: string;
  generation: string;
  url: string;
  tokenEnv: string;
  enabledEnv: string;
}>;

/**
 * Application-owned registry. No request, authentication, or JWT dependency. The library
 * hands the provider no `env` (ADR 0021), so `provider(env)` builds one bound to the
 * Workers environment it was given; it reads that environment on every call, so an
 * enabled flag or token is never cached beyond the `env` object itself.
 */
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
  const find = (binding: DatabaseBinding, env: RegistryEnv) => routes.find((route) =>
    route.environment === env.POLICYSQL_ENVIRONMENT &&
    env[route.enabledEnv] === "true" &&
    binding.scope === `${route.environment}:${route.tenant}` &&
    binding.databaseId === route.databaseId && binding.generation === route.generation &&
    binding.snapshot === getSnapshot());
  return {
    provider(env: RegistryEnv): DatabaseProvider {
      return {
        check(binding) { return Boolean(find(binding, env)); },
        connect(binding, requestId) {
          const route = find(binding, env);
          const token = route && env[route.tokenEnv];
          if (!route || typeof token !== "string" || !token) throw new Error("Database unavailable");
          return createTransport({ url: route.url, authToken: token }, requestId);
        },
      };
    },
    binding(databaseId: string, env: RegistryEnv): DatabaseBinding {
      const route = routes.find((item) => item.environment === env.POLICYSQL_ENVIRONMENT && item.databaseId === databaseId);
      if (!route) throw new Error("Unregistered database");
      return bindingFor(route);
    },
  };
};
