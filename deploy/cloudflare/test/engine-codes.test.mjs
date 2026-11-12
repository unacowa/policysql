import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR 0011 and ADR 0024 pull request 9: no TypeScript decides a transaction outcome. Core
// (`step_json`) answers every outcome the specification determines; an engine module names
// only POLICYSQL_INTERNAL and the codes of the adapter classes it reports, each listed with its
// reason. A decision code (a conflict, an unavailable or expired transaction, a commit check
// verdict, an idempotency answer, an expectation, a transaction limit, an unknown commit
// outcome) in an engine module fails this test.
//
// This is a text scan, not a boundary lint rule (issue #59), because the answer is an
// allowlist of *code names* with a reason each: a selector can say "no POLICYSQL_* string",
// not "these twelve, and no others". The list is the decision.
const ENGINE_CODES = new Map([
  ["POLICYSQL_INTERNAL", "a fault of the engine or of its inputs"],
  ["POLICYSQL_OUTCOME_UNKNOWN", "a keyed execute refused by the session gate or a body limit before core, whose retry may be of a write committed under an earlier deployment (ADR 0007 #85, #100); the refusal goes in detail.cause"],
  ["POLICYSQL_INVALID_REQUEST", "request framing checked before core (ADR 0023 order), and the begin body checks that stay in the engine while interactive commands have no `request` kind (ADR 0024 pull request 7)"],
  ["POLICYSQL_REQUEST_TOO_LARGE", "the request byte and value limits, checked before the body reaches core; a keyed execute answers the unknown outcome when the retry may predate a deployment that lowered them (ADR 0007, #100)"],
  ["POLICYSQL_JSON_TOO_DEEP", "the body depth limit, checked before core; the limit tightened from 65 to 64 nested containers, so a keyed execute answers the unknown outcome (ADR 0007, #100)"],
  ["POLICYSQL_STALE_OPERATION", "a binding or begin precondition naming another snapshot, checked before core"],
  ["POLICYSQL_DATABASE_REQUIRED", "database adapter class: the wrapper supplied no provider"],
  ["POLICYSQL_DATABASE_BINDING_REJECTED", "database adapter class: the provider rejected the binding"],
  ["POLICYSQL_DATABASE_UNAVAILABLE", "database adapter class: the provider or transport failed"],
  ["POLICYSQL_DATABASE_TIMEOUT", "database adapter class: the deadline passed"],
  ["POLICYSQL_DATABASE_ERROR", "database adapter class: the database refused a statement (a step error that is neither complexity nor a constraint)"],
  ["POLICYSQL_LIMIT_EXCEEDED", "database adapter class: a value or response over the transport's byte bound"],
  ["POLICYSQL_SCHEMA_MISMATCH", "driver codec: a driver value the codec cannot carry"],
  ["POLICYSQL_COST_ADMISSION_UNAVAILABLE", "a cost observation log record whose connection failed; never a reply"],
]);

/** The engine: every `src/` module that is not an adapter or the assembly (eslint.config.js). */
const NOT_ENGINE = new Set([
  "http/adapter.ts", "http/body.ts", "http/responses.ts", "http/routes.ts", "http/status.ts", "http/conformance.ts",
  "adapters/durable-objects.ts", "adapters/commit-check-hook.ts", "adapters/jwt.ts", "turso-http.ts", "redirects.ts",
  "bounded-body.ts", "worker.ts", "package.ts", "app.ts", "modules.d.ts", "policy-staged.ts",
]);
const root = new URL("../src/", import.meta.url);
const engine = readdirSync(root, { recursive: true })
  .map((name) => String(name).split("\\").join("/"))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !NOT_ENGINE.has(name));

const codesNamed = (text) => new Set([...text.matchAll(/"(POLICYSQL_[A-Z0-9_]+)"/gu)].map((match) => match[1]));

test("engine modules name no POLICYSQL_* code but POLICYSQL_INTERNAL and adapter-class codes", () => {
  for (const name of engine) {
    const named = [...codesNamed(readFileSync(join(fileURLToPath(root), name), "utf8"))].filter((code) => !ENGINE_CODES.has(code));
    assert.deepEqual(named, [], `${name} names a code core decides; return core's answer instead`);
  }
  // Non-vacuity: the scanned modules do name adapter-class codes, and a decision code is caught.
  const all = new Set(engine.flatMap((name) => [...codesNamed(readFileSync(join(fileURLToPath(root), name), "utf8"))]));
  for (const code of ["POLICYSQL_INTERNAL", "POLICYSQL_DATABASE_UNAVAILABLE", "POLICYSQL_SCHEMA_MISMATCH"]) assert.ok(all.has(code), code);
  for (const code of ["POLICYSQL_TRANSACTION_CONFLICT", "POLICYSQL_COMMIT_CHECK_REJECTED", "POLICYSQL_IDEMPOTENCY_CONFLICT"]) {
    assert.ok(codesNamed(`throw new EngineError("${code}", "m");`).has(code));
    assert.equal(ENGINE_CODES.has(code), false, code);
  }
});
