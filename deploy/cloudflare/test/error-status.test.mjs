import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_STATUS, LOG_ONLY_CODES, statusFor } from "../src/http/status.ts";
import { createErrorResponse } from "../src/http/responses.ts";
import { JwtAuthenticationError } from "../src/adapters/jwt.ts";
import { OUTCOME_CAUSES, checkedErrorDetail } from "../src/error-detail.ts";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError } from "../../../packages/client/index.js";

// The status table is single-sourced (ADR 0019, ADR 0023): website/api/errors.md is the
// specification, src/http/status.ts is the only implementation, and every code the library
// can produce (TypeScript and Rust) has an entry.
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(join(repository, path), "utf8");

const specTable = (marker) => {
  const text = read("website/api/errors.md");
  const start = text.indexOf(`<!-- policysql:error-status-table:${marker} -->`);
  assert.notEqual(start, -1, `errors.md has the ${marker} table`);
  const rows = text.slice(start).split("\n").slice(1);
  const table = {};
  assert.match(rows[0], /^\| Code \| Status \|/u);
  for (const row of rows.slice(2)) {
    if (!row.startsWith("|")) break;
    const match = row.match(/^\| `(POLICYSQL_[A-Z0-9_]+)` \| (\d{3}) \|/u);
    assert.ok(match, `malformed row: ${row}`);
    assert.equal(Object.hasOwn(table, match[1]), false, `${match[1]} is listed once`);
    table[match[1]] = Number(match[2]);
  }
  assert.ok(Object.keys(table).length > 0);
  return table;
};

// The codes that appear only in structured logs (no status, never in a reply): the table under
// `<!-- policysql:log-code-table -->`, whose first column is the code.
const logCodes = () => {
  const text = read("website/api/errors.md");
  const start = text.indexOf("<!-- policysql:log-code-table -->");
  assert.notEqual(start, -1, "errors.md has the log code table");
  const rows = text.slice(start).split("\n").slice(1);
  assert.match(rows[0], /^\| Code \| Log event \|/u);
  const codes = new Set();
  for (const row of rows.slice(2)) {
    if (!row.startsWith("|")) break;
    const match = row.match(/^\| `(POLICYSQL_[A-Z0-9_]+)` \| `[a-z_]+` \|/u);
    assert.ok(match, `malformed row: ${row}`);
    assert.equal(codes.has(match[1]), false, `${match[1]} is listed once`);
    codes.add(match[1]);
  }
  assert.ok(codes.size > 0);
  return codes;
};

const files = (directory, extension) => readdirSync(join(repository, directory), { recursive: true })
  .filter((name) => name.endsWith(extension))
  .map((name) => join(directory, name));
const codesIn = (paths) => {
  const found = new Map();
  for (const path of paths) {
    for (const [code] of read(path).matchAll(/POLICYSQL_[A-Z0-9_]+(?![A-Za-z0-9_])/gu)) {
      if (!found.has(code)) found.set(code, path);
    }
  }
  return found;
};

test("the HTTP adapter's status table is exactly the specification's library table", () => {
  assert.deepEqual({ ...ERROR_STATUS }, specTable("library"));
});

test("every code in TypeScript library source and Rust crates has a status in the specification", () => {
  const library = specTable("library");
  const wrapper = specTable("wrapper");
  const logged = logCodes();
  for (const code of Object.keys(wrapper)) assert.equal(Object.hasOwn(library, code), false, `${code} is in one table`);
  for (const code of logged) {
    assert.equal(Object.hasOwn(library, code) || Object.hasOwn(wrapper, code), false, `${code} is in one table`);
  }
  // The conformance suite is test support; it names an unknown code on purpose.
  const typescript = codesIn(files("deploy/cloudflare/src", ".ts")
    .filter((path) => path !== join("deploy/cloudflare/src", "http", "conformance.ts")));
  const rust = codesIn(files("crates", ".rs"));
  // Non-vacuity: both enumerations see real codes from both languages.
  assert.ok(typescript.has("POLICYSQL_TRANSACTION_CONFLICT") && typescript.has("POLICYSQL_UNSUPPORTED_MEDIA_TYPE"));
  assert.ok(rust.has("POLICYSQL_FORBIDDEN_COLUMN") && rust.has("POLICYSQL_AMBIGUOUS_PARAMETER_TYPE"));
  for (const [code, path] of [...typescript, ...rust]) {
    assert.ok(Object.hasOwn(library, code) || Object.hasOwn(wrapper, code) || logged.has(code),
      `${code} (${relative(".", path)}) has no status (or log-only entry) in website/api/errors.md`);
  }
  // The only wrapper code in library source is the JWT identity adapter's.
  for (const [code, path] of typescript) {
    if (Object.hasOwn(wrapper, code)) assert.equal(path, join("deploy/cloudflare/src", "adapters", "jwt.ts"), code);
  }
});

