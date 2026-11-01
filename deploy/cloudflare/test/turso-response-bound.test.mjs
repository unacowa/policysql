// End-to-end: the streamed Turso response bound (#53) through the public HTTP routes, the
// real WASM core, the real HTTP database transport, and SQLite, on both owner adapters. An
// oversized reply to a statement is a permanent 413 that rolls back; an oversized reply to a
// COMMIT that the database applied is never a rejection (ADR 0007): the atomic path answers
// what it answers for any COMMIT transport failure today (503 POLICYSQL_DATABASE_UNAVAILABLE
// direct, 500 POLICYSQL_INTERNAL on the owner), the interactive path
// POLICYSQL_COMMIT_OUTCOME_UNKNOWN.
// Either way the hostile body is cut at the bound and released. A COMMIT reply that stalls
// (timeout class) or carries malformed UTF-8 (unavailable class) is never a rejection either.
// An oversized statement reply whose leading bytes name the stream's next baton is rolled back
// through that baton at both placements and on both routes (#97); one with no readable baton
// makes a single best-effort attempt with the stale one, which the server refuses, so the
// transaction and its write lock remain until the server expires the stream (ADR 0027).
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
const selectAll = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };

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
/**
 * A reply over the cap whose first bytes are the stream's next baton, as real Turso sends it
 * even when the rest cannot be read. Recording what was pulled shows the bound still cuts it.
 */
