// End-to-end: the streamed Turso response bound (#53) through the public HTTP routes, the
// real WASM core, the real HTTP database transport, and SQLite, on both owner adapters. An
// oversized reply to a statement is a permanent 413 that rolls back; an oversized reply to a
// COMMIT that the database applied is never a rejection (ADR 0007): the atomic path answers
// what it answers for any COMMIT transport failure today (503 POLICYSQL_DATABASE_UNAVAILABLE
// direct, 500 POLICYSQL_INTERNAL on the owner), the interactive path
// POLICYSQL_COMMIT_OUTCOME_UNKNOWN.
// Either way the hostile body is cut at the bound and released. A COMMIT reply that stalls
// (timeout class) or carries malformed UTF-8 (unavailable class) is never a rejection either.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

// The read cap core passes with each execute (ADR 0027); these tests choose their own.
const READ_CAP = 2_097_152;

const { sendCommand, PolicySqlOutcomeUnknownError } = await import("../../../packages/client/protocol.js");

const MAX_RESPONSE_BYTES = 2_097_152;
const STEP = 65_536;
const TOTAL = 3 * 1_048_576;
const execute = "/v1/transactions:execute";
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });

/** A 3 MiB body of spaces with no Content-Length, recording what was pulled. */
const hostileBody = () => {
  const state = { bytes: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      if (state.bytes >= TOTAL) { controller.close(); return; }
      state.bytes += STEP;
      controller.enqueue(new Uint8Array(STEP).fill(32));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: new Response(stream) };
};
/** A reply that sends its first bytes and then stalls until it is cancelled. */
const stalledBody = () => {
  const state = { bytes: 0, cancelled: false, pulls: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (state.pulls > 1) return new Promise(() => {});
      const chunk = new TextEncoder().encode('{"baton":null,"results":[');
      state.bytes += chunk.byteLength;
      controller.enqueue(chunk);
      return undefined;
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: new Response(stream) };
};
/** A COMMIT reply with one malformed UTF-8 sequence inside it, followed by endless data. */
const invalidUtf8Body = () => {
  const state = { bytes: 0, cancelled: false, pulls: 0 };
  const chunks = [
    new TextEncoder().encode('{"baton":null,"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"'),
    Uint8Array.of(0xc3, 0x28),
    new TextEncoder().encode('","decltype":"TEXT"}]'),
  ];
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks[state.pulls++] ?? new Uint8Array(STEP).fill(32);
      state.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: new Response(stream) };
};
/**
 * Replace the reply to one pipeline: with `statement`, the first pipeline that runs the
 * project INSERT; with `commit`, the COMMIT of the transaction that ran it (not, for example,
 * the COMMIT of a validator's callback query).
 */
