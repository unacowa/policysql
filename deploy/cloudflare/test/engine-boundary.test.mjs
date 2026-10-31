import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanHttp } from "./helpers/http-scan.mjs";

// Regression guard (#34, ADR 0019, ADR 0023): the engine exposes operations, not HTTP. Engine
// modules contain no HTTP status used as a status, no Request/Response/Headers/Hono, no HTTP
// header name, and no route. Every library module is an engine module unless it is listed
// here, with the reason it may speak HTTP. A new module is an engine module by default.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const NOT_ENGINE = new Map([
  ["http/adapter.ts", "inbound adapter: routes, headers, status"],
  ["http/body.ts", "inbound adapter: Content-Type, Content-Length, streamed size, UTF-8 decoding"],
  ["http/responses.ts", "inbound adapter: fixed headers, error shape, ETag / 304"],
  ["http/routes.ts", "inbound adapter: the public routes"],
  ["http/status.ts", "inbound adapter: the only status table"],
  ["http/conformance.ts", "inbound adapter test support: the HTTP conformance suite"],
  ["adapters/durable-objects.ts", "outbound adapter: the owner wire"],
  ["adapters/commit-check-hook.ts", "outbound adapter: the signed validator call"],
  ["adapters/jwt.ts", "identity adapter: bearer credentials"],
  ["turso-http.ts", "outbound adapter: the Turso HTTP database"],
  ["redirects.ts", "outbound HTTP exit: no-follow fetch"],
  ["bounded-body.ts", "outbound HTTP: streamed, byte-bounded response body (#53)"],
  ["worker.ts", "Workers assembly: engine plus HTTP adapter"],
  ["package.ts", "Workers assembly: the published entry point"],
  ["modules.d.ts", "bundler module declarations"],
]);
const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts")).map((name) => name.split("\\").join("/"));
const engine = files.filter((name) => !NOT_ENGINE.has(name));
const scan = (name) => scanHttp(name, readFileSync(join(root, name), "utf8"));

test("engine modules contain no HTTP status, Request/Response, header name, or route", () => {
  for (const name of NOT_ENGINE.keys()) assert.ok(existsSync(join(root, name)), `${name} is listed but does not exist`);
  for (const name of ENGINE_MODULES) assert.ok(engine.includes(name), `${name} is scanned as an engine module`);
  assert.deepEqual(engine.flatMap(scan), [], "map HTTP in src/http/, outbound HTTP in an adapter");
});

const ENGINE_MODULES = ["engine.ts", "app.ts", "request-body.ts", "errors.ts", "session.ts", "core-identity.ts",
  "transaction-owner.ts", "transaction-owner-port.ts", "request-step.ts", "step-effects.ts", "database.ts",
  "driver-values.ts", "presenters.ts"];

// ADR 0011 and ADR 0024 pull request 9: no TypeScript decides a transaction outcome. Core
// (`step_json`) answers every outcome the specification determines; an engine module names
// only POLICYSQL_INTERNAL and the codes of the adapter classes it reports, each listed with its
// reason. A decision code (a conflict, an unavailable or expired transaction, a commit check
// verdict, an idempotency answer, an expectation, a transaction limit, an unknown commit
// outcome) in an engine module fails this test.
const ENGINE_CODES = new Map([
  ["POLICYSQL_INTERNAL", "a fault of the engine or of its inputs"],
  ["POLICYSQL_INVALID_REQUEST", "request framing checked before core (ADR 0023 order), and the begin body checks that stay in the engine while interactive commands have no `request` kind (ADR 0024 pull request 7)"],
  ["POLICYSQL_REQUEST_TOO_LARGE", "the request byte limit, checked before the body is read"],
  ["POLICYSQL_STALE_OPERATION", "a binding or begin precondition naming another snapshot, checked before core"],
  ["POLICYSQL_DATABASE_REQUIRED", "database adapter class: the wrapper supplied no provider"],
  ["POLICYSQL_DATABASE_BINDING_REJECTED", "database adapter class: the provider rejected the binding"],
  ["POLICYSQL_DATABASE_UNAVAILABLE", "database adapter class: the provider or transport failed"],
  ["POLICYSQL_DATABASE_TIMEOUT", "database adapter class: the deadline passed"],
  ["POLICYSQL_LIMIT_EXCEEDED", "database adapter class: a value or response over the transport's byte bound"],
  ["POLICYSQL_SCHEMA_MISMATCH", "driver codec: a driver value the codec cannot carry"],
  ["POLICYSQL_COST_ADMISSION_UNAVAILABLE", "a cost observation log record whose connection failed; never a reply"],
]);

