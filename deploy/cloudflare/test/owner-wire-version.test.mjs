// The owner wire version guards the message shape between a Worker and a Durable Object of
// different deployments (ADR 0022). With the versions different in either direction, a request
// whose COMMIT may have been sent is never definitely rejected: a commit whose reply is not read is
// POLICYSQL_COMMIT_OUTCOME_UNKNOWN, a message the object refuses 500, anything else (an atomic retry included) POLICYSQL_INTERNAL,
// and nothing runs or is recorded. A message of another version never reaches the machine, which
// would answer a changed body shape 400 POLICYSQL_INVALID_REQUEST (a definite rejection).
import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./helpers/routing.mjs";
import { durableObjectTransactionOwners } from "../src/adapters/durable-objects.ts";

const { REJECTIONS } = await import("../../../packages/client/protocol.js");
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const execute = "/v1/transactions:execute";
const WIRE = "x-policysql-owner-wire";

/** The owner namespace with `requestWire` / `replyWire` replacing the marker on the way (null drops it). */
const skewed = (namespace, { requestWire, replyWire }) => ({
  idFromName: (name) => namespace.idFromName(name),
  get: (id) => {
    const stub = namespace.get(id);
    return {
      async fetch(url, init) {
        const headers = { ...init.headers };
        if (requestWire !== undefined) { delete headers[WIRE]; if (requestWire !== null) headers[WIRE] = requestWire; }
        const response = await stub.fetch(url, { ...init, headers });
        if (replyWire === undefined) return response;
        const next = new Headers(response.headers);
        next.delete(WIRE);
        if (replyWire !== null) next.set(WIRE, replyWire);
        return new Response(response.body, { status: response.status, headers: next });
      },
    };
  },
});

const directions = [
  ["older Worker (message of another version)", { requestWire: "0" }],
  ["older Worker (message without a version)", { requestWire: null }],
  ["older object (reply of another version)", { replyWire: "0" }],
  ["older object (reply without a version)", { replyWire: null }],
];

for (const [label, skew] of directions) {
  test(`durable-objects: ${label}: a possibly-committed request is never definitely rejected, and nothing runs`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter: "durable-objects", hooks: true });
    h.setValidator(async () => true);
    const commits = () => h.events.filter(({ sql }) => sql === "COMMIT").length;
    // A committed interactive transaction and a committed keyed atomic write, both through matching versions.
    const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    const id = begun.body.transactionId;
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("wire_i") }, null)).status, 200);
    assert.equal((await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null)).status, 200);
    const key = "owner-wire-key-0000001";
    const atomic = { statements: [insert("wire_a")] };
    const first = await h.request("a", execute, atomic, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const committed = commits();
    const eventsBefore = h.events.length;
    const recordBefore = await h.ownerRecordRaw(id);

    const app = h.appWith(durableObjectTransactionOwners(skewed(h.ownerNamespace(), skew)));
    const send = async (path, body, idempotencyKey) => {
      const response = await app.fetch(new Request(`https://worker.test${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: JSON.stringify(body),
      }), { database: h.binding("a"), session: h.session("a") }, h.background);
      return { status: response.status, body: await response.json() };
    };
    const retryCommit = await send(`/v1/transactions/${id}/commit`, { sequence: 2 });
    // The object ran the message of a reply-side skew, so the Worker names the unknown outcome;
    // an object that got a message of another version answers 500 itself. Neither is a rejection.
    const messageSide = skew.requestWire !== undefined;
    assert.equal(retryCommit.status, messageSide ? 500 : 503, JSON.stringify(retryCommit.body));
    assert.equal(retryCommit.body.error.code, messageSide ? "POLICYSQL_INTERNAL" : "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
    const retryAtomic = await send(execute, atomic, key);
    assert.equal(retryAtomic.status, 500, JSON.stringify(retryAtomic.body));
    assert.equal(retryAtomic.body.error.code, "POLICYSQL_INTERNAL");
    assert.equal(commits(), committed, "no second COMMIT");
    const other = await send(execute, { statements: [insert("wire_other")] }, null);
    assert.equal(other.status, 500, JSON.stringify(other.body));
    // Neither is a rejection in the client.
    for (const reply of [retryCommit, retryAtomic, other]) {
      assert.equal(REJECTIONS.get(reply.status)?.includes(reply.body.error.code.slice("POLICYSQL_".length)) ?? false, false);
    }
    if (messageSide) {
      assert.equal(h.events.length, eventsBefore, "the object ran nothing");
      assert.equal(await h.ownerRecordRaw(id), recordBefore, "nothing reached the machine");
    }
    assert.equal(h.rows("a").filter((row) => row.id === "wire_a").length, 1);
    // An unkeyed request the object read is run once even if its reply is not read (the Worker
    // cannot tell); one the object refused is not run at all.
    assert.equal(h.rows("a").some((row) => row.id === "wire_other"), !messageSide);
    // The versions agree again: the keyed retry replays.
    assert.deepEqual((await h.request("a", execute, atomic, key)).body, first.body);
  });
}

test("durable-objects: an object answers a message of another version 500 whatever its body, never 400", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects", hooks: true });
  const name = `tx_${"a".repeat(32)}`;
  const stub = h.ownerNamespace().get(h.ownerNamespace().idFromName(name));
  for (const path of ["/begin", "/statement", "/commit", "/rollback", "/validation-query", "/atomic"]) {
    for (const wire of [{ [WIRE]: "0" }, {}]) {
      const response = await stub.fetch(`https://owner${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-policysql-owner": name, ...wire }, body: JSON.stringify({ transactionId: name, authFingerprint: "b".repeat(64), command: { sequence: 2 } }),
      });
      assert.equal(response.status, 500, path);
      assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL", path);
    }
  }
});
