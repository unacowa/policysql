import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_STATUS, LOG_ONLY_CODES, statusFor } from "../src/http/status.ts";
import { createErrorResponse } from "../src/http/responses.ts";
import { JwtAuthenticationError } from "../src/adapters/jwt.ts";

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
