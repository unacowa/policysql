import { initSync, PolicySqlRuntime } from "../pkg/policysql_cloudflare.js";
import wasm from "../pkg/policysql_cloudflare_bg.wasm";
import catalog from "../config/catalog.yaml";
import policy from "../config/policy.compiled.yaml";
import physicalSchema from "../config/schema-introspection.json";
import { createApp } from "./app.ts";
import { LIMITS, POLICY_VERSION, SCHEMA_VERSION } from "./config.ts";
import { TransactionOwnerCore } from "./transaction-owner.ts";

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

export const createHandler = (options = {}) => createApp({ getRuntime, ...options });

export default createHandler();
export { ABI_VERSION };

export class TransactionOwner extends TransactionOwnerCore {
  constructor(state, env) { super(state, env, getRuntime); }
}
