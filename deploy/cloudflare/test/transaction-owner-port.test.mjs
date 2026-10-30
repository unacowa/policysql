// TransactionOwner port conformance (ADR 0022). One suite, run against every adapter: the
// production Durable Objects adapter over a simulated platform, and the in-memory adapter.
// Each case drives the public HTTP routes through the real WASM core, the real HTTP database
// transport, and SQLite; only the owner platform differs. A custom adapter passes this suite
// by adding itself to OWNER_ADAPTERS in helpers/routing.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { createApp } from "../src/app.ts";
import { durableObjectTransactionOwners, durableObjectTransactionOwnerClass, executionContextTasks } from "../src/adapters/durable-objects.ts";
import { testBinding, testConfig, testOwners, testProvider } from "./helpers/database.mjs";
import { limitsJson } from "./helpers/limits.mjs";
import { referenceTranscript } from "./helpers/reference-transcript.mjs";

const read = { sql: "SELECT id, name FROM projects ORDER BY id", params: {} };
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });
const statements = (h, prefix) => h.events.filter(({ sql }) => sql.startsWith(prefix)).length;

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, options = {}) => harness(t, { ownerAdapter, ...options });
  const start = async (h, mode, key = null, tenant = "a") => {
    const started = await h.request(tenant, "/v1/transactions", { mode }, key);
    assert.equal(started.status, 201, JSON.stringify(started.body));
    return started.body.transactionId;
  };

  test(`${ownerAdapter}: commands to one owner are serialized in arrival order`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "read");
    const path = `/v1/transactions/${id}/statements`;
    // Identical concurrent retries: the first executes, the second replays its response.
    const before = statements(h, "SELECT");
    const duplicates = await Promise.all([1, 2].map(() => h.request("a", path, { sequence: 1, ...read }, null)));
    assert.deepEqual(duplicates.map((result) => result.status), [200, 200]);
    assert.deepEqual(duplicates[1].body, duplicates[0].body);
    assert.equal(statements(h, "SELECT") - before, 1, "one execution for two identical commands");
    // Different concurrent commands for the same sequence: whichever reaches the owner second
    // (the Worker-side steps before the owner may reorder them) conflicts and rolls back.
    const different = await Promise.all([
      h.request("a", path, { sequence: 2, ...read }, null),
      h.request("a", path, { sequence: 2, sql: "SELECT id FROM projects", params: {} }, null),
    ]);
    assert.deepEqual(different.map((result) => result.status).sort(), [200, 409]);
    assert.equal(different.find((result) => result.status === 409).body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
  });

  test(`${ownerAdapter}: commands are processed in the order they reach the owner, whatever their body timing`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    // The owner input the engine forwards: the session and the verified body text (ADR 0024).
    const { auth, databaseBinding, snapshot } = h.ownerInputs(id)[0].input;
    const owner = h.transactionOwners.route(id);
    const input = (command) => ({ transactionId: id, auth, command: JSON.stringify(command), databaseBinding, snapshot });
    // The first message's body is delivered late. A later command must not overtake it:
    // overtaking would put sequence 2 before 1 and fail the transaction (ADR 0007).
    h.delayNextOwnerBody(30);
    const replies = await Promise.all([
      owner.command("statement", input({ sequence: 1, ...insert("ordered") }), "req_1"),
      owner.command("commit", input({ sequence: 2 }), "req_2"),
    ]);
    assert.deepEqual(replies.map((reply) => reply.ok), [true, true], JSON.stringify(replies));
    assert.equal(replies[1].value.status, "committed");
    assert.ok(h.rows("a").some((row) => row.id === "ordered"));
  });

  test(`${ownerAdapter}: timer expiry and owner loss while a commit waits on its validator never commit`, async (t) => {
    const h = await setup(t);
    for (const [label, interrupt] of [["expired", (id) => h.fireTimer(id)], ["lost", (id) => h.loseOwner(id)]]) {
      const id = await start(h, "write");
      const path = `/v1/transactions/${id}`;
      assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert(label) }, null)).status, 200);
      h.setValidator(async () => { await interrupt(id); return true; });
      const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
      const retry = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
      if (label === "expired") {
        // Expiry ends the commit on the waiting lane at once: the check is rejected, rolled
        // back, and recorded expired; the late verdict is ignored (ADR 0024 inconsistency 5).
        assert.equal(commit.status, 409, label);
        assert.equal(commit.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED", label);
        assert.equal((await h.ownerRecord(id)).status, "expired", label);
      } else {
        // The lost owner cannot record anything; its successor has no open transaction.
        assert.equal(commit.status, 500, label);
        assert.equal(commit.body.error.code, "POLICYSQL_INTERNAL", label);
        assert.equal(retry.status, 409, label);
        assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", label);
      }
      assert.notEqual(commit.body.status, "committed", label);
      assert.notEqual(retry.body.status, "committed", label);
      assert.equal(h.rows("a").some((row) => row.id === label), false, label);
    }
  });

  test(`${ownerAdapter}: one name has exactly one owner, and names are isolated`, async (t) => {
    const h = await setup(t, { hooks: false });
    // The same start key, concurrently: one owner, one database transaction.
    const keyed = await Promise.all([1, 2].map(() => h.request("a", "/v1/transactions", { mode: "read" }, "same-start-key-0001")));
    assert.deepEqual(keyed.map((result) => result.status), [201, 201]);
    assert.equal(keyed[0].body.transactionId, keyed[1].body.transactionId);
    assert.deepEqual(h.ownerNames(), [keyed[0].body.transactionId]);
    assert.equal(statements(h, "BEGIN"), 1);
    // Unkeyed starts get separate owners whose state does not mix.
    const [first, second] = await Promise.all([start(h, "read"), start(h, "write")]);
    assert.notEqual(first, second);
    assert.equal(h.ownerNames().length, 3);
    assert.deepEqual([(await h.ownerRecord(first)).mode, (await h.ownerRecord(second)).mode], ["read", "write"]);
    assert.equal((await h.request("a", `/v1/transactions/${first}/rollback`, { sequence: 1 }, null)).status, 200);
    assert.equal((await h.ownerRecord(second)).status, "active");
  });

  test(`${ownerAdapter}: owner loss fails the transaction closed and never reconnects`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("lost") }, null)).status, 200);
    const connects = h.counts().connects;
    h.loseOwner(id);
    const after = await h.request("a", `${path}/statements`, { sequence: 2, ...read }, null);
    assert.equal(after.status, 409);
    assert.equal(after.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal((await h.ownerRecord(id)).status, "failed");
    const commit = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(commit.status, 409, "a lost transaction is never reported committed");
    assert.equal(h.counts().connects, connects, "no replacement connection");
    assert.equal(h.rows("a").some((row) => row.id === "lost"), false);
  });

  test(`${ownerAdapter}: the owner timer expires an open transaction and rolls it back`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    assert.equal(h.ownerTimerAt(id), (await h.ownerRecord(id)).expiresAtMs, "begin schedules expiry at the deadline");
    assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("expired") }, null)).status, 200);
    assert.equal(await h.fireTimer(id), true);
    assert.equal((await h.ownerRecord(id)).status, "expired");
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
    const after = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
    assert.equal(after.status, 409);
    assert.equal(h.rows("a").some((row) => row.id === "expired"), false);
  });

  test(`${ownerAdapter}: exact retry replays a command and a terminal response; a changed payload conflicts`, async (t) => {
    const h = await setup(t, { hooks: false });
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    const command = { sequence: 1, ...insert("retried") };
    const first = await h.request("a", `${path}/statements`, command, null);
    assert.deepEqual((await h.request("a", `${path}/statements`, command, null)).body, first.body);
    assert.equal(statements(h, 'INSERT INTO "projects"'), 1);
    const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(committed.body.status, "committed");
    assert.deepEqual((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).body, committed.body);
    assert.equal((await h.request("a", `${path}/rollback`, { sequence: 2 }, null)).status, 409, "a different terminal command conflicts");
    assert.equal(h.rows("a").filter((row) => row.id === "retried").length, 1);

    const other = await start(h, "write");
    const otherPath = `/v1/transactions/${other}/statements`;
    assert.equal((await h.request("a", otherPath, { sequence: 1, ...insert("kept") }, null)).status, 200);
    const changed = await h.request("a", otherPath, { sequence: 1, ...insert("changed") }, null);
    assert.equal(changed.status, 409);
    assert.equal((await h.ownerRecord(other)).status, "failed");
  });

  // #48 (ADR 0007): once COMMIT may have been sent, a repeated commit is answered with the
  // recorded reply or with POLICYSQL_COMMIT_OUTCOME_UNKNOWN, never with a 409 rejection.
  const UNKNOWN = "POLICYSQL_COMMIT_OUTCOME_UNKNOWN";
  const committedOnce = (h, id) => {
    assert.equal(h.rows("a").filter((row) => row.id === id).length, 1, `${id}: the database committed`);
  };
  const openWrite = async (h, label) => {
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert(label) }, null)).status, 200);
    return { id, commit: () => h.request("a", `${path}/commit`, { sequence: 2 }, null) };
  };
  const once = (fault) => {
    let done = false;
    return (input) => {
      if (done) return undefined;
      const result = fault(input);
      if (result) done = true;
      return result;
    };
  };
  const unknown = (reply, label) => {
    assert.equal(reply.status, 503, `${label}: ${JSON.stringify(reply.body)}`);
    assert.equal(reply.body.error.code, UNKNOWN, label);
    assert.equal(reply.body.error.message, "The commit outcome is unknown.", label);
  };

  test(`${ownerAdapter}: owner loss after COMMIT, before its record (window A), leaves a commit retry unknown, never rejected`, async (t) => {
    t.mock.method(console, "log", () => {});
    for (const hooks of [false, true]) {
      const h = await setup(t, { hooks });
      const label = hooks ? "window_a_checked" : "window_a";
      const { id, commit } = await openWrite(h, label);
      h.afterDatabaseStatement(once(({ sql }) => sql === "COMMIT" && (h.loseOwner(id), true)));
      const first = await commit();
      const record = await h.ownerRecord(id);
      for (const attempt of [1, 2]) unknown(await commit(), `${label} retry ${attempt}`);
      // The lost owner cannot record anything, but its COMMIT applied: the reply says so.
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, "committed");
      assert.equal(record.status, "committing", "the successor finds the record written before COMMIT");
      // The successor records the unknown outcome (ADR 0024 failure table); never a rejection.
      assert.equal((await h.ownerRecord(id)).status, "commit_unknown");
      committedOnce(h, label);
      // Other commands are still unavailable: nothing executes on a lost connection.
      assert.equal((await h.request("a", `/v1/transactions/${id}/rollback`, { sequence: 2 }, null)).status, 409);
      assert.equal(await h.fireTimer(id), true);
      assert.equal((await h.ownerRecord(id)).status, "commit_unknown", "the timer never expires a commit that was sent");
      unknown(await commit(), `${label} after the timer`);
    }
  });

  test(`${ownerAdapter}: owner loss between the committed status and its reply (window B) replays the commit`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "window_b");
    // The first put that says `committed` lands, then the owner is lost. The previous
    // release wrote `last` in a second put after this one.
    h.interceptOwnerPut(once(({ value }) => value?.status === "committed" && { lose: true }));
    const first = await commit();
    const retry = await commit();
    assert.notEqual(retry.status, 409, JSON.stringify(retry.body));
    // The committed record and its reply are one put, so the successor replays the reply.
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, first.body);
    const record = await h.ownerRecord(id);
    assert.equal(record.status, "committed");
    assert.equal(record.nextSequence, 3);
    assert.deepEqual(record.last.response, first.body);
    committedOnce(h, "window_b");
  });

  // ADR 0024 "Old-format records are discarded, not read": a record the TypeScript owner wrote
  // before the switch-over (pull request 7) is unreadable to the step machine. Whatever its
  // status, a commit gets POLICYSQL_COMMIT_OUTCOME_UNKNOWN (nothing in it proves that COMMIT was
  // not sent) and every other command POLICYSQL_TRANSACTION_UNAVAILABLE; nothing executes, and
  // the record is replaced by a tombstone that is answered alike. A one-time incompatibility.
  const oldFormatRecords = (id, binding) => {
    const base = {
      databaseBinding: binding, snapshot: binding.snapshot, transactionId: id, authFingerprint: "b".repeat(64),
      startFingerprint: "c".repeat(64), mode: "write",
      auth: { principal: "x", subject: "u", role: "member", roles: ["member"], access: ["execute"], session: {} },
      nextSequence: 2, usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 }, statementCount: 1, resultBytes: 10,
      mutations: [], commitChecks: [], schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1",
    };
    const reply = { transactionId: id, status: "committed", meta: { requestId: "old", commitChecks: "not_triggered" } };
    return {
      // #48's records, and the release before it.
      committing: { ...base, status: "committing", commitRecording: 1, commitSent: { sequence: 2, digest: "d".repeat(64) }, expiresAtMs: Date.now() + 60_000 },
      committed: { ...base, status: "committed", commitRecording: 1, nextSequence: 3, last: { digest: "d".repeat(64), response: reply } },
      committedStale: { ...base, status: "committed", last: { digest: "e".repeat(64), response: {} } },
      active: { ...base, status: "active", expiresAtMs: Date.now() + 60_000, last: null },
      failed: { ...base, status: "failed", commitRecording: 1, commitSent: { sequence: 2, digest: "d".repeat(64) } },
      expired: { ...base, status: "expired" },
      rolledBack: { ...base, status: "rolled_back", nextSequence: 3, last: { digest: "f".repeat(64), response: { ...reply, status: "rolled_back" } } },
    };
  };
  const KINDS = ["commit", "statement", "rollback"];

  test(`${ownerAdapter}: a record of the TypeScript owner is discarded: commit unknown, other commands unavailable`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const binding = h.binding("a");
    const labels = Object.keys(oldFormatRecords("tx_", binding));
    for (const [index, label] of labels.entries()) {
      for (const [order, first] of KINDS.entries()) {
        const id = `tx_${index.toString(16).padStart(2, "0")}${order}${"a".repeat(29)}`;
        h.plantOwnerRecord(id, oldFormatRecords(id, binding)[label]);
        const connects = h.counts().connects;
        const events = h.events.length;
        const path = `/v1/transactions/${id}`;
        const send = (kind) => kind === "commit" ? h.request("a", `${path}/commit`, { sequence: 2 }, null)
          : kind === "rollback" ? h.request("a", `${path}/rollback`, { sequence: 2 }, null)
            : h.request("a", `${path}/statements`, { sequence: 2, ...read }, null);
        // The first command finds the old record, the later ones its tombstone: all alike.
        for (const kind of [first, ...KINDS]) {
          const reply = await send(kind);
          if (kind === "commit") unknown(reply, `${label}: commit (first ${first})`);
          else {
            assert.equal(reply.status, 409, `${label}: ${kind} (first ${first}): ${JSON.stringify(reply.body)}`);
            assert.equal(reply.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", `${label}: ${kind}`);
          }
        }
        assert.equal(h.counts().connects, connects, `${label}: no connection is opened`);
        assert.equal(h.events.length, events, `${label}: no SQL runs`);
        const record = await h.ownerRecord(id);
        assert.equal(record.status, "discarded", `${label}: replaced by a tombstone`);
        assert.equal(record.owner, id);
      }
    }
  });

  test(`${ownerAdapter}: a timer or callback query for a record of the TypeScript owner never makes its commit a rejection`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const binding = h.binding("a");
    const id = `tx_${"7".repeat(32)}`;
    h.plantOwnerRecord(id, oldFormatRecords(id, binding).committing);
    // A callback query: no validation runs on this owner, so it is unavailable.
    const callback = await h.request("a", `/v1/commit-checks/cval_${"7".repeat(32)}/query`, { sequence: 1, ...read }, undefined, "A".repeat(43));
    assert.equal(callback.status, 409, JSON.stringify(callback.body));
    assert.equal(callback.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    unknown(await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null), "commit after the callback");
    // The old owner's alarm, delivered to the new one.
    const timed = `tx_${"8".repeat(32)}`;
    h.plantOwnerRecord(timed, oldFormatRecords(timed, binding).active);
    await h.ownerCore(timed).onTimer();
    assert.equal((await h.ownerRecord(timed)).status, "discarded");
    unknown(await h.request("a", `/v1/transactions/${timed}/commit`, { sequence: 2 }, null), "commit after the timer");
  });

  test(`${ownerAdapter}: a failed store put after COMMIT, without owner loss, never makes a commit retry a rejection`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    // The terminal put fails: the reply says committed (true), and the owner resets, so it
    // answers every retry from the store as a successor would: `committing`, so unknown
    // (ADR 0007 "No in-memory re-recording", ADR 0024 failure table).
    const stuck = await openWrite(h, "put_failed");
    let failing = true;
    h.interceptOwnerPut(({ value }) => (failing && value?.status === "committed" ? { fail: true } : undefined));
    const first = await stuck.commit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "committed");
    assert.equal((await h.ownerRecord(stuck.id)).status, "committing");
    for (const attempt of [1, 2]) unknown(await stuck.commit(), `retry ${attempt}`);
    committedOnce(h, "put_failed");
    // The store recovers: still unknown, from this owner and a successor alike.
    failing = false;
    unknown(await stuck.commit(), "after the store recovered");
    assert.equal((await h.ownerRecord(stuck.id)).status, "commit_unknown");
    h.loseOwner(stuck.id);
    unknown(await stuck.commit(), "successor");
    committedOnce(h, "put_failed");
  });

  test(`${ownerAdapter}: a store failure after a COMMIT transport error still answers the unknown outcome`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "commit_lost_put_failed");
    h.afterDatabaseStatement(once(({ sql }) => {
      if (sql === "COMMIT") throw new Error("connection reset");
      return undefined;
    }));
    h.interceptOwnerPut(once(({ value }) => value?.status === "commit_unknown" && { fail: true }));
    unknown(await commit(), "first reply");
    assert.equal((await h.ownerRecord(id)).status, "committing");
    unknown(await commit(), "retry");
    assert.equal((await h.ownerRecord(id)).status, "commit_unknown");
    committedOnce(h, "commit_lost_put_failed");
  });

  test(`${ownerAdapter}: a deadline that passes once committing is stored sends no COMMIT and rejects`, async (t) => {
    t.mock.method(console, "log", () => {});
    const now = Date.now;
    const late = (h, label) => {
      h.interceptOwnerPut(once(({ value }) => {
        if (value?.status !== "committing") return undefined;
        // Time moves past the transaction deadline right after `committing` lands.
        Date.now = () => now() + 60_000;
        return {};
      }));
      return label;
    };
    t.after(() => { Date.now = now; });
    const h = await setup(t, { hooks: false });
    const expired = await openWrite(h, late(h, "deadline_passed"));
    const rejected = await expired.commit();
    Date.now = now;
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false, "COMMIT was never sent");
    assert.ok(h.events.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal((await h.ownerRecord(expired.id)).status, "expired");
    assert.equal((await expired.commit()).status, 409);
    assert.equal(h.rows("a").some((row) => row.id === "deadline_passed"), false);
    // If `expired` cannot be stored, `committing` stays: 500 now, and the retry is unknown.
    const unstored = await openWrite(h, "deadline_unstored");
    let committingSeen = false;
    h.interceptOwnerPut(({ value }) => {
      if (value?.status === "committing" && !committingSeen) {
        committingSeen = true;
        Date.now = () => now() + 60_000;
        return {};
      }
      return value?.status === "expired" ? { fail: true } : undefined;
    });
    const failed = await unstored.commit();
    Date.now = now;
    h.interceptOwnerPut(null);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, "POLICYSQL_INTERNAL");
    assert.equal((await h.ownerRecord(unstored.id)).status, "committing");
    unknown(await unstored.commit(), "retry after an unstored expiry");
    assert.equal(h.rows("a").some((row) => row.id === "deadline_unstored"), false);
  });

  // A deployment between a commit and its retry changes the snapshot, and with it the
  // database binding and the auth fingerprint the Worker sends.
  const deploy = (h) => Object.defineProperty(h.runtime, "snapshot", { value: `${h.runtime.snapshot}-next`, configurable: true });

  test(`${ownerAdapter}: a deployment between a commit and its retry keeps the commit answer`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "deployed");
    const first = await commit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    deploy(h);
    const replay = await commit();
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);
    committedOnce(h, "deployed");
    // Every other command still requires the current snapshot.
    const path = `/v1/transactions/${id}`;
    for (const [route, body] of [["rollback", { sequence: 2 }], ["statements", { sequence: 3, ...read }], ["commit", { sequence: 3 }]]) {
      const other = await h.request("a", `${path}/${route}`, body, null);
      assert.equal(other.status, 409, route);
      assert.equal(other.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", route);
    }
  });

  test(`${ownerAdapter}: window A and then a deployment leave a commit retry unknown`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "window_a_deployed");
    h.afterDatabaseStatement(once(({ sql }) => sql === "COMMIT" && (h.loseOwner(id), true)));
    await commit();
    deploy(h);
    unknown(await commit(), "retry after the deployment");
    committedOnce(h, "window_a_deployed");
  });

  test(`${ownerAdapter}: a commit retry from another principal or database is rejected, before and after a deployment`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id } = await openWrite(h, "foreign");
    h.afterDatabaseStatement(once(({ sql }) => sql === "COMMIT" && (h.loseOwner(id), true)));
    const path = `/v1/transactions/${id}/commit`;
    const own = await h.request("a", path, { sequence: 2 }, null);
    assert.equal(own.status, 200);
    const strangers = [
      ["another subject", "a", h.session("a", { subject: "other_user" })],
      ["another principal", "a", h.session("a", { principal: "https://issuer.test:other_user" })],
      ["another role", "a", h.session("a", { roles: ["member", "reader"], defaultRole: "reader" })],
      ["another session", "a", h.session("a", { session: { tenant_id: "tenant_b" } })],
      ["another database", "b", h.session("a")],
    ];
    for (const deployed of [false, true]) {
      if (deployed) deploy(h);
      for (const [label, tenant, credential] of strangers) {
        const reply = await h.request(tenant, path, { sequence: 2 }, null, credential);
        assert.equal(reply.status, 409, `${label}, deployed ${deployed}: ${JSON.stringify(reply.body)}`);
        assert.equal(reply.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", label);
        assert.notEqual(reply.body.error?.code, UNKNOWN, label);
        assert.equal(Object.hasOwn(reply.body, "status"), false, label);
      }
      // The owner itself still answers the unknown outcome.
      unknown(await h.request("a", path, { sequence: 2 }, null), `owner, deployed ${deployed}`);
    }
  });

  test(`${ownerAdapter}: a transport error during COMMIT is an unknown outcome, never a failed status`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "commit_lost");
    // The remote database applies COMMIT, and its reply is lost.
    h.afterDatabaseStatement(once(({ sql }) => {
      if (sql === "COMMIT") throw new Error("connection reset");
      return undefined;
    }));
    const first = await commit();
    unknown(first, "first reply");
    // Recorded as an unknown outcome, never as failed (ADR 0024 inconsistency 4).
    assert.equal((await h.ownerRecord(id)).status, "commit_unknown");
    unknown(await commit(), "retry");
    committedOnce(h, "commit_lost");
  });

  test(`${ownerAdapter}: the timer firing while COMMIT is in flight does not end the transaction`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "timer_in_commit");
    h.afterDatabaseStatement(once(({ sql }) => sql === "COMMIT" && h.fireTimer(id)));
    const first = await commit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, "committed");
    assert.equal((await h.ownerRecord(id)).status, "committed");
    assert.deepEqual((await commit()).body, first.body);
    assert.equal(h.events.some(({ sql }) => sql === "ROLLBACK"), false);
    committedOnce(h, "timer_in_commit");
  });

  test(`${ownerAdapter}: a failed store put before COMMIT sends no COMMIT and stays a definite rejection`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t, { hooks: false });
    const { id, commit } = await openWrite(h, "not_sent");
    h.interceptOwnerPut(once(({ value }) => value?.status === "committing" && { fail: true }));
    const first = await commit();
    assert.equal(first.status, 500);
    assert.equal(first.body.error.code, "POLICYSQL_INTERNAL");
    assert.equal(h.events.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal((await h.ownerRecord(id)).status, "failed");
    const retry = await commit();
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
    assert.equal(h.rows("a").some((row) => row.id === "not_sent"), false);
  });

  test(`${ownerAdapter}: a keyed atomic execute resolves through policysql_idempotency after owner loss at COMMIT`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await setup(t);
    const body = { statements: [insert("atomic_lost")] };
    const key = "atomic-commit-window-01";
    h.afterDatabaseStatement(once(({ sql }) => sql === "COMMIT" && (h.loseOwner(h.ownerNames().at(-1)), true)));
    const first = await h.request("a", "/v1/transactions:execute", body, key);
    assert.notEqual(first.status, 409, JSON.stringify(first.body));
    const retry = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    committedOnce(h, "atomic_lost");
    // A failed put of the owner record after COMMIT no longer turns the committed reply
    // into a 500.
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(retry.body.results, first.body.results);
    assert.equal(retry.body.meta.requestId, first.body.meta.requestId, "the stored reply is replayed");
  });

  test(`${ownerAdapter}: commit-check callbacks reach the owner of the open transaction`, async (t) => {
    const h = await setup(t);
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("checked") }, null)).status, 200);
    const committed = await h.request("a", `${path}/commit`, { sequence: 2 }, null);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.meta.commitChecks, "passed");
    assert.equal(h.hooksSeen.length, 1);
    const [{ hook, status, result }] = h.hooksSeen;
    assert.equal(status, 200, JSON.stringify(result));
    assert.equal(hook.validationId, id.replace(/^tx_/u, "cval_"), "the capability names this owner");
    assert.ok(result.rows.some((row) => row.id === "checked"), "the callback sees the owner's uncommitted row");
    assert.deepEqual(h.ownerNames(), [id], "the callback created no other owner");
    // A callback for a name with no open transaction is unavailable, and a capability
    // the owner did not issue fails the check and rolls back.
    const stranger = await h.request("a", `/v1/commit-checks/cval_${"0".repeat(32)}/query`, { sequence: 1, ...read }, undefined, "A".repeat(43));
    assert.equal(stranger.status, 409);
    const forged = await start(h, "write");
    h.setValidator(async (issued) => {
      const response = await h.request("a", new URL(issued.query.url).pathname, { sequence: 1, ...read }, undefined, "B".repeat(43));
      assert.equal(response.status, 409);
      return true;
    });
    assert.equal((await h.request("a", `/v1/transactions/${forged}/statements`, { sequence: 1, ...insert("forged") }, null)).status, 200);
    const rejected = await h.request("a", `/v1/transactions/${forged}/commit`, { sequence: 2 }, null);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "POLICYSQL_COMMIT_CHECK_REJECTED");
    assert.equal(h.rows("a").some((row) => row.id === "forged"), false);
  });

  test(`${ownerAdapter}: the owner pins the database binding for commands and callbacks (ADR 0014)`, async (t) => {
    const h = await setup(t);
    const id = await start(h, "write");
    const path = `/v1/transactions/${id}`;
    // Another database's binding cannot drive this owner, and does not end it.
    const crossed = await h.request("b", `${path}/statements`, { sequence: 1, ...insert("pinned") }, null);
    assert.equal(crossed.status, 409);
    assert.equal((await h.ownerRecord(id)).databaseBinding.databaseId, "db_a");
    assert.equal((await h.request("a", `${path}/statements`, { sequence: 1, ...insert("pinned") }, null)).status, 200);
    const before = h.events.length;
    assert.equal((await h.request("a", `${path}/commit`, { sequence: 2 }, null)).status, 200);
    assert.ok(h.events.slice(before).every((event) => event.tenant === "a"), "callback and commit use the pinned database");
    assert.ok(h.hooksSeen[0].result.rows.every((row) => row.id !== "seed" || row.name === "database_a"));
    assert.ok(h.rows("a").some((row) => row.id === "pinned"));
    assert.equal(h.rows("b").some((row) => row.id === "pinned"), false);
  });
}

