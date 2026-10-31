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
// here with its reason, or a bound computed by core. A numeric literal of 1,000 or more in
// `src/` that is not listed fails the test, so a new byte (or count) limit cannot appear as a
// private constant in the engine or an adapter. Literals are read with comments and string
// contents removed.
const FIXED_LITERALS = new Map([
  ["turso-http.ts", new Map([
    ["2_097_152", "the statement reply bound: result side, replaced by the compiled raw bound in ADR 0027 pull request 6"],
    ["65_536", "the database control reply bound (BEGIN, COMMIT, ROLLBACK, close): a fixed protocol constant"],
    ["1_000", "default request timeout, in milliseconds (a time, not a size)"],
  ])],
  ["adapters/commit-check-hook.ts", new Map([
    ["65_536", "the validator reply bound: a fixed protocol constant"],
    ["1000", "seconds per millisecond, for the signature timestamp"],
  ])],
  ["database.ts", new Map([["1_000", "the provider timeout, in milliseconds (a time, not a size)"]])],
  ["adapters/jwt.ts", new Map([
    ["1_500", "JWKS timeout, in milliseconds"], ["30_000", "JWKS cooldown, in milliseconds"], ["300_000", "JWKS cache age, in milliseconds"],
  ])],
  // The recording engine of the conformance suite is a test double with limits of its own.
  ["http/conformance.ts", new Map([["4_096", "the double's request limit"], ["1_024", "the double's value limit"]])],
]);

const stripped = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1")
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, '""');
const largeLiterals = (text) => [...stripped(text).matchAll(/(?<![\w.$])(\d[\d_]*)(?![\w.])/gu)]
  .map((match) => match[1])
  .filter((literal) => Number(literal.replaceAll("_", "")) >= 1_000);

test("no byte or count limit literal is left in src/ outside the fixed protocol constants", () => {
  for (const name of files) {
    const allowed = FIXED_LITERALS.get(name) ?? new Map();
    const unlisted = largeLiterals(readFileSync(join(root, name), "utf8")).filter((literal) => !allowed.has(literal));
    assert.deepEqual(unlisted, [], `${name}: a limit is a RuntimeLimits field, a fixed protocol constant listed here, or computed by core (ADR 0027)`);
  }
  // Every listed constant is still present: the list cannot go stale.
  for (const [name, allowed] of FIXED_LITERALS) {
    const present = new Set(largeLiterals(readFileSync(join(root, name), "utf8")));
    for (const literal of allowed.keys()) assert.ok(present.has(literal), `${name} no longer holds ${literal}`);
  }
});

test("the literal scan catches a private limit and ignores comments, strings, and small numbers", () => {
  for (const text of ["const MAX = 1_048_576;", "if (n > 65536) {}", "const limit = 2097152", "x.length > 262_144", "const b = 1024 * 1024;"]) {
    assert.ok(largeLiterals(text).length > 0, text);
  }
  for (const text of ["// 1_048_576 in a comment", "/* 65536 */ const a = 1;", 'const message = "limit 65_536";', "const depth = 64; const id = 128;", "v1.2.3000"]) {
    assert.deepEqual(largeLiterals(text), [], text);
  }
});
