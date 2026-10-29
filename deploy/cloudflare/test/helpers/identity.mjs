// Core's identity computation from the real WASM (ADR 0024 pull request 2), for tests whose
// runtime is otherwise a fake. `identity_json` reads no runtime state, so any activated
// runtime computes the same result.
import { readFileSync } from "node:fs";
import { initSync, PolicySqlRuntime } from "../../pkg/policysql_wasm.js";

initSync({ module: readFileSync(new URL("../../pkg/policysql_wasm_bg.wasm", import.meta.url)) });
const example = (name) => readFileSync(new URL(`../../../../examples/database-routing/${name}`, import.meta.url), "utf8");

export const identityRuntime = PolicySqlRuntime.newWithPhysicalSchema(
  example("catalog.yaml"), example("policy.yaml"), "schema_identity_1", "policy_identity_1",
  JSON.stringify({ max_rows: 100, max_result_bytes: 64_000, timeout_ms: 1_000, max_statements: 8 }),
  example("physical-schema.json"),
);

/** `runtime.identity_json` of the real core, to put on a fake runtime. */
export const identity_json = (inputJson) => identityRuntime.identity_json(inputJson);