// Durable Objects adapter specifics, beyond the shared contract.
test("durable-objects: the wire to the object is the internal HTTP form, and replies come back as data", async () => {
  const sent = [];
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      async fetch(url, init) {
        sent.push({ name: id.name, url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        const marked = { headers: { "x-policysql-owner-wire": "1" } };
        if (new URL(url).pathname === "/rollback") {
          return Response.json({ error: { code: "POLICYSQL_TRANSACTION_CONFLICT", message: "m", path: null, requestId: "old" } }, { status: 409, ...marked });
        }
        return Response.json({ started: true }, { status: 201, ...marked });
      },
    }),
  };
  const owner = durableObjectTransactionOwners(namespace).route(`tx_${"a".repeat(32)}`);
  // A 2xx reply is the value; any other is the error, whatever its wire status (ADR 0023).
  assert.deepEqual(await owner.begin({ transactionId: "x" }, "req_1"), { ok: true, value: { started: true } });
  await owner.command("statement", { transactionId: "x" }, "req_2");
  assert.deepEqual(await owner.command("rollback", { transactionId: "x" }, "req_3"),
    { ok: false, error: { code: "POLICYSQL_TRANSACTION_CONFLICT", message: "m", path: null } });
  await owner.callbackQuery({ validationId: `cval_${"a".repeat(32)}`, capability: "cap", command: '{"sequence":1}' }, "req_4");
  assert.deepEqual(sent.map(({ url }) => new URL(url).pathname), ["/begin", "/statement", "/rollback", "/validation-query"]);
  assert.ok(sent.every(({ name, method }) => name === `tx_${"a".repeat(32)}` && method === "POST"));
  // Every message names the owner it was routed to (ADR 0024: the machine checks it).
  assert.ok(sent.every(({ headers }) => headers["x-policysql-owner"] === `tx_${"a".repeat(32)}`));
  assert.ok(sent.every(({ headers }) => headers["x-policysql-owner-wire"] === "1"), "every message carries the wire version");
  // The callback is the forwarded owner input, the capability and the verified text included.
  assert.equal(sent[3].headers.authorization, undefined);
  assert.equal(sent[3].headers["x-policysql-request-id"], "req_4");
  assert.deepEqual(sent[3].body, { validationId: `cval_${"a".repeat(32)}`, capability: "cap", command: '{"sequence":1}' });
  await assert.rejects(owner.command("unknown", {}, "req"), TypeError);
  assert.throws(() => durableObjectTransactionOwners(undefined), TypeError);
  assert.throws(() => durableObjectTransactionOwners({ get() {} }), TypeError);
});