const codesNamed = (text) => new Set([...text.matchAll(/"(POLICYSQL_[A-Z0-9_]+)"/gu)].map((match) => match[1]));

test("engine modules name no POLICYSQL_* code but POLICYSQL_INTERNAL and adapter-class codes", () => {
  for (const name of engine) {
    const named = [...codesNamed(readFileSync(join(root, name), "utf8"))].filter((code) => !ENGINE_CODES.has(code));
    assert.deepEqual(named, [], `${name} names a code core decides; return core's answer instead`);
  }
  // Non-vacuity: the scanned modules do name adapter-class codes, and a decision code is caught.
  const all = new Set(engine.flatMap((name) => [...codesNamed(readFileSync(join(root, name), "utf8"))]));
  for (const code of ["POLICYSQL_INTERNAL", "POLICYSQL_DATABASE_UNAVAILABLE", "POLICYSQL_SCHEMA_MISMATCH"]) assert.ok(all.has(code), code);
  for (const code of ["POLICYSQL_TRANSACTION_CONFLICT", "POLICYSQL_COMMIT_CHECK_REJECTED", "POLICYSQL_IDEMPOTENCY_CONFLICT"]) {
    assert.ok(codesNamed(`throw new EngineError("${code}", "m");`).has(code));
    assert.equal(ENGINE_CODES.has(code), false, code);
  }
});

test("the HTTP adapter is where these forms live, so the scan sees real code", () => {
  const kinds = new Set(["http/adapter.ts", "http/responses.ts", "http/routes.ts", "http/body.ts", "http/status.ts",
    "adapters/durable-objects.ts"].flatMap(scan).map((finding) => finding.kind));
  assert.deepEqual([...kinds].sort(), ["header-name", "http-type", "route", "status"]);
});

test("the scan catches each form and ignores comments and unrelated numbers", () => {
  const caught = [
    ["new Response(null, { status: 304 });", "http-type"],
    ["const r = Response.json({});", "http-type"],
    ["const f = (r: Request) => r;", "http-type"],
    ["const h = new Headers();", "http-type"],
    ['import { Hono } from "hono";', "http-type"],
    ['import { createMiddleware } from "hono/factory";', "http-type"],
    ["const reply = { status: 201, body: {} };", "status"],
    ['const reply = { "status": 409 };', "status"],
    ["if (reply.status === 404) {}", "status"],
    ["if (500 <= response.status) {}", "status"],
    ["reply.status = 503;", "status"],
    ['throw new HttpError(409, "POLICYSQL_X", "m");', "status"],
    ['return jsonResponse(body, 201);', "status"],
    ['return withStatus(429);', "status"],
    ['const name = "Content-Type";', "header-name"],
    ['headers.get("idempotency-key");', "header-name"],
    ["const name = `policysql-role`;", "header-name"],
    ['const url = "/v1/catalog";', "route"],
    ["const url = `${base}/v1/transactions/${id}/commit`;", "route"],
    ['const path = "/healthz";', "route"],
  ];
  for (const [text, kind] of caught) {
    assert.ok(scanHttp("sample.ts", text).some((finding) => finding.kind === kind), `${kind}: ${text}`);
  }
  const allowed = [
    "// new Response(null, { status: 304 }) and /v1/catalog in a comment",
    'const state = { status: "active" };',
    "if (rowsReturned > 100) {}",
    "const timeoutMs = 1_000; const depth = 64; const MAX = 512;",
    'const event = "request_rejected";',
    "const sameStatus = current.status === previous.status;",
    "const id = setTimeout(run, 500);",
  ];
  for (const text of allowed) assert.deepEqual(scanHttp("sample.ts", text), [], text);
});

