// #104: an interactive COMMIT retry whose trusted session lost `execute` is answered with the
// definite 403 POLICYSQL_FORBIDDEN_ACCESS before the owner is looked up, even though the
// transaction's earlier COMMIT may have been sent. This is the intentional exception to ADR
// 0007's commit-retry rule: the wrapper authenticates every command and must stop a transaction
// after token expiry or revocation, and the owner must not report commit state to a principal
// the session gate no longer trusts. The client keeps reading the denial as a definite
// rejection; the caller cannot read it as "not committed" and resolves the outcome by reading
// its data. The exception stays narrow: with the same denied session a keyed atomic execute is
// the unknown 500 (#85 path 1, keyed-compile-failure.test.mjs) and an unkeyed interactive
// statement is also the definite 403.
//
// Both owner adapters, interactive without and with a commit check: the placements that send a
// COMMIT interactively.
import assert from "node:assert/strict";
import test from "node:test";
import { countingOwners, harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlError, PolicySqlOutcomeUnknownError } from "../../../packages/client/index.js";
import { REJECTIONS, sendCommand } from "../../../packages/client/protocol.js";

const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const commits = (h) => h.events.filter(({ sql }) => sql === "COMMIT").length;
const count = (h, id) => h.rows("a").filter((row) => row.id === id).length;
const PLACEMENTS = [
  { name: "interactive", hooks: false },
  { name: "interactive with a commit check", hooks: true },
];

// An app whose TransactionOwner port counts every lookup, like the probes in
// trusted-session.test.mjs: a denied command must not reach the owner at all.
const probe = (h) => {
  const { counts, port } = countingOwners(h.transactionOwners);
  const app = h.appWith(port);
  const send = async (path, body, session, idempotencyKey) => {
    const response = await app.fetch(new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    }), { database: h.binding("a"), session }, h.background);
    return { status: response.status, body: await response.json() };
  };
  return { counts, send };
};

// The client's documented reading: a 403 FORBIDDEN_ACCESS (or a 401) rejects the request
// itself, rather than making its outcome unknown.
const definite = async (response, kind) => {
  const code = response.body.error.code.slice("POLICYSQL_".length);
  assert.equal(REJECTIONS.get(response.status)?.includes(code), true, `${response.status} ${code} is a rejection pair`);
  const transport = async () => ({ status: response.status, body: response.body });
  await assert.rejects(sendCommand(transport, { kind }, {}, () => {}), (error) =>
    error instanceof PolicySqlError && !(error instanceof PolicySqlOutcomeUnknownError) &&
    error.code === "POLICYSQL_FORBIDDEN_ACCESS");
};
const unknown = async (response, kind) => {
  const transport = async () => ({ status: response.status, body: response.body });
  await assert.rejects(sendCommand(transport, { kind }, {}, () => {}), PolicySqlOutcomeUnknownError);
};

for (const ownerAdapter of OWNER_ADAPTERS) {
  for (const placement of PLACEMENTS) {
    test(`${ownerAdapter}/${placement.name}: a commit retry denied by the session gate is a definite 403 and never reaches the owner`, async (t) => {
      t.mock.method(console, "log", () => {});
      const h = await harness(t, { ownerAdapter, hooks: placement.hooks });
      h.setValidator(async () => true);
      const { counts, send } = probe(h);
      const session = h.session("a");

      const begun = await send("/v1/transactions", { mode: "write" }, session);
      assert.equal(begun.status, 201, JSON.stringify(begun.body));
      const transactionId = begun.body.transactionId;
      const path = `/v1/transactions/${transactionId}`;
      const statement = await send(`${path}/statements`, { sequence: 1, ...insert("commit_gate") }, session);
      assert.equal(statement.status, 200, JSON.stringify(statement.body));

      const before = {
        events: h.events.length,
        hookChecks: h.hooksSeen.length,
        bindingChecks: h.counts().checks,
        connects: h.counts().connects,
        lookups: counts.lookups,
        forwarded: h.ownerInputs(transactionId).length,
        commits: commits(h),
        rows: count(h, "commit_gate"),
      };
      assert.equal(before.rows, 0, "the write is not visible before COMMIT");

      // A deploy in which the session no longer grants `execute` (the role lost it).
      const reduced = h.session("a", { access: ["catalog"] });
      const rejected = await send(`${path}/commit`, { sequence: 2 }, reduced);
      assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
      // The engine's `command` authorizes before `owner(...)`: nothing reached the owner and no
      // COMMIT was sent, so the owner's record is untouched.
      assert.equal(counts.lookups, before.lookups, "no owner lookup");
      assert.equal(h.ownerInputs(transactionId).length, before.forwarded, "nothing forwarded to the owner");
      assert.equal(h.events.length, before.events, "no database statement");
      assert.equal(h.hooksSeen.length, before.hookChecks, "no commit check");
      assert.equal(h.counts().checks, before.bindingChecks, "no database binding check");
      assert.equal(h.counts().connects, before.connects, "no connection");
      assert.equal(commits(h), before.commits, "no COMMIT");
      assert.equal(count(h, "commit_gate"), before.rows, "rows unchanged");
      // The client takes the answer as a definite rejection of this commit, not as unknown.
      await definite(rejected, "commit");

      // Contrast, already pinned by keyed-compile-failure.test.mjs (#85 path 1): with the same
      // denied session, a keyed atomic execute is the unknown 500, while an unkeyed interactive
      // statement is also the definite 403. Neither runs.
      const atomic = await send(
        "/v1/transactions:execute", { statements: [insert("commit_gate_atomic")] }, reduced, "commit-gate-atomic-0001",
      );
      assert.equal(atomic.status, 500, JSON.stringify(atomic.body));
      assert.equal(atomic.body.error.code, "POLICYSQL_INTERNAL");
      await unknown(atomic, "execute");
      assert.equal(count(h, "commit_gate_atomic"), 0, "the atomic write never ran");

      const deniedStatement = await send(`${path}/statements`, { sequence: 2, ...insert("commit_gate_denied") }, reduced);
      assert.equal(deniedStatement.status, 403, JSON.stringify(deniedStatement.body));
      assert.equal(deniedStatement.body.error.code, "POLICYSQL_FORBIDDEN_ACCESS");
      await definite(deniedStatement, "statement");
      assert.equal(count(h, "commit_gate_denied"), 0, "the statement never ran");

      assert.equal(commits(h), before.commits, "still no COMMIT");
      assert.equal(h.ownerInputs(transactionId).length, before.forwarded, "still nothing forwarded to the owner");

      // The denied commit consumed no sequence: restoring the session lets the same commit run
      // normally, once, and the write applies exactly once.
      const restored = await send(`${path}/commit`, { sequence: 2 }, session);
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal(commits(h), before.commits + 1, "exactly one COMMIT");
      assert.equal(count(h, "commit_gate"), 1, "the write applied exactly once");
      assert.equal(h.ownerInputs(transactionId).length, before.forwarded + 1, "one commit forwarded");
      assert.equal(h.ownerInputs(transactionId).at(-1).kind, "commit");
    });
  }
}