test("durable-objects: a non-JSON object reply is a safe 500, never forwarded", async (t) => {
  t.mock.method(console, "log", () => {});
  const namespace = { idFromName: (name) => name, get: () => ({ fetch: async () => new Response("<html>internal detail</html>", { status: 500 }) }) };
  const runtime = { snapshot: "test-snapshot", max_bytes_per_value: 1_024, limits_json: limitsJson(), authorize_session_json: () => JSON.stringify({ ok: true }) };
  const app = createApp({ getRuntime: () => runtime, database: testProvider(), config: testConfig(), transactionOwners: durableObjectTransactionOwners(namespace) });
  const response = await app.fetchCallback(new Request(`https://worker.test/v1/commit-checks/cval_${"0".repeat(32)}/query`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sequence: 1, ...read }),
  }));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, "POLICYSQL_INTERNAL");
  assert.equal(text.includes("internal detail"), false);
});

test("durable-objects: the object class decodes the internal messages and fails malformed ones as invalid", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects", hooks: false });
  const values = new Map();
  let alarm = null;
  const state = {
    waitUntil() {},
    storage: { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); }, async setAlarm(at) { alarm = at; } },
  };
  const snapshot = h.runtime.snapshot;
  const OwnerObject = durableObjectTransactionOwnerClass(() => ({
    getRuntime: () => h.runtime,
    database: testProvider(() => ({ begin: async () => ({ open: true, usage: [], async rollback() { this.open = false; } }) })),
    config: testConfig(),
  }));
  const object = new OwnerObject(state, {});
  const name = `tx_${"a".repeat(32)}`;
  // Each path's wire version: 2 for `/atomic` (ADR 0024 pull request 8), 1 for the others.
  const version = (path) => (path === "/atomic" ? "2" : "1");
  const send = (path, body, headers = {}) => object.fetch(new Request(`https://owner${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-policysql-request-id": "req_obj", "x-policysql-owner": name, "x-policysql-owner-wire": version(path), ...headers }, body,
  }));
  for (const [path, body] of [["/begin", "{"], ["/atomic", "null"], ["/statement", "[]"], ["/unknown", "{}"]]) {
    const response = await send(path, body);
    // The same status and body as earlier objects, which an earlier Worker forwards (ADR 0023).
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-policysql-owner-wire"), version(path), "every reply carries its path's wire version");
    const reply = await response.json();
    assert.deepEqual(reply, { error: { code: "POLICYSQL_INVALID_REQUEST", message: "The request is invalid.", path: null, requestId: "req_obj" } }, path);
  }
  // A message in the earlier wire shape (only an earlier Worker sends `authFingerprint`), or
  // one routed to another name: an internal fault, which no client takes as a rejection.
  for (const [headers, body] of [[{}, { transactionId: name, authFingerprint: "b".repeat(64) }], [{ "x-policysql-owner": `tx_${"b".repeat(32)}` }, {}]]) {
    const response = await send("/commit", JSON.stringify(body), headers);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL");
  }
  // An `/atomic` message without its path's version 2 (the previous release's Worker sends 1).
  const earlierAtomic = await send("/atomic", "null", { "x-policysql-owner-wire": "1" });
  assert.equal(earlierAtomic.status, 500);
  assert.equal(earlierAtomic.headers.get("x-policysql-owner-wire"), "2");
  assert.equal((await earlierAtomic.json()).error.code, "POLICYSQL_INTERNAL");
  const auth = JSON.parse(h.runtime.authorize_session_json(JSON.stringify(h.session("a")), undefined, "execute")).auth;
  const begun = await send("/begin", JSON.stringify({
    transactionId: name, startFingerprint: "c".repeat(64), mode: "read", auth, databaseBinding: testBinding(snapshot), snapshot,
  }));
  assert.equal(begun.status, 201);
  assert.equal((await begun.json()).transactionId, name);
  assert.equal(typeof values.get("transaction"), "string", "the machine's durable text is stored verbatim");
  const stored = JSON.parse(values.get("transaction"));
  assert.equal(stored.phase, "active");
  assert.equal(alarm, stored.expiresAtMs, "the core's timer is the object's alarm");
  // The platform fires the alarm at its time.
  const realNow = Date.now;
  Date.now = () => alarm;
  try { await object.alarm(); } finally { Date.now = realNow; }
  assert.equal(JSON.parse(values.get("transaction")).phase, "expired");
});

test("durable-objects: ExecutionContext.waitUntil backs per-request BackgroundTasks", () => {
  const kept = [];
  const tasks = executionContextTasks({ waitUntil: (task) => kept.push(task), passThroughOnException() {} });
  const task = Promise.resolve();
  tasks.run(task);
  assert.deepEqual(kept, [task]);
  assert.equal(executionContextTasks(undefined), undefined);
  assert.equal(executionContextTasks({}), undefined);
});

test("createApp requires a TransactionOwner port, and app.fetch rejects malformed BackgroundTasks before any work", async (t) => {
  t.mock.method(console, "log", () => {});
  const runtime = { snapshot: "test-snapshot", max_bytes_per_value: 1_024, limits_json: limitsJson() };
  for (const transactionOwners of [undefined, null, {}, { route: 1 }]) {
    assert.throws(() => createApp({ getRuntime: () => runtime, database: testProvider(), config: testConfig(), transactionOwners }), TypeError);
  }
  let runtimeCalls = 0;
  const app = createApp({ getRuntime: () => { runtimeCalls++; return runtime; }, database: testProvider(), config: testConfig(), transactionOwners: testOwners() });
  for (const background of [null, {}, { run: "no" }]) {
    const response = await app.fetch(new Request("https://worker.test/healthz"), { database: testBinding() }, background);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "POLICYSQL_INTERNAL");
  }
  assert.equal(runtimeCalls, 0);
  const ok = await app.fetch(new Request("https://worker.test/healthz"), { database: testBinding() }, { run() {} });
  assert.equal(ok.status, 200);
});

// Mixed-version rollout (ADR 0023): a Worker of the previous release (origin/main before
// #34) forwarded each owner reply's status and body to the client unchanged
// (`ownerResponse(reply)`), and reshaped only a 2xx atomic reply. This object must therefore
// send exactly what the client sees from the current Worker, route by route.
test("durable-objects: an earlier Worker forwarding this object's replies shows the client what this Worker does", async (t) => {
  const h = await harness(t, { ownerAdapter: "durable-objects" });
  const wire = h.ownerWire();
  // main's Worker: `{ status: response.status, body: await response.json() }`, then
  // `ownerResponse(reply)`; for an atomic execute only a non-2xx reply was forwarded.
  const earlierWorker = (entry) => ({ status: entry.status, body: entry.body });
  // main's Worker reshaped a 2xx atomic reply (deploy/cloudflare/src/routes/execute.ts at
  // a29dee9). Since ADR 0024 pull request 8 no earlier Worker reaches this object's `/atomic`
  // (its message lacks the path's wire version 2 and is answered 500 without running), and the
  // object's atomic reply is the public `execute` response itself, which this Worker relays.
  const forwarded = async (label, ownerPath, send, { atomic = false } = {}) => {
    const from = wire.length;
    const current = await send();
    const replies = wire.slice(from).filter((entry) => entry.path === ownerPath);
    assert.equal(replies.length, 1, `${label}: one ${ownerPath} reply`);
    if (atomic && replies[0].status === 200) {
      assert.equal(replies[0].body.meta.requestId, current.body.meta.requestId, `${label}: the owner answers with the engine's request id`);
    }
    assert.deepEqual(earlierWorker(replies[0]), current, label);
    return current;
  };

  const begun = await forwarded("begin", "/begin", () => h.request("a", "/v1/transactions", { mode: "write" }, null));
  assert.equal(begun.status, 201);
  const id = begun.body.transactionId;
  const path = `/v1/transactions/${id}`;
  assert.equal((await forwarded("statement", "/statement",
    () => h.request("a", `${path}/statements`, { sequence: 1, ...insert("rollout") }, null))).status, 200);
  const hooksBefore = h.hooksSeen.length;
  const committed = await forwarded("commit with a commit check", "/commit", () => h.request("a", `${path}/commit`, { sequence: 2 }, null));
  assert.equal(committed.status, 200);
  assert.equal(committed.body.status, "committed");
  // The validator's callback query went through this object too.
  const callbacks = wire.filter((entry) => entry.path === "/validation-query");
  assert.ok(callbacks.length >= 1 && h.hooksSeen.length === hooksBefore + 1);
  assert.deepEqual(earlierWorker(callbacks.at(-1)), { status: h.hooksSeen.at(-1).status, body: h.hooksSeen.at(-1).result }, "callback");
  assert.equal(h.hooksSeen.at(-1).status, 200);

  const other = (await h.request("a", "/v1/transactions", { mode: "read" }, null)).body.transactionId;
  assert.equal((await forwarded("rollback", "/rollback",
    () => h.request("a", `/v1/transactions/${other}/rollback`, { sequence: 1 }, null))).status, 200);
  // Owner-side errors keep their public status and body, request id included.
  const conflict = await forwarded("commit after rollback", "/commit",
    () => h.request("a", `/v1/transactions/${other}/commit`, { sequence: 9 }, null));
  assert.equal(conflict.status, 409);
  const unknown = await forwarded("unknown transaction", "/statement",
    () => h.request("a", `/v1/transactions/tx_${"9".repeat(32)}/statements`, { sequence: 1, ...read }, null));
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
  assert.equal(typeof unknown.body.error.requestId, "string");

  // The new unknown commit outcome (#48) reaches the client through an earlier Worker with
  // its status, 503, so the client treats it as unknown, never as a rejection. (A Worker
  // that maps codes by a table without it serves 500, which is unknown too.)
  t.mock.method(console, "log", () => {});
  const uncertain = (await h.request("a", "/v1/transactions", { mode: "write" }, null)).body.transactionId;
  assert.equal((await h.request("a", `/v1/transactions/${uncertain}/statements`, { sequence: 1, ...insert("rollout_unknown") }, null)).status, 200);
  h.afterDatabaseStatement(({ sql }) => { if (sql === "COMMIT") throw new Error("connection reset"); });
  for (const label of ["unknown commit outcome", "its retry"]) {
    const outcome = await forwarded(label, "/commit",
      () => h.request("a", `/v1/transactions/${uncertain}/commit`, { sequence: 2 }, null));
    assert.equal(outcome.status, 503, label);
    assert.equal(outcome.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN", label);
  }
  h.afterDatabaseStatement(null);
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  assert.equal([...REJECTIONS.values()].flat().includes("COMMIT_OUTCOME_UNKNOWN"), false);

  // Atomic executes that trigger a commit check run in the owner.
  assert.equal((await forwarded("atomic", "/atomic",
    () => h.request("a", "/v1/transactions:execute", { statements: [insert("atomic_rollout")] }, "rollout-atomic-key-01"), { atomic: true })).status, 200);
  const replayConflict = await forwarded("atomic key reuse", "/atomic",
    () => h.request("a", "/v1/transactions:execute", { statements: [insert("atomic_other")] }, "rollout-atomic-key-01"), { atomic: true });
  assert.equal(replayConflict.status, 409);
});

