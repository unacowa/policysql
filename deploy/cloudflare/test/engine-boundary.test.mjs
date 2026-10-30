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
  ["worker.ts", "Workers assembly: engine plus HTTP adapter"],
  ["package.ts", "Workers assembly: the published entry point"],
  ["modules.d.ts", "bundler module declarations"],
]);
const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts")).map((name) => name.split("\\").join("/"));
const engine = files.filter((name) => !NOT_ENGINE.has(name));
const scan = (name) => scanHttp(name, readFileSync(join(root, name), "utf8"));

test("engine modules contain no HTTP status, Request/Response, header name, or route", () => {
  for (const name of NOT_ENGINE.keys()) assert.ok(existsSync(join(root, name)), `${name} is listed but does not exist`);
  for (const name of ["engine.ts", "app.ts", "request-body.ts", "errors.ts", "session.ts", "core-identity.ts",
    "transaction-owner.ts", "transaction-owner-port.ts", "commit-checks.ts", "database.ts", "turso.ts", "cost.ts", "presenters.ts"]) {
    assert.ok(engine.includes(name), `${name} is scanned as an engine module`);
  }
  assert.deepEqual(engine.flatMap(scan), [], "map HTTP in src/http/, outbound HTTP in an adapter");
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
