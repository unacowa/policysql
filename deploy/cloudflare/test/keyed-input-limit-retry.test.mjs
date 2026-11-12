// #100: a keyed atomic write that committed, then a deployment that lowers or tightens an
// input-side limit before the body reaches compile. The retry may be the retry of a write whose
// COMMIT was sent, so it must never be an answer the client takes as a definite rejection
// (ADR 0007): `maxRequestBytes` and `maxJsonValues` can be lowered, and the body depth limit
// tightened from accepting 65 nested containers to 64 (ADR 0027 pull request 7). The answer is
// 500 POLICYSQL_OUTCOME_UNKNOWN (the unknown outcome, the refusal as `detail.cause`, #145) on
// both placements, the body read stays bounded
// by the current limit, nothing is looked up, replayed, executed, committed, or consumed, and a
// later deployment whose limits accept the request replays the stored result. A rejection that
// was invalid under every deployment (malformed JSON, a duplicate key, a lone surrogate, a
// missing body, invalid UTF-8, a wrong content type) stays definite, as does a request without
// a key or with a malformed one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countJsonValues } from "../scripts/lib/cpu-shapes.mjs";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";
import { REJECTIONS } from "../../../packages/client/protocol.js";

const read = (name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed(db, tenant) {
    const insert = db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
    insert.run("seed", `tenant_${tenant}`, "visible", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
  },
  callbackQuery: { sql: "SELECT id FROM projects WHERE state=:state", params: { state: "AAEC/w==" } },
};
const REQUIRED = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const EXECUTE = "/v1/transactions:execute";
const MIB = 1_048_576;
const INSERT_STATE = "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING id";
const INSERT_METADATA = "INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata) RETURNING id";
const insertWithState = (id, name) => ({ sql: INSERT_STATE, params: { id, name, state: null } });
const insertWithMetadata = (id, metadata) => ({ sql: INSERT_METADATA, params: { id, name: "n", state: null, metadata } });
const bytesOf = (text) => new TextEncoder().encode(text).byteLength;
const commits = (h) => h.events.filter(({ sql }) => sql === "COMMIT").length;
const rowCount = (h, id) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM projects WHERE id = ?").get(id).n;
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;

// The work a request caused: statements run (a lookup and a COMMIT included), connections,
// commit checks, and owner forwards. A body refused before the step machine does none of them.
const work = (h) => ({
  events: h.events.length, checks: h.hooksSeen.length, connects: h.counts().connects,
  commits: commits(h), rows: idempotencyRows(h),
  owners: [...h.ownerNames()],
  inputs: Object.fromEntries(h.ownerNames().map((name) => [name, h.ownerInputs(name).length])),
});
const unchanged = (h, before, label) => {
  assert.equal(h.events.length, before.events, `${label}: no database statement ran`);
  assert.equal(h.hooksSeen.length, before.checks, `${label}: no commit check`);
  assert.equal(h.counts().connects, before.connects, `${label}: no connection`);
  assert.equal(commits(h), before.commits, `${label}: no COMMIT`);
  assert.equal(idempotencyRows(h), before.rows, `${label}: no idempotency row was written or consumed`);
  assert.deepEqual(h.ownerNames(), before.owners, `${label}: no owner was created`);
  for (const name of before.owners) assert.equal(h.ownerInputs(name).length, before.inputs[name], `${label}: nothing was forwarded to ${name}`);
};
const unknown = (response, label, causeCode = "POLICYSQL_REQUEST_TOO_LARGE") => {
  assert.equal(response.status, 500, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`);
  assert.equal(response.body.error.code, "POLICYSQL_OUTCOME_UNKNOWN", label);
  assert.equal(response.body.error.message, "This request was not executed. The outcome of an earlier request with the same Idempotency-Key is unknown.", label);
  assert.equal(response.body.error.path, null, label);
  assert.deepEqual(response.body.error.detail, { cause: { code: causeCode, path: null } }, label);
  assert.deepEqual(Object.keys(response.body), ["error"], `${label}: no stored result, trace, or internal field`);
  assert.equal(response.body.results, undefined, `${label}: the stored result is not returned`);
  assert.equal(response.body.debug, undefined, `${label}: no trace is returned`);
};
const definite = (response, status, code, label) => {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`);
  assert.equal(response.body.error.code, code, label);
  assert.equal(response.body.error.detail, undefined, `${label}: no detail`);
  assert.equal(response.body.results, undefined, `${label}: no result`);
};

// An independent canonical JSON for the values this test plants: keys sorted, arrays in order,
// numbers and strings as JSON.stringify writes them. Every member here is ASCII and an integer,
// so this equals core's canonical form; the test checks it against the row core wrote.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

for (const ownerAdapter of OWNER_ADAPTERS) {
  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}/${placement}: #100 a keyed write retried after maxRequestBytes is lowered is unknown, then replays`, async (t) => {
      const logs = [];
      t.mock.method(console, "log", (line) => { logs.push(String(line)); });
      const limits = { ...REQUIRED, maxRequestBytes: MIB };
      const h = await harness(t, { ownerAdapter, hooks, fixture, runtimeLimits: limits });
      const key = `lowered-bytes-${placement}-0001`;
      const name = "x".repeat(200_000);
      const body = { statements: [insertWithState("lowered_bytes", name)] };
      assert.ok(bytesOf(JSON.stringify(body)) > 65_536 && bytesOf(JSON.stringify(body)) <= MIB);
      const first = await h.request("a", EXECUTE, body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
      assert.equal(rowCount(h, "lowered_bytes"), 1);
      assert.equal(idempotencyRows(h), 1);
      const before = work(h);
      const snapshot = h.runtime.snapshot;

      // The deploy lowers the request limit below this body. The snapshot does not change
      // (limits are not part of it), so the retry reaches the body read.
      limits.maxRequestBytes = 65_536;
      h.redeploy({});
      assert.equal(h.runtime.snapshot, snapshot, "a limit change does not change the snapshot");
      const retry = await h.request("a", EXECUTE, body, key);
      unknown(retry, "lowered maxRequestBytes");
      // The log keeps both facts: the body limit (`keyed_body_limit_unknown`) and the refusal the
      // keyed answer hid (`request_rejected.cause`).
      const events = logs.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
      assert.ok(events.some((event) => event.event === "keyed_body_limit_unknown"), "the body-limit event");
      const rejected = events.filter((event) => event.event === "request_rejected").at(-1);
      assert.equal(rejected.code, "POLICYSQL_OUTCOME_UNKNOWN");
      assert.deepEqual(rejected.cause, { code: "POLICYSQL_REQUEST_TOO_LARGE", path: null });
      unchanged(h, before, "lowered maxRequestBytes");
      assert.equal(rowCount(h, "lowered_bytes"), 1, "never executed twice");

      // Bypass controls under the lowered limit: a fresh key is unknown too (an absent row is
      // not proof that no commit happened), while no key and a malformed key keep the definite
      // 413 and run nothing.
      unknown(await h.request("a", EXECUTE, { statements: [insertWithState("lowered_fresh", name)] }, `lowered-bytes-fresh-${placement}-01`), "fresh key");
      definite(await h.request("a", EXECUTE, { statements: [insertWithState("lowered_unkeyed", name)] }, null),
        413, "POLICYSQL_REQUEST_TOO_LARGE", "unkeyed");
      definite(await h.request("a", EXECUTE, { statements: [insertWithState("lowered_malformed", name)] }, "short"),
        413, "POLICYSQL_REQUEST_TOO_LARGE", "malformed key");
      for (const id of ["lowered_fresh", "lowered_unkeyed", "lowered_malformed"]) assert.equal(rowCount(h, id), 0, id);
      unchanged(h, before, "controls");

      // The client takes the 500 as an unknown outcome and the unkeyed 413 as a rejection.
      const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
      const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
      await assert.rejects(client.execute(INSERT_STATE, { id: "lowered_client", name, state: null }, { idempotencyKey: "lowered-bytes-client-key-001" }),
        PolicySqlOutcomeUnknownError);
      await assert.rejects(client.execute(INSERT_STATE, { id: "lowered_client_unkeyed", name, state: null }), (error) => {
        assert.ok(error instanceof PolicySqlError);
        assert.equal(error instanceof PolicySqlOutcomeUnknownError, false, "a definite rejection");
        assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE");
        assert.equal(error.status, 413);
        return true;
      });
      assert.equal(REJECTIONS.get(500), undefined, "no code of a 500 is a rejection");
      assert.ok(REJECTIONS.get(413).includes("REQUEST_TOO_LARGE"), "413 stays definite");
      for (const id of ["lowered_client", "lowered_client_unkeyed"]) assert.equal(rowCount(h, id), 0, id);
      unchanged(h, before, "client");

      // A deploy that restores the limit replays the response stored with the COMMIT.
      limits.maxRequestBytes = MIB;
      h.redeploy({});
      const replay = await h.request("a", EXECUTE, body, key);
      assert.equal(replay.status, 200, JSON.stringify(replay.body).slice(0, 300));
      assert.deepEqual(replay.body.results, first.body.results);
      assert.equal(replay.body.transactionId, first.body.transactionId);
      assert.equal(commits(h), before.commits, "no second COMMIT");
      assert.equal(rowCount(h, "lowered_bytes"), 1, "never executed twice");
      assert.equal(idempotencyRows(h), 1);
    });

    test(`${ownerAdapter}/${placement}: #100 a keyed write retried after maxJsonValues is lowered is unknown, then replays`, async (t) => {
      t.mock.method(console, "log", () => {});
      const limits = { ...REQUIRED, maxRequestBytes: 2_097_152, maxJsonValues: 131_072 };
      const h = await harness(t, { ownerAdapter, hooks, fixture, runtimeLimits: limits });
      const key = `lowered-values-${placement}-001`;
      const metadata = Array.from({ length: 30_000 }, () => 1);
      const body = { statements: [insertWithMetadata("lowered_values", metadata)] };
      const text = JSON.stringify(body);
      const values = countJsonValues(JSON.parse(text));
      assert.ok(values > 1_024 && values < 131_072, `${values} values`);
      assert.ok(bytesOf(text) < 2_097_152);
      const first = await h.request("a", EXECUTE, body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
      assert.equal(rowCount(h, "lowered_values"), 1);
      const before = work(h);

      // The deploy lowers the value limit below this body.
      limits.maxJsonValues = 1_024;
      h.redeploy({});
      const retry = await h.request("a", EXECUTE, body, key);
      unknown(retry, "lowered maxJsonValues");
      unchanged(h, before, "lowered maxJsonValues");
      assert.equal(rowCount(h, "lowered_values"), 1);

      // A fresh key is unknown; no key and a malformed key keep the definite 413.
      unknown(await h.request("a", EXECUTE, { statements: [insertWithMetadata("lowered_values_fresh", metadata)] }, `lowered-values-fresh-${placement}-1`), "fresh key");
      definite(await h.request("a", EXECUTE, { statements: [insertWithMetadata("lowered_values_unkeyed", metadata)] }, null),
        413, "POLICYSQL_REQUEST_TOO_LARGE", "unkeyed");
      definite(await h.request("a", EXECUTE, { statements: [insertWithMetadata("lowered_values_malformed", metadata)] }, "short"),
        413, "POLICYSQL_REQUEST_TOO_LARGE", "malformed key");
      for (const id of ["lowered_values_fresh", "lowered_values_unkeyed", "lowered_values_malformed"]) assert.equal(rowCount(h, id), 0, id);
      unchanged(h, before, "controls");

      limits.maxJsonValues = 131_072;
      h.redeploy({});
      const replay = await h.request("a", EXECUTE, body, key);
      assert.equal(replay.status, 200, JSON.stringify(replay.body).slice(0, 300));
      assert.deepEqual(replay.body.results, first.body.results);
      assert.equal(replay.body.transactionId, first.body.transactionId);
      assert.equal(commits(h), before.commits);
      assert.equal(rowCount(h, "lowered_values"), 1);
    });

    // A body 65 levels deep was accepted by the engine scan before ADR 0027 pull request 7
    // (`depth > 64` with the root at 0), so a pre-ABI-16 deployment can have committed it. The
    // current check rejects it before compile; the retry must still be unknown. A current
    // deployment cannot commit the 65-level body, so the row is planted as the earlier release
    // would have stored it: first a real commit under the same key proves the fingerprint this
    // test computes equals core's, then its fingerprint is moved to the 65-level body.
    test(`${ownerAdapter}/${placement}: #100 a keyed depth-65 retry is unknown, not definite, for a row a pre-ABI-16 deployment could have written`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await harness(t, { ownerAdapter, hooks, fixture, runtimeLimits: REQUIRED });
      const database = h.databases.get("a").database;
      const deepBody = (id, wrappers) => {
        let metadata = { leaf: true };
        for (let index = 0; index < wrappers; index += 1) metadata = { a: metadata };
        const text = JSON.stringify({ statements: [insertWithMetadata(id, metadata)] });
        return { text, body: JSON.parse(text) };
      };
      // Root 1, statements 2, statement 3, params 4, metadata 5: 59 wrappers reach level 64
      // (accepted now), 60 reach 65 (accepted by the old scan, rejected now).
      const accepted = deepBody("depth_64", 59);
      const acceptedKey = `depth-accepted-${placement}-01`;
      const served = await h.request("a", EXECUTE, new RawJson(accepted.text), acceptedKey);
      assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 300));
      assert.equal(rowCount(h, "depth_64"), 1, "the 64-level body is real and valid");
      const deep = deepBody("depth_65", 60);

      // The independent canonical form and hashes agree with what core wrote for the real row.
      const auth = JSON.parse(h.runtime.authorize_session_json(JSON.stringify(h.session("a")), undefined, "execute")).auth;
      const binding = h.binding("a");
      const identity = canonical({
        principal: auth.principal, subject: auth.subject, role: auth.role, session: auth.session,
        endpoint: "execute", database: { scope: binding.scope, databaseId: binding.databaseId },
      });
      const fingerprintOf = (text) => sha256(`${identity}:${canonical(JSON.parse(text))}:${canonical({
        version: binding.version, scope: binding.scope, databaseId: binding.databaseId, generation: binding.generation,
      })}`);
      const acceptedRow = database.prepare("SELECT fingerprint FROM policysql_idempotency WHERE key_hash = ?")
        .get(sha256(`${identity}:${acceptedKey}`));
      assert.ok(acceptedRow, "the accepted key has its row");
      assert.equal(acceptedRow.fingerprint, fingerprintOf(accepted.text), "the test's canonical form and fingerprint equal core's");

      // A real commit under the key the 65-level retry uses, then the row a pre-ABI-16
      // deployment would have left: the same key and fingerprint, and a stored response.
      const key = `depth-keyed-${placement}-0001`;
      const planted = deepBody("depth_planted", 59);
      const first = await h.request("a", EXECUTE, new RawJson(planted.text), key);
      assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
      const keyHash = sha256(`${identity}:${key}`);
      const row = database.prepare("SELECT fingerprint FROM policysql_idempotency WHERE key_hash = ?").get(keyHash);
      assert.equal(row.fingerprint, fingerprintOf(planted.text));
      database.prepare("UPDATE policysql_idempotency SET fingerprint = ? WHERE key_hash = ?").run(fingerprintOf(deep.text), keyHash);
      assert.equal(idempotencyRows(h), 2);
      const before = work(h);
      assert.equal(database.prepare("SELECT fingerprint FROM policysql_idempotency WHERE key_hash = ?").get(keyHash).fingerprint, fingerprintOf(deep.text));

      // The retry is unknown: the matching row is not looked up, replayed, or consumed.
      const retry = await h.request("a", EXECUTE, new RawJson(deep.text), key);
      unknown(retry, "depth 65", "POLICYSQL_JSON_TOO_DEEP");
      unchanged(h, before, "depth 65");
      assert.equal(rowCount(h, "depth_65"), 0, "the write is not executed under the new limit");
      assert.equal(database.prepare("SELECT fingerprint FROM policysql_idempotency WHERE key_hash = ?").get(keyHash).fingerprint,
        fingerprintOf(deep.text), "the row is untouched");

      // Definite controls: the same depth without a key, and the non-execute routes, keep 400
      // (interactive commands are #104, not this fix).
      definite(await h.request("a", EXECUTE, new RawJson(deep.text), null), 400, "POLICYSQL_JSON_TOO_DEEP", "unkeyed");
      unchanged(h, before, "unkeyed");
      const nested = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
      definite(await h.request("a", "/v1/transactions", new RawJson(`{"mode":"read","deep":${nested(64)}}`), "depth-begin-key-000001"),
        400, "POLICYSQL_JSON_TOO_DEEP", "keyed begin");
      definite(await h.request("a", "/v1/transactions:explain", new RawJson(deep.text)), 400, "POLICYSQL_JSON_TOO_DEEP", "explain");
      unchanged(h, before, "other routes");
      // There is no deployment in this build that accepts depth 65, so unlike the lowered size
      // and value limits there is no replay step to test; the row above is what a deployment
      // with the old depth would replay, and it is left exactly as it was.
    });
  }

  // The distinction the fix must not blur: only the rejections whose answer depends on the
  // deployment become unknown. A keyed body that was invalid under every deployment (syntax, a
  // duplicate key, a lone surrogate, a number outside the finite range, invalid UTF-8) keeps its
  // definite 400, runs nothing, and does not consume the key.
  test(`${ownerAdapter}: #100 keyed bodies that were invalid under every deployment stay definite`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false, fixture, runtimeLimits: REQUIRED });
    const before = work(h);
    const key = "always-invalid-body-key-1";
    const post = async (body) => {
      const request = new Request("https://worker.test/v1/transactions:execute", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: body instanceof RawJson ? body.text : body,
      });
      const response = await h.app.fetch(request, { database: h.binding("a"), session: h.session("a") }, h.background);
      return { status: response.status, body: await response.json() };
    };
    const cases = [
      ["malformed JSON", new RawJson('{"statements":[')],
      ["a number outside the finite range", new RawJson('{"statements":[],"n":1e400}')],
      ["an escaped lone surrogate", new RawJson('{"statements":[],"s":"\\ud800"}')],
      ["a duplicate key", new RawJson('{"statements":[],"statements":[]}')],
      ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ];
    for (const [label, body] of cases) definite(await post(body), 400, "POLICYSQL_INVALID_REQUEST", label);
    unchanged(h, before, "always-invalid keyed bodies");
  });

  // The body read itself: a declared length over the current limit is refused without reading
  // a byte, and a streamed body is read only to the bound and cancelled. Both are the unknown
  // outcome with a key, and neither touches the database.
  test(`${ownerAdapter}: #100 an oversized keyed body is refused unread or bounded, as the unknown outcome`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false, fixture, runtimeLimits: { ...REQUIRED, maxRequestBytes: 65_536 } });
    const call = (request) => h.app.fetch(request, { database: h.binding("a"), session: h.session("a") }, h.background)
      .then(async (response) => ({ status: response.status, body: await response.json() }));
    const before = work(h);
    const chunk = new Uint8Array(16_384).fill(0x78);

    const declaredState = { pulled: 0, cancelled: false };
    const declaredStream = new ReadableStream({
      pull(controller) { declaredState.pulled += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { declaredState.cancelled = true; },
    }, { highWaterMark: 0 });
    const declared = await call(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", duplex: "half",
      headers: { "content-type": "application/json", "idempotency-key": "declared-over-limit-key-01", "content-length": "200000" },
      body: declaredStream,
    }));
    unknown(declared, "declared over the limit");
    assert.equal(declaredState.pulled, 0, "a declared length over the limit is not read");
    assert.equal(declaredState.cancelled, false);

    const streamedState = { pulled: 0, cancelled: false };
    const streamedStream = new ReadableStream({
      pull(controller) { streamedState.pulled += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { streamedState.cancelled = true; },
    }, { highWaterMark: 0 });
    const streamed = await call(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", duplex: "half",
      headers: { "content-type": "application/json", "idempotency-key": "streamed-over-limit-key-1" },
      body: streamedStream,
    }));
    unknown(streamed, "streamed over the limit");
    assert.equal(streamedState.cancelled, true, "the stream is cut at the bound");
    assert.ok(streamedState.pulled <= 65_536 + chunk.byteLength, `pulled ${streamedState.pulled}`);
    unchanged(h, before, "oversized bodies");
  });
}
