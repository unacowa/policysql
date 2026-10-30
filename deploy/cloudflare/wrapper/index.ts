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
import { createWrapperFetch } from "./fetch.ts";
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
export default { fetch: createWrapperFetch(worker.app, (env) => deploymentDatabase.binding(env)) };
export { ABI_VERSION };

// The Durable Object class bound as TRANSACTION_OWNER (wrangler.jsonc). Each object builds
// its owner's ports from its own env through the same deployment function.
export const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