// ADR 0027 ("No other byte constant may exist on the request path"): a request limit is a
// RuntimeLimits field the runtime reports (src/limits.ts), a fixed protocol constant listed
// here with its reason, or a bound computed by core. A numeric expression of 1,000 or more in
// `src/` that is not listed fails the test, so a new byte (or count) limit cannot appear as a
// private constant in the engine or an adapter. Literals are read with comments and string
// contents removed. Forms read: decimal with `_` and exponent (`1e6`), hex, octal, binary, and
// chains joined by `*`, `**`, `<<`, `+`, `-` (`1024 * 1024`, `1 << 20`, `2 ** 16`).
//
// Each entry is keyed by the identifier next to the expression ("context": the last word before
// it, `CONTROL_RESPONSE_BYTES`, `timeoutMs`, `min`) and its value, with how many times it occurs,
// so a second 65_536 under another name, or a third use under the same one, fails.
const FIXED_LITERALS = new Map([
  ["turso-http.ts", new Map([
    ["STATEMENT_RESPONSE_BYTES:2097152", [1, "the statement reply bound: result side, replaced by the compiled raw bound in ADR 0027 pull request 6"]],
    ["CONTROL_RESPONSE_BYTES:65536", [1, "the database control reply bound (BEGIN, COMMIT, ROLLBACK, close): a fixed protocol constant"]],
    ["timeoutMs:1000", [1, "default request timeout, in milliseconds (a time, not a size)"]],
    ["INT64_MIN:9223372036854776000", [1, "the signed 64-bit integer range of Hrana (2n ** 63n), not a limit"]],
    ["INT64_MAX:9223372036854776000", [1, "the signed 64-bit integer range of Hrana (2n ** 63n - 1n), not a limit"]],
  ])],
  ["adapters/commit-check-hook.ts", new Map([
    ["VALIDATOR_RESPONSE_BYTES:65536", [1, "the validator reply bound: a fixed protocol constant"]],
    ["now:1000", [1, "milliseconds per second, for the signature timestamp"]],
  ])],
  ["database.ts", new Map([
    ["now:1000", [1, "the provider timeout, in milliseconds (a time, not a size)"]],
    ["remaining:1000", [1, "the same timeout, compared with the time left"]],
    ["min:1000", [1, "the same timeout, as an upper bound for the timer"]],
  ])],
  ["adapters/jwt.ts", new Map([
    ["timeoutDuration:1500", [1, "JWKS timeout, in milliseconds"]],
    ["cooldownDuration:30000", [1, "JWKS cooldown, in milliseconds"]],
    ["cacheMaxAge:300000", [1, "JWKS cache age, in milliseconds"]],
  ])],
  // The recording engine of the conformance suite is a test double with limits of its own.
  ["http/conformance.ts", new Map([
    ["maxRequestBytes:4096", [1, "the double's request limit"]],
    ["maxJsonValues:1024", [1, "the double's value limit"]],
  ])],
]);

