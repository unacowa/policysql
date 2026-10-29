// The library receives the trusted session as data and core validates it once (ADR 0019,
// #33). These tests pass sessions directly, as a wrapper does after authentication.
import { harness } from "./helpers/routing.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const update = (name) => ({ sql: "UPDATE projects SET name = :name WHERE id = :id RETURNING id, name", params: { id: "seed", name } });
const envelope = (...statements) => ({ statements });
const tx = `tx_${"a".repeat(32)}`;

// Every authenticated client endpoint, with a body where it takes one.
const endpoints = [
  ["GET", "/v1/capabilities", undefined],
  ["GET", "/v1/catalog", undefined],
  ["POST", "/v1/transactions:explain", envelope(read)],
  ["POST", "/v1/transactions:execute", envelope(read)],
  ["POST", "/v1/transactions", { mode: "write" }],
  ["POST", `/v1/transactions/${tx}/statements`, { sequence: 1, ...read }],
  ["POST", `/v1/transactions/${tx}/commit`, { sequence: 1 }],
  ["POST", `/v1/transactions/${tx}/rollback`, { sequence: 1 }],
];

// Counts Durable Object lookups and records whether the body stream was ever read.
const probe = (h) => {
  const counts = { lookups: 0 };
  const owners = h.env.TRANSACTION_OWNER;
  const env = { ...h.env, TRANSACTION_OWNER: {
    idFromName(name) { counts.lookups++; return owners.idFromName(name); },
    get(id) { counts.lookups++; return owners.get(id); },
  } };
  const send = async (method, path, body, session, headers = {}) => {
    let pulled = false;
    const stream = body === undefined ? undefined : new ReadableStream({
      pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); },
    }, { highWaterMark: 0 });
    const request = new Request(`https://worker.test${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(stream ? { body: stream, duplex: "half" } : {}),
    });
    const response = await h.app.fetch(request, env, h.ctx, { database: h.binding("a"), session });
    return { status: response.status, body: await response.json(), pulled };
  };
  return { counts, send };
};

const malformed = (h) => {
  const valid = h.session("a");
  const without = (key) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
  return [
    ["missing session", undefined],
    ["null session", null],
    ["array session", []],
    ["string credential", "eyJhbGciOi..."],
    ...["principal", "subject", "roles", "defaultRole", "access", "session"].map((key) => [`missing ${key}`, without(key)]),
    ["unknown field", { ...valid, issuer: "https://issuer.test" }],
    ["empty principal", { ...valid, principal: "" }],
    ["numeric principal", { ...valid, principal: 7 }],
    ["empty subject", { ...valid, subject: "" }],
    ["empty roles", { ...valid, roles: [] }],
    ["duplicate roles", { ...valid, roles: ["member", "member"] }],
    ["invalid role identifier", { ...valid, roles: ["Member"], defaultRole: "Member" }],
    ["defaultRole not in roles", { ...valid, defaultRole: "admin" }],
    ["empty access", { ...valid, access: [] }],
    ["unknown access", { ...valid, access: ["execute", "admin"] }],
    ["duplicate access", { ...valid, access: ["execute", "execute"] }],
    ["reserved subject_id", { ...valid, session: { subject_id: "other" } }],
    ["reserved role", { ...valid, session: { role: "admin" } }],
    ["invalid session key", { ...valid, session: { "tenant-id": "tenant_a" } }],
    ["non-string session value", { ...valid, session: { tenant_id: 7 } }],
    ["array session values", { ...valid, session: ["tenant_a"] }],
    ["unserializable session", { ...valid, session: { tenant_id: 1n } }],
  ];
};

test("positive control: the probe observes a body read and an owner lookup for a valid session", async (t) => {
  // Guards the probes below against passing vacuously if body or owner access changes shape.
  const h = await harness(t);
  const { counts, send } = probe(h);
  const started = await send("POST", "/v1/transactions", { mode: "write" }, h.session("a"));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.pulled, true, "the body stream was pulled");
  assert.ok(counts.lookups > 0, "the transaction owner was looked up");
  assert.ok(h.counts().checks > 0, "the database binding was checked");
  const executed = await send("POST", "/v1/transactions:execute", envelope(read), h.session("a"));
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.pulled, true);
});

test("a malformed trusted session is a wrapper fault: 500 before any body read, owner lookup, or database work", async (t) => {
  const h = await harness(t);
  const { counts, send } = probe(h);
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  for (const [name, session] of malformed(h)) {
    for (const [method, path, body] of endpoints) {
      // A role header the session would not allow cannot turn a wrapper fault into a 403.
      const result = await send(method, path, body, session, { "policysql-role": "admin" });
      assert.equal(result.status, 500, `${name} ${path}: ${JSON.stringify(result.body)}`);
      assert.deepEqual(result.body.error, {
        code: "POLICYSQL_INTERNAL", message: "The request could not be completed.", path: null, requestId: result.body.error.requestId,
      });
      assert.equal(result.pulled, false, `${name} ${path}: body was read`);
    }
  }
  assert.equal(counts.lookups, 0);
  assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
  assert.equal(h.events.length, 0);
  const events = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "trusted_session_rejected");
  assert.equal(events.length, malformed(h).length * endpoints.length);
  for (const entry of events) {
    assert.deepEqual(Object.keys(entry).sort(), ["event", "fault", "requestId"]);
    assert.match(entry.fault, /^(shape|principal|subject|roles|default_role|access|session)$/);
  }
  // No session value ever reaches a log line.
  for (const value of ["tenant_a", "same_user", "issuer.test", "other", "eyJhbGciOi"]) {
    assert.equal(logs.some((line) => line.includes(value)), false, value);
  }
});

test("a role outside roles or missing endpoint access is a client-caused 403 before any body read", async (t) => {
  const h = await harness(t);
  const { counts, send } = probe(h);
  for (const [method, path, body] of endpoints) {
    for (const role of ["admin", "", "Member"]) {
      const result = await send(method, path, body, h.session("a"), { "policysql-role": role });
      assert.equal(result.status, 403, `${path} ${role}`);
      assert.equal(result.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
      assert.equal(result.pulled, false);
    }
    const repeated = await send(method, path, body, h.session("a", { roles: ["member", "reader"] }), { "policysql-role": "member, reader" });
    assert.equal(repeated.status, 400);
    assert.equal(repeated.body.error.code, "POLICYSQL_INVALID_REQUEST");
    const required = path.startsWith("/v1/transactions:explain") ? "explain" : path.endsWith("capabilities") || path.endsWith("catalog") ? "catalog" : "execute";
    const others = ["catalog", "explain", "execute", "debug"].filter((access) => access !== required);
    const denied = await send(method, path, body, h.session("a", { access: others }));
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
    assert.equal(denied.pulled, false);
  }
  assert.equal(counts.lookups, 0);
  assert.deepEqual(h.counts(), { checks: 0, connects: 0 });
});

test("the request context accepts only database, session and requestId", async (t) => {
  const h = await harness(t);
  const request = () => new Request("https://worker.test/v1/catalog");
  const ok = await h.app.fetch(request(), h.env, h.ctx, { database: h.binding("a"), session: h.session("a"), requestId: "req_wrapper_1" });
  assert.equal(ok.status, 200);
  const denied = await h.app.fetch(request(), h.env, h.ctx, {
    database: h.binding("a"), session: h.session("a", { access: ["execute"] }), requestId: "req_wrapper_2",
  });
  assert.equal((await denied.json()).error.requestId, "req_wrapper_2");
  for (const context of [
    { database: h.binding("a"), session: h.session("a"), authorization: "Bearer x" },
    { database: h.binding("a"), session: h.session("a"), requestId: "" },
    { database: h.binding("a"), session: h.session("a"), requestId: "has space" },
    { database: h.binding("a"), session: h.session("a"), requestId: 7 },
  ]) {
    const response = await h.app.fetch(request(), h.env, h.ctx, context);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL");
  }
  assert.equal(h.counts().checks, 1);
});

test("a different principal cannot continue another principal's interactive transaction", async (t) => {
  const h = await harness(t, { hooks: false });
  const owner = h.session("a");
  // Same subject, role and session values; only the wrapper-namespaced principal differs.
  const intruder = h.session("a", { principal: "https://other-issuer.test:same_user" });
  const start = await h.request("a", "/v1/transactions", { mode: "write" }, null, owner);
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const path = `/v1/transactions/${start.body.transactionId}`;
  for (const [command, body] of [["statements", { sequence: 1, ...update("Intruder") }], ["commit", { sequence: 1 }]]) {
    const result = await h.request("a", `${path}/${command}`, body, null, intruder);
    assert.equal(result.status, 409, `${command}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  }
  assert.equal(h.events.some((event) => event.sql.startsWith("UPDATE")), false);
  // The owner's own transaction is unaffected.
  assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...update("Owner") }, null, owner)).status, 200);
  assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null, owner)).status, 200);
  assert.equal(h.rows("a")[0].name, "Owner");
});