const replaceOnce = (h, target, make = hostileBody) => {
  const bodies = [];
  let armed = true;
  const writers = new Set();
  const inserts = (sqls) => sqls.some((sql) => /^INSERT INTO "?projects"?/.test(sql ?? ""));
  h.replaceDatabaseResponse(({ sqls, requestBaton, baton }) => {
    if (!armed) return undefined;
    let match;
    if (target === "statement") match = inserts(sqls);
    else if (target === "select") match = (sqls[0] ?? "").startsWith("SELECT");
    else {
      match = sqls[0] === "COMMIT" && writers.has(requestBaton);
      if (inserts(sqls) && baton) writers.add(baton);
    }
    if (!match) return undefined;
    armed = false;
    const body = make();
    bodies.push(body.state);
    return body.response;
  });
  return bodies;
};
const bounded = (bodies, label) => {
  assert.equal(bodies.length, 1, `${label}: the hostile reply was sent`);
  assert.equal(bodies[0].cancelled, true, `${label}: the body is released`);
  assert.ok(bodies[0].bytes <= MAX_RESPONSE_BYTES + STEP, `${label}: pulled ${bodies[0].bytes} of ${TOTAL}`);
};
const neverRejected = async (reply, kind) => {
  await assert.rejects(sendCommand(async () => reply, { kind }, {}, () => {}), PolicySqlOutcomeUnknownError);
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, options = {}) => harness(t, { ownerAdapter, ...options });

  // Today's post-COMMIT codes (atomic.rs `commit_failure`): the direct path keeps the
  // transport's class (unavailable: 503); the owner reports every COMMIT error as class
  // `unknown` (transaction-owner.ts), answered 500 POLICYSQL_INTERNAL. Neither is a rejection.
  for (const [placement, hooks, status, code] of [
    ["direct", false, 503, "POLICYSQL_DATABASE_UNAVAILABLE"],
    ["owner", true, 500, "POLICYSQL_INTERNAL"],
  ]) {
    test(`${ownerAdapter}/${placement}: an oversized reply to an atomic COMMIT is never a rejection, and the body is cut`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { hooks });
      const bodies = replaceOnce(h, "commit");
      const reply = await h.request("a", execute, { statements: [insert("oversized_commit")] }, null);
      assert.equal(reply.status, status, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, code);
      await neverRejected(reply, "execute");
      bounded(bodies, "atomic COMMIT");
      // The database applied the COMMIT; the reply was lost, not the write.
      assert.equal(h.rows("a").filter((row) => row.id === "oversized_commit").length, 1);
    });

    test(`${ownerAdapter}/${placement}: an oversized reply to an atomic statement is 413 and nothing is committed`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { hooks });
      const bodies = replaceOnce(h, "statement");
      const reply = await h.request("a", execute, { statements: [insert("oversized_statement")] }, null);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      bounded(bodies, "atomic statement");
      assert.equal(h.rows("a").filter((row) => row.id === "oversized_statement").length, 0);
      // The reply was not read, so its baton is unknown: no ROLLBACK is sent with the stale one (#96),
      // and no COMMIT either; the server expires the stream and rolls the transaction back.
      assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK" || sql === "COMMIT"), false);
    });
  }

  test(`${ownerAdapter}: an oversized reply to an interactive COMMIT is outcome-unknown, never a rejection`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const path = `/v1/transactions/${started.body.transactionId}`;
    const bodies = replaceOnce(h, "commit");
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("oversized_interactive") }, null)).status, 200);
    const commit = () => h.request("a", `${path}/commit`, { sequence: 2 }, null);
    for (const label of ["first", "retry"]) {
      const reply = await commit();
      assert.equal(reply.status, 503, `${label}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN", label);
      await neverRejected(reply, "commit");
    }
    bounded(bodies, "interactive COMMIT");
    assert.equal((await h.ownerRecord(started.body.transactionId)).status, "commit_unknown");
    assert.equal(h.rows("a").filter((row) => row.id === "oversized_interactive").length, 1);
  });

  // PR #86 review: the other two failures of a COMMIT reply's body. A body that stalls is cut at
  // the request timeout (the transport's 504 class); a body with malformed UTF-8 is a transport
  // failure (503 class). Each is answered with today's post-COMMIT code for its class, never a
  // rejection, and the COMMIT the database applied leaves exactly one row.
  const COMMIT_REPLIES = {
    stalled: {
      make: stalledBody,
      atomic: { direct: [504, "POLICYSQL_DATABASE_TIMEOUT"], owner: [500, "POLICYSQL_INTERNAL"] },
    },
    "invalid UTF-8": {
      make: invalidUtf8Body,
      atomic: { direct: [503, "POLICYSQL_DATABASE_UNAVAILABLE"], owner: [500, "POLICYSQL_INTERNAL"] },
    },
  };
  for (const [kind, { make, atomic }] of Object.entries(COMMIT_REPLIES)) {
    for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
      test(`${ownerAdapter}/${placement}: a ${kind} reply to an atomic COMMIT is never a rejection and writes one row`, async (t) => {
        t.mock.method(console, "log", () => {});
        const h = await setup(t, { hooks });
        const bodies = replaceOnce(h, "commit", make);
        const id = `${kind === "stalled" ? "stalled" : "invalid"}_atomic`;
        const reply = await h.request("a", execute, { statements: [insert(id)] }, null);
        const [status, code] = atomic[placement];
        assert.equal(reply.status, status, JSON.stringify(reply.body));
        assert.equal(reply.body.error.code, code);
        await neverRejected(reply, "execute");
        assert.equal(bodies.length, 1, "the reply was replaced");
        assert.equal(bodies[0].cancelled, true, "the body is released");
        assert.equal(h.rows("a").filter((row) => row.id === id).length, 1);
      });
    }

    test(`${ownerAdapter}: a ${kind} reply to an interactive COMMIT is outcome-unknown and writes one row`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { hooks: false });
      const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const path = `/v1/transactions/${started.body.transactionId}`;
      const bodies = replaceOnce(h, "commit", make);
      const id = `${kind === "stalled" ? "stalled" : "invalid"}_interactive`;
      assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert(id) }, null)).status, 200);
      for (const label of ["first", "retry"]) {
        const reply = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
        assert.equal(reply.status, 503, `${label}: ${JSON.stringify(reply.body)}`);
        assert.equal(reply.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN", label);
        await neverRejected(reply, "commit");
      }
      assert.equal(bodies.length, 1, "the reply was replaced");
      assert.equal(bodies[0].cancelled, true, "the body is released");
      assert.equal((await h.ownerRecord(started.body.transactionId)).status, "commit_unknown");
      assert.equal(h.rows("a").filter((row) => row.id === id).length, 1);
    });
  }

  test(`${ownerAdapter}: an oversized reply to an interactive statement is 413 and ends the transaction`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    const path = `/v1/transactions/${started.body.transactionId}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("undo_interactive") }, null)).status, 200);
    const bodies = replaceOnce(h, "select");
    const reply = await h.request("a", `${path}/statements`, { sequence: 2, sql: "SELECT id, name FROM projects ORDER BY id", params: {} }, null);
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    bounded(bodies, "interactive statement");
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 3 }, null)).body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.rows("a").filter((row) => row.id === "undo_interactive").length, 0);
  });
}
