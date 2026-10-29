// Compile-only regressions for the public embedding API.
import {
  createApp, createJwtSessionVerifier, createPolicySqlWorker, createRuntimeFactory, durableObjectTransactionOwnerClass,
  durableObjectTransactionOwners, JwtAuthenticationError,
} from "../../src/package.ts";
import type {
  BackgroundTasks, DatabaseProvider, DatabaseBinding, PolicySqlConfig, RequestContext, RuntimeConfiguration,
  TransactionOwnerPort, TrustedSession,
} from "../../src/package.ts";

declare const configuration: RuntimeConfiguration;
declare const config: PolicySqlConfig;
declare const database: DatabaseProvider;
declare const binding: DatabaseBinding;
declare const request: Request;
declare const env: { TRANSACTION_OWNER: DurableObjectNamespace };
declare const context: ExecutionContext;
declare const session: TrustedSession;
declare const transactionOwners: TransactionOwnerPort;
declare const background: BackgroundTasks;

const checkTypes = () => {
  // Compiler-only construction needs no database.
  const getRuntime = createRuntimeFactory(configuration);
  // @ts-expect-error Execution requires an explicitly supplied provider.
  createApp({ getRuntime, config, transactionOwners });
  // @ts-expect-error Execution requires explicit configuration (ADR 0021).
  createApp({ getRuntime, database, transactionOwners });
  // @ts-expect-error Execution requires the TransactionOwner port (ADR 0022).
  createApp({ getRuntime, database, config });
  // @ts-expect-error The Worker factory requires the wrapper's deployment(env) function.
  createPolicySqlWorker(configuration);
  // @ts-expect-error The provider moved into deployment(env); it is no longer a static option.
  createPolicySqlWorker({ ...configuration, database, deployment: () => ({ database, config, transactionOwners }) });
  // @ts-expect-error The wrapper supplies the owner port from its own bindings (ADR 0022).
  createPolicySqlWorker({ ...configuration, deployment: () => ({ database, config }) });
  const worker = createPolicySqlWorker<typeof env>({
    ...configuration,
    deployment: (platform) => ({ database, config, transactionOwners: durableObjectTransactionOwners(platform.TRANSACTION_OWNER) }),
  });
  // The wrapper assembles the Durable Object class from the owner's dependencies.
  const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
  void TransactionOwner;
  worker.app.fetch(request, env, context, { database: binding, session });
  worker.app.fetchCallback(request, env, context);
  // @ts-expect-error Deployment settings are typed; an env-style name is not one.
  createApp({ getRuntime, database, transactionOwners, config: { environment: "dev", POLICYSQL_PUBLIC_BASE_URL: "https://x.test" } });
  // @ts-expect-error A commit check endpoint carries the resolved URL and secret, not env names.
  createApp({ getRuntime, database, transactionOwners, config: { environment: "dev", commitChecks: { c: { urlEnv: "VALIDATOR_URL" } } } });
  const app = createApp({ getRuntime, database, config, transactionOwners });
  // @ts-expect-error Each ordinary request must carry its selected database.
  app.fetch(request);
  // @ts-expect-error A bare binding is no longer the per-request input; pass { database, session }.
  app.fetch(request, binding);
  // @ts-expect-error The engine takes no platform env or ExecutionContext (ADR 0022).
  app.fetch(request, env, context, { database: binding, session });
  app.fetch(request, { database: binding, session });
  app.fetch(request, { database: binding, session, requestId: "req_1" }, background);
  // @ts-expect-error The library reads no credential; a JWT is not a session.
  app.fetch(request, { database: binding, session: "eyJ..." });
  const input: RequestContext = { database: binding, session };
  void input;
  app.fetchCallback(request);
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
};
void checkTypes;