const stripped = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1")
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, '""');
const NUMBER = String.raw`(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?`;
const CHAIN = new RegExp(String.raw`(?<![\w.$])(${NUMBER}(?:\s*(?:\*\*|<<|\*|\+|-)\s*${NUMBER})*)(?![\w.$])`, "gu");
const valueOf = (expression) => {
  // The expression holds only numbers and the operators above, so evaluating it is safe.
  const cleaned = expression.replaceAll("_", "").replace(/(\d)n\b/gu, "$1");
  return Number(Function(`"use strict"; return (${cleaned});`)());
};
/** The numeric expressions of 1,000 or more, as `context:value` (context: the last word before it). */
const largeLiterals = (text) => {
  const code = stripped(text);
  return [...code.matchAll(CHAIN)].flatMap((match) => {
    const value = valueOf(match[1]);
    if (!(value >= 1_000)) return [];
    const before = code.slice(0, match.index).match(/([A-Za-z_$][\w$]*)[\s:=<>!+\-*/,()\]]*$/u);
    return [`${before?.[1] ?? ""}:${value}`];
  });
};
const tally = (items) => items.reduce((counts, item) => counts.set(item, (counts.get(item) ?? 0) + 1), new Map());

test("no byte or count limit literal is left in src/ outside the fixed protocol constants", () => {
  for (const name of files) {
    const allowed = FIXED_LITERALS.get(name) ?? new Map();
    const found = tally(largeLiterals(readFileSync(join(root, name), "utf8")));
    const unlisted = [...found].filter(([key, count]) => (allowed.get(key)?.[0] ?? 0) !== count).map(([key, count]) => `${key} x${count}`);
    assert.deepEqual(unlisted, [], `${name}: a limit is a RuntimeLimits field, a fixed protocol constant listed here, or computed by core (ADR 0027)`);
  }
  // Every listed constant is still present, as often as listed: the list cannot go stale.
  for (const [name, allowed] of FIXED_LITERALS) {
    const found = tally(largeLiterals(readFileSync(join(root, name), "utf8")));
    for (const [key, [count]] of allowed) assert.equal(found.get(key) ?? 0, count, `${name}: ${key}`);
  }
});

test("the literal scan catches every numeric form of a limit and ignores comments, strings, and small numbers", () => {
  for (const text of [
    "const MAX = 1_048_576;", "if (n > 65536) {}", "const limit = 2097152", "x.length > 262_144", "const b = 1024 * 1024;",
    "const h = 0x10000;", "const h = 0XFFFF_FFFF;", "const e = 1e6;", "const e = 2.5e3;", "const s = 1 << 20;", "const p = 2 ** 16;",
    "const q = 256 * 256;", "const r = 64 * 1_024;", "const o = 0o200000;", "const b2 = 0b10000000000;", "const big = 1048576n;",
    "const sum = 1000 + 24;",
  ]) {
    assert.ok(largeLiterals(text).length > 0, text);
  }
  assert.deepEqual(largeLiterals("const MAX_BODY = 1 << 20;"), ["MAX_BODY:1048576"]);
  assert.deepEqual(largeLiterals("const CAP = 256 * 256;"), ["CAP:65536"]);
  assert.deepEqual(largeLiterals("const CAP = 0x10000;"), ["CAP:65536"]);
  for (const text of [
    "// 1_048_576 in a comment", "/* 65536 */ const a = 1;", 'const message = "limit 65_536";', "const depth = 64; const id = 128;",
    "v1.2.3000", "const mask = 0xff; const k = 1 << 4; const t = 16 * 16;", "const e = 5e2;", "const x = a.b3000;",
  ]) {
    assert.deepEqual(largeLiterals(text), [], text);
  }
  // A second use of an allowed value under another name, or twice under one name, is not allowed.
  const allowed = FIXED_LITERALS.get("turso-http.ts");
  const second = tally(largeLiterals("const CONTROL_RESPONSE_BYTES = 65_536; const OTHER = 65_536;"));
  assert.equal(allowed.has("OTHER:65536"), false);
  assert.equal(second.get("OTHER:65536"), 1);
  assert.equal(tally(largeLiterals("const CONTROL_RESPONSE_BYTES = 65_536; const CONTROL_RESPONSE_BYTES = 0x10000;")).get("CONTROL_RESPONSE_BYTES:65536"), 2);
});