// Mixed-version rollout (ADR 0024 pull request 7): the owner input of the interactive paths
// changed, so a Worker and an object of different versions cannot understand each other there.
// The earlier object is origin/main's (8e597cf) `serve` (Bearer capability, body as is) over its
// TypeScript owner, `LegacyTransactionOwnerCore`, and its reply framing (no wire marker). What it
// did is recorded (ADR 0024 pull request 9, test/helpers/reference-transcript.mjs): an earlier
// Worker's transaction committed through it, and its replies to this version's messages, in
// order. The production port must never turn what it answers into a definite rejection.
const reference = referenceTranscript(new URL("./fixtures/reference/transaction-owner-port.json", import.meta.url));
const recordedEarlierObject = (recorded) => async (url) => {
  const reply = recorded.take(`earlier object ${new URL(url).pathname}`);
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
};

test("durable-objects: a Worker of this version never turns an earlier object's answer into a rejection", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects", hooks: false });
  const recorded = reference.of(t);
  const namespace = { idFromName: (name) => ({ name }), get: () => ({ fetch: recordedEarlierObject(recorded) }) };
  const id = `tx_${"e".repeat(32)}`;
  const databaseBinding = h.binding("a");
  // An earlier Worker began transaction `id`, inserted `skewed`, and committed it through the
  // earlier wire: COMMIT applied (recorded; the committed row is written where it applied).
  const applied = recorded.take("earlier Worker committed");
  assert.deepEqual(applied.statuses, [201, 200, 200]);
  assert.equal(applied.commit.status, "committed");
  assert.equal(applied.commit.transactionId, id);
  for (const row of applied.rows) {
    h.databases.get("a").database.prepare("INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?)").run(row.id, "tenant_a", row.name);
  }
  // The client's commit response was lost; it retries through a Worker of this version.
  const app = h.appWith(durableObjectTransactionOwners(namespace));
  const send = async (path, body) => {
    const response = await app.fetch(new Request(`https://worker.test${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), { database: databaseBinding, session: h.session("a") }, h.background);
    return { status: response.status, body: await response.json() };
  };
  const { sendCommand, PolicySqlOutcomeUnknownError } = await import("../../../packages/client/protocol.js");
  const neverRejected = async (kind, reply) => {
    await assert.rejects(sendCommand(async () => reply, { kind }, {}, () => {}), PolicySqlOutcomeUnknownError, kind);
  };
  const retry = await send(`/v1/transactions/${id}/commit`, { sequence: 2 });
  assert.equal(retry.status, 503, JSON.stringify(retry.body));
  assert.equal(retry.body.error.code, "POLICYSQL_COMMIT_OUTCOME_UNKNOWN");
  await neverRejected("commit", retry);
  for (const [kind, path, body] of [
    ["begin", "/v1/transactions", { mode: "write" }],
    ["statement", `/v1/transactions/${id}/statements`, { sequence: 3, sql: "SELECT id, name FROM projects", params: {} }],
    ["rollback", `/v1/transactions/${id}/rollback`, { sequence: 3 }],
  ]) {
    const reply = await send(path, body);
    assert.equal(reply.status, 500, `${kind}: ${JSON.stringify(reply.body)}`);
    assert.equal(reply.body.error.code, "POLICYSQL_INTERNAL", kind);
    await neverRejected(kind, reply);
  }
  const callback = await app.fetchCallback(new Request(`https://worker.test/v1/commit-checks/cval_${"e".repeat(32)}/query`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"A".repeat(43)}` },
    body: JSON.stringify({ sequence: 1, sql: "SELECT id, name FROM projects", params: {} }),
  }));
  assert.equal(callback.status, 500);
  assert.equal(h.rows("a").filter((row) => row.id === "skewed").length, 1, "the commit applied exactly once");
});