test("wrapper-returned codes use their specified status", () => {
  const wrapper = specTable("wrapper");
  const error = new JwtAuthenticationError();
  assert.equal(error.status, wrapper[error.code]);
  for (const path of ["deploy/cloudflare/wrapper/rate-limit.ts", "examples/database-routing/rate-limit.ts"]) {
    assert.match(read(path), /429, "POLICYSQL_RATE_LIMITED"/u, path);
  }
  assert.equal(wrapper.POLICYSQL_RATE_LIMITED, 429);
});

test("an unknown code is served as 500, and createErrorResponse keeps table codes at their status", () => {
  assert.equal(statusFor("POLICYSQL_NOT_IN_THE_TABLE"), 500);
  assert.equal(statusFor("toString"), 500);
  assert.equal(statusFor(undefined), 500);
  assert.throws(() => createErrorResponse(400, "POLICYSQL_FORBIDDEN_COLUMN", "m"), TypeError);
  assert.equal(createErrorResponse(403, "POLICYSQL_FORBIDDEN_COLUMN", "m").status, 403);
  assert.equal(createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "m").status, 429);
});

test("the client's definite-rejection table agrees with the specification", async () => {
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  const all = { ...specTable("library"), ...specTable("wrapper") };
  for (const [status, codes] of REJECTIONS) {
    for (const code of codes) assert.equal(all[`POLICYSQL_${code}`], status, `client lists ${code} under ${status}`);
  }
});

// ADR 0027: both 413 codes the engine answers for a request or its result are definite
// rejections, so the client lists them under 413, and the status table, the HTTP adapter's
// table, and the client's agree on the pair. (Before, an oversized body was reported to
// applications as an unknown outcome.)
test("POLICYSQL_REQUEST_TOO_LARGE is a definite rejection under 413 in the client, the adapter's table, and the specification", async () => {
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  const all = { ...specTable("library"), ...specTable("wrapper") };
  assert.equal(all.POLICYSQL_REQUEST_TOO_LARGE, 413);
  assert.equal(all.POLICYSQL_LIMIT_EXCEEDED, 413);
  assert.equal(statusFor("POLICYSQL_REQUEST_TOO_LARGE"), 413);
  assert.deepEqual([...REJECTIONS.get(413)].sort(), ["LIMIT_EXCEEDED", "REQUEST_TOO_LARGE", "TRANSACTION_LIMIT_EXCEEDED"]);
  // Every code the specification answers with 413 is a client rejection, none left out.
  const specified = Object.entries(all).filter(([, status]) => status === 413).map(([code]) => code.slice("POLICYSQL_".length)).sort();
  assert.deepEqual(specified, [...REJECTIONS.get(413)].sort());
});

// Rust source without its test code: `*_tests.rs`, `tests/` directories, and everything from
// a file's first inline `#[cfg(test)] mod name {` on.
const rustSource = () => files("crates", ".rs")
  .filter((path) => !/(^|[\\/])tests[\\/]|_tests\.rs$/u.test(path))
  .map((path) => [path, read(path).split(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/u)[0]]);

