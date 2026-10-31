// The request budget (ADR 0027 pull request 3): maxRequestBytes, maxJsonValues, and
// maxSqlBytes are RuntimeLimits the engine enforces and Capabilities advertises; the bounds
// on the request path (WASM input, hash input, step event) are computed from them and never
// reject what they accept; the control and validator replies have fixed caps. Every limit is
// tested at the value and one over, with the code and status of the specification and with no
// database work done for a refused request, on both TransactionOwner adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeLimits } from "../src/limits.ts";
import { callCommitCheckHook } from "../src/adapters/commit-check-hook.ts";
import { countJsonValues } from "../scripts/lib/cpu-shapes.mjs";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";

const read = (name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed(db, tenant) {
    const insert = db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
    insert.run("seed", `tenant_${tenant}`, "visible", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
  },
  callbackQuery: { sql: "SELECT id,state,seed FROM projects WHERE state=:state", params: { state: "AAEC/w==" } },
};
const REQUIRED = { maxRows: 100, maxResultBytes: 64_000, timeoutMs: 1_000, maxStatements: 8 };
const EXECUTE = "/v1/transactions:execute";
const MIB = 1_048_576;
const INSERT = "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING id";
const insert = (id, name = "n", state = null) => ({ sql: INSERT, params: { id, name, state } });
const rowCount = (h, id) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM projects WHERE id = ?").get(id).n;
const bytesOf = (text) => new TextEncoder().encode(text).byteLength;

/**
 * The database work a request caused: connections opened and statements run. The provider's
 * binding check is not work on the database: ADR 0023 decides the binding before the body.
 */
const work = async (h) => {
  await h.flush(); // the after-response cost observation of an earlier request is not this request's work
  return { connects: h.counts().connects, statements: h.events.length };
};

/**
 * A request body of exactly `size` UTF-8 bytes. `make(pad)` builds the body text for a padding
 * string; the padding is `fill` repeated (and one ASCII letter when the remainder is odd for a
 * two-byte `fill`).
 */
const bodyOf = (size, make, fill = "x") => {
  const base = bytesOf(make(""));
  const room = size - base;
  assert.ok(room >= 0, `the body cannot be ${size} bytes`);
  const unit = bytesOf(fill);
  const padding = fill.repeat(Math.floor(room / unit)) + "x".repeat(room % unit);
  const text = make(padding);
  assert.equal(bytesOf(text), size);
  return text;
};
// A body that inserts one row named `pad`; the id has a fixed width so the padding is all that varies.
let serial = 0;
const uid = () => `r${String((serial += 1)).padStart(6, "0")}`;
const statementBody = (id = uid()) => (pad) => JSON.stringify({ statements: [insert(id, pad)] });

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits, options = {}) =>
    harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...REQUIRED, ...limits }, ...options });
  const post = (h, text, key = null, path = EXECUTE) => h.request("a", path, new RawJson(text), key);
  const refused = (response, code, status = 413) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.equal(response.body.error.code, code);
    return response.body.error;
  };

  // ------------------------------------------------------------------------------------------
  // maxRequestBytes

  for (const maxRequestBytes of [65_536, 1_048_576, 2_097_152]) {
    test(`${ownerAdapter}: maxRequestBytes ${maxRequestBytes}: the limit is served and one byte over is 413 with no database work`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { maxRequestBytes, maxSqlBytes: 1_024 });
      for (const fill of ["x", "é", "日"]) {
        const exact = bodyOf(maxRequestBytes, statementBody(), fill);
        const served = await post(h, exact, `at-limit-${fill.codePointAt(0)}-key-0001`);
        assert.equal(served.status, 200, `${fill}: ${JSON.stringify(served.body).slice(0, 200)}`);
        const over = bodyOf(maxRequestBytes + 1, statementBody(), fill);
        const before = await work(h);
        refused(await post(h, over, `over-${fill.codePointAt(0)}-key-000001`), "POLICYSQL_REQUEST_TOO_LARGE");
        assert.deepEqual(await work(h), before, `${fill}: no connection and no statement for a refused body`);
      }
    });
  }

  test(`${ownerAdapter}: the body limit counts a byte order mark and applies to explain and interactive commands`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { maxRequestBytes: 65_536, maxSqlBytes: 1_024 });
    const make = (pad) => `${JSON.stringify({ statements: [{ sql: "SELECT id FROM projects", params: {} }], expected: undefined })}${pad}`;
    // 65,533 bytes of JSON plus a BOM (3 bytes) is exactly the limit; one more byte is over.
    const fits = bodyOf(65_536 - 3, make, " ");
    const bom = "﻿";
    assert.equal((await post(h, `${bom}${fits}`, null, "/v1/transactions:explain")).status, 200);
    const before = await work(h);
    refused(await post(h, `${bom}${fits} `, null, "/v1/transactions:explain"), "POLICYSQL_REQUEST_TOO_LARGE");
    // An interactive transaction's commands are bounded the same way (the begin body, and a statement).
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    assert.equal(started.status, 201);
    const path = `/v1/transactions/${started.body.transactionId}/statements`;
    const statement = (pad) => JSON.stringify({ sequence: 1, ...insert("interactive_fits", pad) });
    refused(await post(h, bodyOf(65_537, statement), null, path), "POLICYSQL_REQUEST_TOO_LARGE");
    assert.deepEqual((await work(h)).statements, before.statements + 1 /* only the BEGIN of the interactive transaction */);
    const fitsStatement = await post(h, bodyOf(65_536, statement), null, path);
    assert.equal(fitsStatement.status, 200, JSON.stringify(fitsStatement.body).slice(0, 200));
  });

  // ------------------------------------------------------------------------------------------
  // maxJsonValues

  for (const maxJsonValues of [1_024, 65_536, 131_072]) {
    test(`${ownerAdapter}: maxJsonValues ${maxJsonValues}: exactly the limit is served and one value over is 413 with no database work`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { maxJsonValues, maxRequestBytes: 2_097_152 });
      const withMetadata = (count, id) => JSON.stringify({
        statements: [{
          sql: "INSERT INTO projects(id,name,state,metadata) VALUES(:id,:name,:state,:metadata) RETURNING id",
          params: { id, name: "n", state: null, metadata: Array.from({ length: count }, () => 1) },
        }],
      });
      const base = countJsonValues(JSON.parse(withMetadata(0, "v")));
      const exact = withMetadata(maxJsonValues - base, "values_at");
      assert.equal(countJsonValues(JSON.parse(exact)), maxJsonValues);
      const served = await post(h, exact, "values-at-limit-key-1");
      assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
      assert.equal(rowCount(h, "values_at"), 1);
      const over = withMetadata(maxJsonValues - base + 1, "values_over");
      assert.equal(countJsonValues(JSON.parse(over)), maxJsonValues + 1);
      const before = await work(h);
      const error = refused(await post(h, over, "values-over-key-0001"), "POLICYSQL_REQUEST_TOO_LARGE");
      assert.equal(error.path, null);
      assert.deepEqual(await work(h), before, "no connection and no statement");
      assert.equal(rowCount(h, "values_over"), 0);
    });
  }

  test(`${ownerAdapter}: the value count includes object member names and stops before the rest of the body is read as JSON`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { maxJsonValues: 1_024 });
    // 600 members is 1,200 names and values: over the limit, though under 1,024 members.
    const members = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`k${index}`, 1]));
    const before = await work(h);
    refused(await post(h, JSON.stringify({ statements: [insert("members", "n")], members })), "POLICYSQL_REQUEST_TOO_LARGE");
    assert.deepEqual(await work(h), before);
  });

  // ------------------------------------------------------------------------------------------
  // maxSqlBytes

  for (const maxSqlBytes of [1_024, 65_536]) {
    test(`${ownerAdapter}: maxSqlBytes ${maxSqlBytes}: the limit is served and one byte over is 413 at /statements/<i>/sql, before parsing`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { maxSqlBytes, maxRequestBytes: 1_048_576 });
      const sqlOf = (size, fill) => {
        const head = "SELECT id FROM projects /*";
        const tail = "*/";
        const room = size - bytesOf(head) - bytesOf(tail);
        return `${head}${fill.repeat(Math.floor(room / bytesOf(fill)))}${"x".repeat(room % bytesOf(fill))}${tail}`;
      };
      for (const fill of ["x", "é", "日"]) {
        const exact = sqlOf(maxSqlBytes, fill);
        assert.equal(bytesOf(exact), maxSqlBytes);
        const served = await post(h, JSON.stringify({ statements: [{ sql: "SELECT id FROM projects", params: {} }, { sql: exact, params: {} }] }));
        assert.equal(served.status, 200, `${fill}: ${JSON.stringify(served.body).slice(0, 200)}`);
        const over = sqlOf(maxSqlBytes + 1, fill);
        const before = await work(h);
        const error = refused(await post(h, JSON.stringify({ statements: [{ sql: "SELECT id FROM projects", params: {} }, { sql: over, params: {} }] })), "POLICYSQL_REQUEST_TOO_LARGE");
        assert.equal(error.path, "/statements/1/sql");
        assert.deepEqual(await work(h), before);
      }
      // Over the limit and not SQL at all: the length is judged before the parser sees it, so
      // the answer is 413, not 400 POLICYSQL_INVALID_SQL; and the first statement is not run.
      const before = await work(h);
      const garbage = refused(await post(h, JSON.stringify({ statements: [{ sql: "?".repeat(maxSqlBytes + 1), params: {} }] })), "POLICYSQL_REQUEST_TOO_LARGE");
      assert.equal(garbage.path, "/statements/0/sql");
      assert.deepEqual(await work(h), before);
      // The same on explain.
      refused(await post(h, JSON.stringify({ statements: [{ sql: "?".repeat(maxSqlBytes + 1), params: {} }] }), null, "/v1/transactions:explain"), "POLICYSQL_REQUEST_TOO_LARGE");
    });
  }

  test(`${ownerAdapter}: maxSqlBytes applies to interactive statements too`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { maxSqlBytes: 1_024 });
    const started = await h.request("a", "/v1/transactions", { mode: "read" }, null);
    const path = `/v1/transactions/${started.body.transactionId}/statements`;
    const over = await h.request("a", path, { sequence: 1, sql: `SELECT id FROM projects /*${"x".repeat(1_024)}*/`, params: {} }, null);
    const error = refused(over, "POLICYSQL_REQUEST_TOO_LARGE");
    assert.equal(error.path, "/statements/0/sql");
  });

  // ------------------------------------------------------------------------------------------
  // The computed bounds never reject what the configured limits accept

  for (const [label, limits] of [
    ["the defaults", {}],
    ["the minimum request limit", { maxRequestBytes: 65_536, maxSqlBytes: 1_024 }],
    ["the hard maxima", { maxRequestBytes: 2_097_152, maxJsonValues: 131_072, maxSqlBytes: 1_048_576 }],
  ]) {
    for (const hooks of [false, true]) {
      const placement = hooks ? "owner" : "direct";
      test(`${ownerAdapter}/${placement}: with ${label}, a keyed body of escaped text at the limit passes every internal bound`, async (t) => {
        t.mock.method(console, "log", () => {});
        const h = await setup(t, limits, { hooks });
        const { maxRequestBytes } = runtimeLimits(h.runtime);
        // A string of quotes: each is two bytes in the body and four inside the step event (the
        // body text is embedded in it as a JSON string), the largest growth a valid body has.
        // `pad.length` bytes of body: `\"` per two, and one letter for an odd remainder.
        const quotes = (pad) => JSON.stringify({ statements: [insert(`escaped_${hooks}`, '"'.repeat(Math.floor(pad.length / 2)) + (pad.length % 2 ? "x" : ""))] });
        const body = bodyOf(maxRequestBytes, quotes);
        assert.equal(bytesOf(body), maxRequestBytes);
        const served = await post(h, body, `escaped-${placement}-key-0001`);
        assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 300));
        assert.equal(rowCount(h, `escaped_${hooks}`), 1);
        // The same request again is a replay of the committed response (keyed), through the
        // same bounds.
        const replay = await post(h, body, `escaped-${placement}-key-0001`);
        assert.deepEqual({ ...replay.body, meta: undefined }, { ...served.body, meta: undefined });
        assert.equal(rowCount(h, `escaped_${hooks}`), 1);
      });

      test(`${ownerAdapter}/${placement}: with ${label}, base64 BLOBs of maxBytesPerValue fill the body and pass every internal bound`, async (t) => {
        t.mock.method(console, "log", () => {});
        const h = await setup(t, limits, { hooks });
        const { maxRequestBytes, maxBytesPerValue, maxStatements } = runtimeLimits(h.runtime);
        // A BLOB of maxBytesPerValue, or the largest the body limit leaves room for (the
        // smallest limit that applies governs, ADR 0027).
        const size = Math.min(maxBytesPerValue, Math.floor((maxRequestBytes - 8_192) * 3 / 4));
        const blob = Buffer.alloc(size, 0xff).toString("base64");
        const encoded = Math.ceil(size / 3) * 4;
        assert.equal(blob.length, encoded);
        // As many whole BLOB statements as the body and the statement limit allow.
        const count = Math.min(maxStatements, Math.floor((maxRequestBytes - 4_096) / (encoded + 256)));
        assert.ok(count >= 1, "at least one BLOB fits");
        const statements = Array.from({ length: count }, (_, index) => insert(`blob_${hooks}_${index}`, "n", blob));
        const text = JSON.stringify({ statements });
        assert.ok(bytesOf(text) <= maxRequestBytes, `${bytesOf(text)} of ${maxRequestBytes}`);
        const served = await post(h, text, `blobs-${placement}-key-00001`);
        assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 300));
        for (let index = 0; index < count; index += 1) assert.equal(rowCount(h, `blob_${hooks}_${index}`), 1);
        const stored = h.databases.get("a").database.prepare("SELECT length(state) AS n FROM projects WHERE id = ?").get(`blob_${hooks}_0`).n;
        assert.equal(stored, size);
      });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Capabilities advertises exactly the enforced values

  test(`${ownerAdapter}: Capabilities advertises the configured request limits, and the engine enforces those values`, async (t) => {
    t.mock.method(console, "log", () => {});
    const configured = { maxRequestBytes: 70_000, maxJsonValues: 2_000, maxSqlBytes: 3_000 };
    const h = await setup(t, configured);
    const { body: capabilities } = await h.request("a", "/v1/capabilities");
    for (const [key, value] of Object.entries(configured)) assert.equal(capabilities.limits[key], value, key);
    // The advertised value is the enforced one: the value is served, one over is not.
    const sqlOf = (size) => `SELECT id FROM projects /*${"x".repeat(size - 28)}*/`;
    assert.equal(bytesOf(sqlOf(capabilities.limits.maxSqlBytes)), capabilities.limits.maxSqlBytes);
    assert.equal((await post(h, JSON.stringify({ statements: [{ sql: sqlOf(capabilities.limits.maxSqlBytes), params: {} }] }))).status, 200);
    refused(await post(h, JSON.stringify({ statements: [{ sql: sqlOf(capabilities.limits.maxSqlBytes + 1), params: {} }] })), "POLICYSQL_REQUEST_TOO_LARGE");
    const body = bodyOf(capabilities.limits.maxRequestBytes, statementBody());
    assert.equal((await post(h, body)).status, 200);
    refused(await post(h, bodyOf(capabilities.limits.maxRequestBytes + 1, statementBody())), "POLICYSQL_REQUEST_TOO_LARGE");
    // The input-side limits the runtime reports are advertised too.
    for (const key of ["maxBytesPerValue", "maxParameters", "maxExpressionDepth", "maxProjections", "maxJoins"]) {
      assert.equal(capabilities.limits[key], runtimeLimits(h.runtime)[key], key);
    }
  });

  // ------------------------------------------------------------------------------------------
  // The client treats both 413 codes as definite rejections

  test(`${ownerAdapter}: the client reports an oversized request as a rejection, never as an unknown outcome`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { maxSqlBytes: 1_024 });
    const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
    const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
    const before = await work(h);
    await assert.rejects(client.execute(`SELECT id FROM projects /*${"x".repeat(2_048)}*/`), (error) => {
      assert.ok(error instanceof PolicySqlError);
      assert.equal(error instanceof PolicySqlOutcomeUnknownError, false, "a definite rejection");
      assert.equal(error.code, "POLICYSQL_REQUEST_TOO_LARGE");
      assert.equal(error.status, 413);
      return true;
    });
    assert.deepEqual(await work(h), before);
  });

  // ------------------------------------------------------------------------------------------
  // Fixed caps on the replies PolicySQL reads from outside

  const CONTROL_BYTES = 65_536;
  const STEP = 16_384;
  /** A reply of `size` bytes: `json` padded with trailing spaces (valid JSON whitespace). */
  const padded = (json, size) => {
    const encoded = new TextEncoder().encode(JSON.stringify(json));
    assert.ok(encoded.byteLength <= size);
    const out = new Uint8Array(size).fill(32);
    out.set(encoded);
    return out;
  };
  const chunks = (bytes) => {
    const state = { pulled: 0, cancelled: false };
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.byteLength) { controller.close(); return; }
        const chunk = bytes.subarray(offset, offset + STEP);
        offset += chunk.byteLength;
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return { state, response: new Response(stream) };
  };

  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}/${placement}: a COMMIT reply of exactly 65,536 bytes is read, and one byte over is an unknown outcome, never a rejection`, async (t) => {
      t.mock.method(console, "log", () => {});
      const run = async (size, id) => {
        const h = await setup(t, {}, { hooks });
        const sent = [];
        h.replaceDatabaseResponse(({ sqls, baton, results }) => {
          if (sqls[0] !== "COMMIT") return undefined;
          const reply = chunks(padded({ baton, results }, size));
          sent.push(reply.state);
          return reply.response;
        });
        const response = await post(h, JSON.stringify({ statements: [insert(id)] }), `commit-${size}-${placement}-key-1`);
        return { h, response, sent };
      };
      const exact = await run(CONTROL_BYTES, "commit_exact");
      assert.equal(exact.response.status, 200, JSON.stringify(exact.response.body));
      assert.equal(exact.sent[0].cancelled, false);
      const over = await run(CONTROL_BYTES + 1, "commit_over");
      // The write was applied by the database; the reply was refused. Not a rejection (ADR 0007).
      assert.ok(over.response.status >= 500, JSON.stringify(over.response.body));
      assert.notEqual(over.response.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      assert.notEqual(over.response.status, 413);
      assert.equal(rowCount(over.h, "commit_over"), 1, "the COMMIT had been sent and applied");
      assert.equal(over.sent[0].cancelled, true, "the stream is cut");
      assert.ok(over.sent[0].pulled <= CONTROL_BYTES + STEP, `pulled ${over.sent[0].pulled}`);
      const client = new PolicySqlClient({
        transport: createHttpTransport({
          endpoint: "https://worker.test",
          fetchImpl: (url, init) => over.h.app.fetch(new Request(url, init), { database: over.h.binding("a"), session: over.h.session("a") }, over.h.background),
        }),
      });
      over.h.replaceDatabaseResponse(({ sqls, baton, results }) => {
        if (sqls[0] !== "COMMIT") return undefined;
        return chunks(padded({ baton, results }, CONTROL_BYTES + 1)).response;
      });
      await assert.rejects(client.execute(INSERT, { id: "commit_client", name: "n", state: null }), PolicySqlOutcomeUnknownError);
    });
  }

  test(`${ownerAdapter}: a BEGIN reply over 65,536 bytes is a transport failure (503), never a limit`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, {});
    const sent = [];
    h.replaceDatabaseResponse(({ sqls, baton, results }) => {
      if (!/^BEGIN /u.test(sqls[0] ?? "")) return undefined;
      const reply = chunks(padded({ baton, results }, CONTROL_BYTES + 1));
      sent.push(reply.state);
      return reply.response;
    });
    const response = await post(h, JSON.stringify({ statements: [insert("begin_over")] }), "begin-over-key-000001");
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.equal(sent[0].cancelled, true);
    assert.equal(rowCount(h, "begin_over"), 0);
  });

  test(`${ownerAdapter}: a validator reply of exactly 65,536 bytes is read; one byte over denies the commit as a failed validator`, async (t) => {
    t.mock.method(console, "log", () => {});
    const reply = (size) => ({ allowed }) => {
      const encoded = padded({ version: "1", allowed }, size);
      return chunks(encoded).response;
    };
    const exact = await setup(t, {}, { hooks: true });
    exact.replaceValidatorResponse(reply(CONTROL_BYTES));
    const allowed = await post(exact, JSON.stringify({ statements: [insert("validator_exact")] }), "validator-exact-key-001");
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(rowCount(exact, "validator_exact"), 1);

    const over = await setup(t, {}, { hooks: true });
    over.replaceValidatorResponse(reply(CONTROL_BYTES + 1));
    const denied = await post(over, JSON.stringify({ statements: [insert("validator_over")] }), "validator-over-key-0001");
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
    assert.equal(rowCount(over, "validator_over"), 0, "the commit was denied");
  });
}

// ------------------------------------------------------------------------------------------
// The validator call, without an engine

const hookCall = (fetchImpl) => ({
  url: new URL("https://validator.test/hook"), hmacSecret: "test-validator-secret-0001",
  publicBaseUrl: new URL("https://worker.test"), validationId: `cval_${"a".repeat(32)}`,
  payload: { version: "1" }, capability: { token: "t", expiresAtMs: Date.now() + 1_000 }, timeoutMs: 1_000, fetchImpl,
});

test("the validator reply is bounded at 65,536 bytes: at the cap it is read, over it the call fails", async () => {
  const body = (size) => { const out = new Uint8Array(size).fill(32); out.set(new TextEncoder().encode('{"allowed":true}')); return out; };
  const at = await callCommitCheckHook(hookCall(async () => new Response(body(65_536))));
  assert.deepEqual(at, { ok: true, decision: { allowed: true } });
  for (const size of [65_537, 1_048_576]) {
    const state = { pulled: 0, cancelled: false };
    let offset = 0;
    const bytes = body(size);
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.byteLength) { controller.close(); return; }
        const chunk = bytes.subarray(offset, offset + 8_192);
        offset += chunk.byteLength;
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(callCommitCheckHook(hookCall(async () => new Response(stream))), (error) => error.name === "BodyTooLargeError");
    assert.equal(state.cancelled, true, `${size}: cut`);
    assert.ok(state.pulled <= 65_536 + 8_192, `${size}: pulled ${state.pulled}`);
  }
  // A declared length over the cap is rejected unread.
  await assert.rejects(callCommitCheckHook(hookCall(async () => new Response("{}", { headers: { "content-length": "65537" } }))), (error) => error.name === "BodyTooLargeError");
  // Not JSON, malformed UTF-8, or a non-success status: an answer that is not a decision.
  assert.deepEqual(await callCommitCheckHook(hookCall(async () => new Response("not json"))), { ok: true, decision: null });
  assert.deepEqual(await callCommitCheckHook(hookCall(async () => new Response(new Uint8Array([0x7b, 0xff, 0x7d])))), { ok: true, decision: null });
  assert.deepEqual(await callCommitCheckHook(hookCall(async () => new Response('{"allowed":true}', { status: 503 }))), { ok: false, decision: null });
});

test("the Capabilities presenter reads every limit from limits_json, and the fixed protocol constants stay out of it", async () => {
  const { capabilities } = await import("../src/presenters.ts");
  const { limitsJson } = await import("./helpers/limits.mjs");
  const distinct = { maxRequestBytes: 111_111, maxJsonValues: 2_222, maxSqlBytes: 3_333, maxBytesPerValue: 4_444, maxParameters: 55, maxExpressionDepth: 6, maxProjections: 77, maxJoins: 8, maxResponseBytes: 99_999 };
  const advertised = capabilities({ snapshot: "s", profile: "p", abi_version: 1, commit_checks_enabled: false, limits_json: limitsJson(distinct) }).limits;
  for (const [key, value] of Object.entries(distinct)) {
    if (key === "maxResponseBytes") assert.equal(Object.hasOwn(advertised, key), false, "not enforced before pull request 6, so not advertised");
    else assert.equal(advertised[key], value, key);
  }
  assert.equal(MIB, 1_048_576);
});
