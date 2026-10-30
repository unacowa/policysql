import catalog from "../config/catalog.yaml";
import policy from "../config/policy.compiled.yaml";
import physicalSchema from "../config/schema-introspection.json";
import {
  createPolicySqlWorker, durableObjectTransactionOwnerClass, durableObjectTransactionOwners,
} from "../src/package.ts";
import { POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";
import { configFromEnv } from "./config.ts";
import { RUNTIME_LIMITS } from "./limits.ts";
import { createDeploymentDatabase } from "./database.ts";
import {
  isOwnerVersionProbe, OWNER_VERSION_PATH, ownerVersionReply, ownerVersionRoute, withDeploymentVersion,
  type VersionBindings,
} from "./deployment-version.ts";
import { createWrapperFetch } from "./fetch.ts";
import { authenticateJwt } from "./auth.ts";
import type { RateLimitedBindings } from "./rate-limit.ts";

const ABI_VERSION = 1;

const deploymentDatabase = createDeploymentDatabase(() => worker.getRuntime().snapshot);

const worker = createPolicySqlWorker<RateLimitedBindings>({
  catalog,
  policy,
  physicalSchema,
  schemaVersion: SCHEMA_VERSION,
  policyVersion: POLICY_VERSION,
  limits: RUNTIME_LIMITS,
  // This wrapper's env convention becomes the library's explicit configuration (ADR 0021),
  // and its Durable Object binding becomes the TransactionOwner port (ADR 0022). The
  // library calls this for the Worker and for each Durable Object with its env.
  deployment: (env) => ({
    database: deploymentDatabase.provider(env),
    config: configFromEnv(env),
    transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER),
  }),
});

// Rate limiting runs here, before app.fetch and before binding() initializes WASM (ADR 0018).
// Every response names the Worker version that produced it (#42, wrapper/deployment-version.ts).
export default {
  fetch: withDeploymentVersion(createWrapperFetch(
    worker.app, (env) => deploymentDatabase.binding(env), authenticateJwt,
    { [OWNER_VERSION_PATH]: (request, env) => ownerVersionRoute(request, env as RateLimitedBindings & VersionBindings) },
  )),
};
export { ABI_VERSION };

// The Durable Object class bound as TRANSACTION_OWNER (wrangler.jsonc). Each object builds
// its owner's ports from its own env through the same deployment function. The wrapper adds
// one message of its own, the version probe of `/healthz/owner`; every other message is the
// library's.
const LibraryTransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
export class TransactionOwner extends LibraryTransactionOwner {
  readonly versionEnv: VersionBindings;

  constructor(state: DurableObjectState, env: RateLimitedBindings & VersionBindings) {
    super(state, env);
    this.versionEnv = { CF_VERSION_METADATA: env.CF_VERSION_METADATA };
  }

  fetch(request: Request): Promise<Response> {
    return isOwnerVersionProbe(request) ? Promise.resolve(ownerVersionReply(this.versionEnv)) : super.fetch(request);
  }
}