const recoverableBody = (baton) => {
  const state = { bytes: 0, cancelled: false };
  const head = new TextEncoder().encode(`{"baton":"${baton}","base_url":null,"results":[]}`);
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(head); state.bytes += head.byteLength; },
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
    // Follow the writer's stream as its baton rotates; a callback query's stream is another one.
    if (writers.has(requestBaton) && baton) writers.add(baton);
    let match;
    if (target === "statement") match = inserts(sqls);
    else if (target === "select") match = (sqls[0] ?? "").startsWith("SELECT");
    else {
      match = sqls[0] === "COMMIT" && writers.has(requestBaton);
      if (inserts(sqls)) {
        if (requestBaton) writers.add(requestBaton);
        if (baton) writers.add(baton);
      }
    }
    if (!match) return undefined;
    armed = false;
    // `make` sees the reply's context, including the baton the server minted for it.
    const body = make({ sqls, requestBaton, baton });
    bodies.push(body.state);
    return body.response;
  });
  return bodies;
};
/** Records every JSON log line the request emits, for the transport's recovery outcome. */
const captureLog = (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => { lines.push(args.map(String).join(" ")); });
  return lines;
};
const recoveryOutcomes = (lines) => lines.flatMap((line) => {
  try {
    const record = JSON.parse(line);
    return record?.event === "database_stream_recovery" ? [record] : [];
  } catch { return []; }
});
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

    test(`${ownerAdapter}/${placement}: an oversized reply to an atomic statement is 413 and is rolled back with the baton inside it (#97)`, async (t) => {
      const lines = captureLog(t);
      const h = await setup(t, { hooks });
      let recovered = null;
      const bodies = replaceOnce(h, "statement", ({ baton }) => {
        recovered = baton;
        return recoverableBody(baton);
      });
      const reply = await h.request("a", execute, { statements: [insert("recovered_statement")] }, null);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      bounded(bodies, "atomic statement");
      await h.flush();
      assert.ok(recovered, "the replaced reply named the stream's next baton");
      // Only the recovered baton closes this stream; the one the client held is stale after the
      // lost reply, so this proves the leading bytes were used.
      assert.ok(h.events.some(({ sql, baton }) => sql === "ROLLBACK" && baton === recovered), "the rollback continued the stream");
      assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
      assert.equal(h.rows("a").filter((row) => row.id === "recovered_statement").length, 0);
      assert.deepEqual(recoveryOutcomes(lines), [], "the recovered baton is the stream's, so no best-effort recovery runs");
    });

    test(`${ownerAdapter}/${placement}: an atomic statement reply with no readable baton makes one refused rollback attempt (#96, #97)`, async (t) => {
      const lines = captureLog(t);
      const h = await setup(t, { hooks });
      const bodies = replaceOnce(h, "statement");
      const reply = await h.request("a", execute, { statements: [insert("unreadable_statement")] }, null);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      bounded(bodies, "atomic statement");
      await h.flush();
      // The stale baton is refused at the stream level, so no statement runs and nothing commits.
      // The transaction, and its write lock, stay until the server expires the stream (ADR 0027).
      assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK" || sql === "COMMIT"), false);
      assert.equal(h.rows("a").filter((row) => row.id === "unreadable_statement").length, 0);
      assert.deepEqual(recoveryOutcomes(lines).map(({ outcome }) => outcome), ["refused"]);
    });

    // Issue #97: with a later statement in the same envelope that is a write, the limit is not a
    // definite rejection. An earlier statement error can auto-roll back the transaction, after
    // which SQLite runs a later statement in autocommit: the write may have applied, so the
    // failure is internal/outcome-unknown and the transaction is rolled back, never committed.
    test(`${ownerAdapter}/${placement}: an over-bound reply to an atomic SELECT-then-write is outcome-unknown, not 413 (#97)`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { hooks });
      const bodies = replaceOnce(h, "statement");
      const reply = await h.request("a", execute, { statements: [selectAll, insert("later_write")] }, null);
      assert.equal(reply.status, 500, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "POLICYSQL_INTERNAL");
      bounded(bodies, "atomic SELECT-then-write");
      await h.flush();
      assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
      assert.equal(h.rows("a").filter((row) => row.id === "later_write").length, 0);
      // 500 is outside the client's definite-rejection table: the caller cannot treat it as failed.
      await neverRejected(reply, "execute");
    });

    test(`${ownerAdapter}/${placement}: an over-bound reply to an atomic write-then-SELECT stays a definite 413 (#97)`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await setup(t, { hooks });
      const bodies = replaceOnce(h, "statement");
      const reply = await h.request("a", execute, { statements: [insert("first_write"), selectAll] }, null);
      assert.equal(reply.status, 413, JSON.stringify(reply.body));
      assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      bounded(bodies, "atomic write-then-SELECT");
      await h.flush();
      assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
      assert.equal(h.rows("a").filter((row) => row.id === "first_write").length, 0);
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

  test(`${ownerAdapter}: an oversized reply to an interactive statement is 413, ends the transaction, and is rolled back with the baton inside it (#97)`, async (t) => {
    const lines = captureLog(t);
    const h = await setup(t, { hooks: false });
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    const path = `/v1/transactions/${started.body.transactionId}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("recovered_interactive") }, null)).status, 200);
    let recovered = null;
    const bodies = replaceOnce(h, "select", ({ baton }) => {
      recovered = baton;
      return recoverableBody(baton);
    });
    const reply = await h.request("a", `${path}/statements`, { sequence: 2, sql: "SELECT id, name FROM projects ORDER BY id", params: {} }, null);
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    bounded(bodies, "interactive statement");
    await h.flush();
    assert.ok(recovered, "the replaced reply named the stream's next baton");
    assert.ok(h.events.some(({ sql, baton }) => sql === "ROLLBACK" && baton === recovered), "the rollback continued the stream");
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 3 }, null)).body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.rows("a").filter((row) => row.id === "recovered_interactive").length, 0);
    assert.deepEqual(recoveryOutcomes(lines), [], "the recovered baton is the stream's, so no best-effort recovery runs");
  });

  test(`${ownerAdapter}: an interactive statement reply with no readable baton makes one refused rollback attempt (#96, #97)`, async (t) => {
    const lines = captureLog(t);
    const h = await setup(t, { hooks: false });
    const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    const path = `/v1/transactions/${started.body.transactionId}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("unreadable_interactive") }, null)).status, 200);
    const bodies = replaceOnce(h, "select");
    const reply = await h.request("a", `${path}/statements`, { sequence: 2, sql: "SELECT id, name FROM projects ORDER BY id", params: {} }, null);
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    assert.equal(reply.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    bounded(bodies, "interactive statement");
    await h.flush();
    assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK" || sql === "COMMIT"), false);
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 3 }, null)).body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.rows("a").filter((row) => row.id === "unreadable_interactive").length, 0);
    assert.deepEqual(recoveryOutcomes(lines).map(({ outcome }) => outcome), ["refused"]);
  });
}
