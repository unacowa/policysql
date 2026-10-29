// Compile-only regressions for the public embedding API.
import { createApp, createJwtSessionVerifier, createPolicySqlWorker, createRuntimeFactory, JwtAuthenticationError } from "../../src/package.ts";
import type {
  DatabaseProvider, DatabaseBinding, PlatformBindings, PolicySqlConfig, RequestContext, RuntimeConfiguration, TrustedSession,
} from "../../src/package.ts";

declare const configuration: RuntimeConfiguration;
declare const config: PolicySqlConfig;
declare const database: DatabaseProvider;
declare const binding: DatabaseBinding;
declare const request: Request;
declare const env: PlatformBindings;
declare const context: ExecutionContext;
declare const session: TrustedSession;

const checkTypes = () => {
  // Compiler-only construction needs no database.
  const getRuntime = createRuntimeFactory(configuration);
  // @ts-expect-error Execution requires an explicitly supplied provider.
  createApp({ getRuntime, config });
  // @ts-expect-error Execution requires explicit configuration (ADR 0021).
  createApp({ getRuntime, database });
  // @ts-expect-error The Worker factory requires the wrapper's deployment(env) function.
  createPolicySqlWorker(configuration);
  // @ts-expect-error The provider moved into deployment(env); it is no longer a static option.
  createPolicySqlWorker({ ...configuration, database, deployment: () => ({ database, config }) });
  createPolicySqlWorker({ ...configuration, deployment: () => ({ database, config }) });
  // @ts-expect-error Deployment settings are typed; an env-style name is not one.
  createApp({ getRuntime, database, config: { environment: "dev", POLICYSQL_PUBLIC_BASE_URL: "https://x.test" } });
  // @ts-expect-error A commit check endpoint carries the resolved URL and secret, not env names.
  createApp({ getRuntime, database, config: { environment: "dev", commitChecks: { c: { urlEnv: "VALIDATOR_URL" } } } });
  const app = createApp({ getRuntime, database, config });
  // @ts-expect-error Each ordinary request must carry its selected database.
  app.fetch(request, env, context);
  // @ts-expect-error A bare binding is no longer the per-request input; pass { database, session }.
  app.fetch(request, env, context, binding);
  app.fetch(request, env, context, { database: binding, session });
  app.fetch(request, env, context, { database: binding, session, requestId: "req_1" });
  // @ts-expect-error The library reads no credential; a JWT is not a session.
  app.fetch(request, env, context, { database: binding, session: "eyJ..." });
  const input: RequestContext = { database: binding, session };
  void input;
  app.fetchCallback(request, env, context);
  // @ts-expect-error DB providers do not select from an identity or JWT.
  database.select({}, env);
  // @ts-expect-error The library hands the provider no platform env (ADR 0021).
  database.check(binding, env);
  // The JWT identity adapter is an optional export for wrappers.
  const verify: (request: Request) => Promise<TrustedSession> = createJwtSessionVerifier({
    jwksUrl: "https://issuer.test/jwks", issuer: "https://issuer.test", audience: "policysql",
  });
  void verify;
  const status: 401 = new JwtAuthenticationError().status;
  void status;
  // @ts-expect-error The library no longer declares JWT bindings; the wrapper owns them.
  const issuer: string = env.POLICYSQL_JWT_ISSUER;
  void issuer;
  // @ts-expect-error Deployment settings are not platform bindings any more (ADR 0021).
  const base: string = env.POLICYSQL_PUBLIC_BASE_URL;
  void base;
};
void checkTypes;
