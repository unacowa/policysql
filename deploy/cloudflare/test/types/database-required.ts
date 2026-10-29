// Compile-only regressions for the public embedding API.
import { createApp, createJwtSessionVerifier, createPolicySqlWorker, createRuntimeFactory, JwtAuthenticationError } from "../../src/package.ts";
import type {
  DatabaseProvider, DatabaseBinding, RequestContext, RuntimeConfiguration, TrustedSession, WorkerBindings,
} from "../../src/package.ts";

declare const configuration: Omit<RuntimeConfiguration, "database">;
declare const database: DatabaseProvider;
declare const binding: DatabaseBinding;
declare const request: Request;
declare const env: WorkerBindings;
declare const context: ExecutionContext;
declare const session: TrustedSession;

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
};
void checkTypes;