test("durable-objects: an object of this version answers an earlier Worker's messages without a rejection", async (t) => {
  t.mock.method(console, "log", () => {});
  const h = await harness(t, { ownerAdapter: "durable-objects", hooks: false });
  const id = await (async () => {
    const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
    return begun.body.transactionId;
  })();
  assert.equal((await h.request("a", `/v1/transactions/${id}/statements`, { sequence: 1, ...insert("new_object") }, null)).status, 200);
  const committed = await h.request("a", `/v1/transactions/${id}/commit`, { sequence: 2 }, null);
  assert.equal(committed.status, 200);
  const OwnerObject = durableObjectTransactionOwnerClass(() => ({ getRuntime: () => h.runtime, database: h.database, config: h.config }));
  const values = new Map();
  const object = new OwnerObject({
    waitUntil() {},
    storage: { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); }, async setAlarm() {} },
  }, {});
  values.set("transaction", await h.ownerRecordRaw(id));
  const { REJECTIONS } = await import("../../../packages/client/protocol.js");
  // origin/main's Worker: the earlier bodies, the capability as Bearer, no wire marker.
  for (const [path, body, headers] of [
    ["/commit", { transactionId: id, authFingerprint: "b".repeat(64), command: { sequence: 2 } }, {}],
    ["/statement", { transactionId: id, authFingerprint: "b".repeat(64), command: { sequence: 3, sql: "SELECT id FROM projects", params: {} } }, {}],
    ["/rollback", { transactionId: id, authFingerprint: "b".repeat(64), command: { sequence: 3 } }, {}],
    ["/begin", { transactionId: id, authFingerprint: "b".repeat(64), startFingerprint: "c".repeat(64), mode: "write", auth: {} }, {}],
    ["/validation-query", { sequence: 1, sql: "SELECT id FROM projects", params: {} }, { authorization: `Bearer ${"A".repeat(43)}` }],
  ]) {
    const response = await object.fetch(new Request(`https://owner${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-policysql-request-id": "req_old", ...headers }, body: JSON.stringify(body),
    }));
    const reply = await response.json();
    assert.equal(response.status, 500, `${path}: ${JSON.stringify(reply)}`);
    assert.equal(reply.error.code, "POLICYSQL_INTERNAL", path);
    assert.equal([...REJECTIONS.values()].flat().includes(reply.error.code.slice("POLICYSQL_".length)), false);
  }
  assert.equal(JSON.parse(values.get("transaction")).phase, "committed", "nothing reached the machine");
});
