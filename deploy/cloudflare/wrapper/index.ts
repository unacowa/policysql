import catalog from "../config/catalog.yaml";
import policy from "../config/policy.compiled.yaml";
import physicalSchema from "../config/schema-introspection.json";
import { createPolicySqlWorker } from "../src/package.ts";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";
import { configFromEnv } from "./config.ts";
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
  limits: {
    maxRows: LIMITS.maxRows,
    maxResultBytes: LIMITS.maxResultBytes,
    timeoutMs: LIMITS.timeoutMs,
    maxStatements: LIMITS.maxStatements,
  },
  // This wrapper's env convention becomes the library's explicit configuration (ADR 0021).
  // The library calls this for the Worker and for each Durable Object with its env.
  deployment: (env) => ({ database: deploymentDatabase.provider(env), config: configFromEnv(env) }),
});

// Rate limiting runs here, before app.fetch and before binding() initializes WASM (ADR 0018).
export default { fetch: createWrapperFetch(worker.app, (env) => deploymentDatabase.binding(env)) };
export { ABI_VERSION };

export const TransactionOwner = worker.TransactionOwner;