// ADR 0024 pull request 9: the cost codes appear only in `cost_observation_failed` records.
// Each log-only code is still produced somewhere, and only by the cost observation: core's
// `cost_estimate_json` (crates/policysql-transaction/src/cost.rs) and the executor's
// observation (src/step-effects.ts).
test("every log-only code is produced by the cost observation and by nothing else", () => {
  const where = new Set([join("crates", "policysql-transaction", "src", "cost.rs"), join("deploy/cloudflare/src", "step-effects.ts")]);
  const sources = [
    // The status module lists them only to refuse them (`LOG_ONLY_CODES`).
    ...files("deploy/cloudflare/src", ".ts")
      .filter((path) => ![join("deploy/cloudflare/src", "http", "conformance.ts"), join("deploy/cloudflare/src", "http", "status.ts")].includes(path))
      .map((path) => [path, read(path)]),
    ...rustSource(),
  ];
  for (const code of logCodes()) {
    const producers = sources.filter(([, text]) => text.includes(`"${code}"`)).map(([path]) => path);
    assert.ok(producers.length > 0, `${code} is produced somewhere`);
    for (const path of producers) assert.ok(where.has(path), `${code} is produced only by the cost observation, not ${path}`);
  }
});

test("every code in the library table is returned somewhere, so dead codes cannot creep back", () => {
  const library = specTable("library");
  // Where a code may appear without being returned: the table itself and the conformance suite.
  const excluded = new Set([join("deploy/cloudflare/src", "http", "status.ts"), join("deploy/cloudflare/src", "http", "conformance.ts")]);
  const sources = [
    ...files("deploy/cloudflare/src", ".ts").filter((path) => !excluded.has(path)).map((path) => [path, read(path)]),
    ...rustSource(),
  ];
  const emitted = new Set(sources.flatMap(([, text]) => [...text.matchAll(/"(POLICYSQL_[A-Z0-9_]+)"/gu)].map((match) => match[1])));
  // No code is reserved today; a reserved one would be marked in the specification and listed here.
  const RESERVED = new Set();
  for (const code of Object.keys(library)) {
    assert.ok(emitted.has(code) || RESERVED.has(code), `${code} is in the status table but no library or Rust source returns it`);
  }
  assert.ok(sources.some(([path]) => path.endsWith("lib.rs")), "the Rust core is scanned");
  // Non-vacuity: a removed code is not found, and a code only Rust test code names is not either.
  assert.equal(emitted.has("POLICYSQL_ACCESS_DENIED"), false);
  assert.ok(read("crates/policysql-wasm/src/lib.rs").includes('assert_eq!(unknown["error"]["code"], "POLICYSQL_INTERNAL")'));
});

// `ERROR_STATUS` and `statusFor` are public exports of `@unacowa/policysql/cloudflare`. Since ADR
// 0024 pull request 9 the log-only codes have no status (statusFor answers 500, as for any code
// outside the table), and `createErrorResponse` refuses them at every status, so a wrapper
// cannot put them into a reply.
test("the log-only codes have no status and createErrorResponse refuses them", () => {
  assert.deepEqual([...LOG_ONLY_CODES].sort(), [...logCodes()].sort(), "the adapter's set is the specification's table");
  for (const code of LOG_ONLY_CODES) {
    assert.equal(Object.hasOwn(ERROR_STATUS, code), false, code);
    assert.equal(statusFor(code), 500, code);
    for (const status of [400, 403, 429, 500, 503]) {
      assert.throws(() => createErrorResponse(status, code, "m"), TypeError, `${code} at ${status}`);
    }
  }
});