test("a different principal cannot replay or collide with another principal's idempotency key", async (t) => {
  const h = await harness(t, { hooks: false });
  const owner = h.session("a");
  const other = h.session("a", { principal: "https://other-issuer.test:same_user" });
  const key = "shared-idempotency-key";
  const updates = () => h.events.filter((event) => event.sql.startsWith("UPDATE")).length;
  const first = await h.request("a", "/v1/transactions:execute", envelope(update("First")), key, owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(updates(), 1);
  // The same principal replays without executing SQL again.
  const replay = await h.request("a", "/v1/transactions:execute", envelope(update("First")), key, owner);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.meta.requestId, first.body.meta.requestId);
  assert.equal(updates(), 1);
  // Another principal with the same key and payload executes its own request.
  const same = await h.request("a", "/v1/transactions:execute", envelope(update("First")), key, other);
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(updates(), 2);
  // And a different payload under that key is not an idempotency conflict with the owner's.
  const changed = await h.request("a", "/v1/transactions:execute", envelope(update("Second")), "other-principal-key-1", other);
  assert.equal(changed.status, 200);
  const conflict = await h.request("a", "/v1/transactions:execute", envelope(update("Third")), key, owner);
  assert.equal(conflict.status, 409);
  // Interactive start keys are scoped the same way.
  const begin = (session) => h.request("a", "/v1/transactions", { mode: "read" }, "shared-start-key-0001", session);
  const mine = await begin(owner);
  const theirs = await begin(other);
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  assert.notEqual(mine.body.transactionId, theirs.body.transactionId);
});

test("library source outside the identity adapter has no JWT, JWKS or credential dependency", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 10);
  for (const name of files) {
    const source = readFileSync(join(root, name), "utf8");
    if (name === join("adapters", "jwt.ts")) continue;
    for (const forbidden of ['from "jose"', "JWKS", "POLICYSQL_JWT_", "jwtVerify", "UNAUTHENTICATED", "AUTHENTICATION_FAILED"]) {
      assert.equal(source.includes(forbidden), false, `${name} references ${forbidden}`);
    }
    if (name !== "package.ts") assert.equal(source.includes("adapters/jwt"), false, `${name} imports the identity adapter`);
  }
});
