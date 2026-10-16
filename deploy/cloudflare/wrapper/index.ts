import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
import wasm from "../pkg/policysql_cloudflare_bg.wasm";
import catalog from "../config/catalog.yaml";
import policy from "../config/policy.compiled.yaml";
import physicalSchema from "../config/schema-introspection.json";
import { createApp } from "../src/app.ts";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "../src/config.ts";
import { TransactionOwnerCore } from "../src/transaction-owner.ts";
import { createDeploymentDatabase } from "./database.ts";

const ABI_VERSION = 1;

let runtime;
const getRuntime = () => {
  if (!runtime) {
    initSync({ module: wasm });
    runtime = PolicySqlRuntime.newWithPhysicalSchema(
      catalog,
      policy,
      SCHEMA_VERSION,
      POLICY_VERSION,
      JSON.stringify({
        max_rows: LIMITS.maxRows,
        max_result_bytes: LIMITS.maxResultBytes,
        timeout_ms: LIMITS.timeoutMs,
        max_statements: LIMITS.maxStatements,
      }),
      JSON.stringify(physicalSchema),
    );
  }
  return runtime;
};

const deploymentDatabase = createDeploymentDatabase(() => getRuntime().snapshot);
export const createHandler = (options = {}) => createApp({ getRuntime, database: deploymentDatabase.provider, ...options });

const app = createHandler();
export default {
  fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith("/v1/commit-checks/")) {
      return app.fetchCallback(request, env, context);
    }
    return app.fetch(request, env, context, deploymentDatabase.binding(env));
  },
};
export { ABI_VERSION };

export class TransactionOwner extends TransactionOwnerCore {
  constructor(state, env) { super(state, env, getRuntime, deploymentDatabase.provider); }
}