// #145: a policy `check` that fails is a definite 403 of a statement; the unknown outcomes
// (500 `POLICYSQL_OUTCOME_UNKNOWN` of a keyed execute, 503 `POLICYSQL_COMMIT_OUTCOME_UNKNOWN`) are
// never a rejection of any command, at any status.
test("CHECK_FAILED is a 403 rejection and neither unknown outcome is a rejection at any status", async () => {
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  const all = { ...specTable("library"), ...specTable("wrapper") };
  assert.equal(all.POLICYSQL_CHECK_FAILED, 403);
  assert.equal(statusFor("POLICYSQL_CHECK_FAILED"), 403);
  assert.ok(REJECTIONS.get(403).includes("CHECK_FAILED"));
  assert.equal(all.POLICYSQL_OUTCOME_UNKNOWN, 500);
  assert.equal(statusFor("POLICYSQL_OUTCOME_UNKNOWN"), 500);
  assert.equal(all.POLICYSQL_COMMIT_OUTCOME_UNKNOWN, 503);
  for (const [status, codes] of REJECTIONS) {
    for (const code of ["OUTCOME_UNKNOWN", "COMMIT_OUTCOME_UNKNOWN"]) assert.equal(codes.includes(code), false, `${code} under ${status}`);
  }
  const detail = { cause: { code: "POLICYSQL_INVALID_SQL", path: "/statements/0" } };
  for (const status of [400, 403, 409, 413, 422, 500, 502, 503, 504]) {
    const body = { error: { code: "POLICYSQL_OUTCOME_UNKNOWN", message: "m", path: null, detail, requestId: "req_1" } };
    const client = new PolicySqlClient({ transport: async () => ({ status, body }) });
    await assert.rejects(client.execute("SELECT 1"), (error) => {
      assert.ok(error instanceof PolicySqlOutcomeUnknownError, `status ${status}`);
      assert.ok(error.cause instanceof PolicySqlError);
      assert.equal(error.cause.code, "POLICYSQL_OUTCOME_UNKNOWN");
      assert.equal(error.cause.status, status);
      assert.deepEqual(error.cause.detail, detail, "the refusal reaches the application as error.cause.detail.cause");
      return true;
    });
  }
});

// #145: the list of codes a keyed outcome's cause may take is kept twice, in core (which checks an
// owner's reply) and in the Worker (which checks the reply it relays). They are one set, and
// contain the codes the engine itself puts there.
test("the Worker's cause list is core's", () => {
  const rust = read("crates/policysql-transaction/src/machine/io.rs");
  const block = rust.match(/OUTCOME_CAUSE_CODES: \[&str; (\d+)\] = \[([^\]]*)\];/u);
  assert.ok(block, "core declares OUTCOME_CAUSE_CODES");
  const core = [...block[2].matchAll(/"POLICYSQL_([A-Z0-9_]+)"/gu)].map((match) => match[1]);
  assert.equal(core.length, Number(block[1]));
  assert.equal(new Set(core).size, core.length, "no duplicates");
  assert.deepEqual([...core].sort(), [...OUTCOME_CAUSES].sort());
  for (const code of ["FORBIDDEN_ACCESS", "REQUEST_TOO_LARGE", "JSON_TOO_DEEP"]) assert.ok(OUTCOME_CAUSES.includes(code), code);
  // The OpenAPI schema lists the same codes and the same path form as the implementation.
  const openapi = read("spec/openapi.yaml");
  const schema = openapi.match(/cause:\n\s+type: object[\s\S]*?code:\n\s+type: string\n\s+enum: \[([^\]]*)\]\n\s+path:\n[^\n]*\n\s+pattern: '([^']*)'/u);
  assert.ok(schema, "the OpenAPI error detail has the cause schema");
  const documented = schema[1].split(",").map((code) => code.trim().replace(/^POLICYSQL_/u, ""));
  assert.deepEqual([...documented].sort(), [...OUTCOME_CAUSES].sort(), "OpenAPI enum is the implementation's list");
  // The path pattern accepts exactly what the implementation accepts.
  const pattern = new RegExp(schema[2], "u");
  for (const path of ["/statements/0", "/statements/12/sql", "/statements/1234567890", "/statements/01", "/statements/-1", "/statements/",
    "/statements/0/params", "/statements/0/sql/x", "/statements/12345678901", "/x", "", "/statements/0\n"]) {
    const accepted = checkedErrorDetail("POLICYSQL_OUTCOME_UNKNOWN", { cause: { code: "POLICYSQL_INVALID_SQL", path } }) !== null;
    assert.equal(pattern.test(path), accepted, `path ${JSON.stringify(path)}`);
  }
  // No code that depends on the database's state, and no outcome code, is a cause.
  for (const code of ["CONSTRAINT_VIOLATION", "CHECK_FAILED", "SCHEMA_MISMATCH", "DATABASE_TIMEOUT", "TIMEOUT",
    "OUTCOME_UNKNOWN", "COMMIT_OUTCOME_UNKNOWN", "IDEMPOTENCY_CONFLICT", "TRANSACTION_CONFLICT"]) {
    assert.equal(OUTCOME_CAUSES.includes(code), false, code);
  }
});
