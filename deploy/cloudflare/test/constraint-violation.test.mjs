// #145, ADR 0030: a statement the database refuses for a constraint is 409
// `POLICYSQL_CONSTRAINT_VIOLATION` with `detail.constraint`, for an atomic execute (with and
// without a key, on both placements) and for an interactive statement, on both TransactionOwner
// adapters, against a real SQLite behind the real HTTP transport. The refusal says which kind and
// where, and nothing the database said: no table, column, constraint name, or trigger text.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, createHttpTransport } from "../../../packages/client/index.js";

const fixture = {
  catalog: `version: 1
resources:
  parents:
    source: { table: parents }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      code: { type: string }
      name: { type: string }
  children:
    source: { table: children }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      parent_id: { type: string }
  deferred_children:
    source: { table: deferred_children }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      parent_id: { type: string }
`,
  policy: `version: 1
resources:
  parents:
    roles:
      member:
        select:
          columns: [id, code, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, code, name]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
        delete:
          filter: { tenant_id: { eq: { session: tenant_id } } }
  children:
    roles:
      member:
        select:
          columns: [id, parent_id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, parent_id]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
  deferred_children:
    roles:
      member:
        select:
          columns: [id, parent_id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, parent_id]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
commit_checks:
  consistency:
    triggered_by: [parents, children, deferred_children]
    hook:
      timeout_ms: 1500
`,
  schema: `CREATE TABLE parents (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, CONSTRAINT secret_check CHECK (name <> 'bad'));
CREATE TRIGGER parents_guard BEFORE INSERT ON parents WHEN NEW.name = 'raise' BEGIN SELECT RAISE(ABORT, 'private trigger text'); END;
CREATE TABLE children (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents (id));
CREATE TABLE deferred_children (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, parent_id TEXT NOT NULL REFERENCES parents (id) DEFERRABLE INITIALLY DEFERRED);`,
  physicalSchema: JSON.stringify({ tables: {
    parents: { columns: {
      id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false },
      code: { declaredType: "TEXT", nullable: false }, name: { declaredType: "TEXT", nullable: false },
    } },
    children: { columns: {
      id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false }, parent_id: { declaredType: "TEXT", nullable: false },
    } },
    deferred_children: { columns: {
      id: { declaredType: "TEXT", nullable: false }, tenant_id: { declaredType: "TEXT", nullable: false }, parent_id: { declaredType: "TEXT", nullable: false },
    } },
  } }),
  callbackQuery: { sql: "SELECT id FROM parents ORDER BY id", params: {} },
  seed(db, tenant) {
    db.prepare("INSERT INTO parents (id, tenant_id, code, name) VALUES (?, ?, ?, ?)").run("seed", `tenant_${tenant}`, "seed-code", "visible");
    db.prepare("INSERT INTO parents (id, tenant_id, code, name) VALUES (?, ?, ?, ?)").run("hidden", "another_tenant", "hidden-code", "hidden");
    db.prepare("INSERT INTO children (id, tenant_id, parent_id) VALUES (?, ?, ?)").run("kid", `tenant_${tenant}`, "seed");
  },
};

const EXECUTE = "/v1/transactions:execute";
const KEY = "constraint-key-0000001";
const PLACEMENTS = [["direct", false], ["owner", true]];
const MESSAGES = {
  unique: "The statement violates a unique constraint.",
  not_null: "The statement violates a NOT NULL constraint.",
  foreign_key: "The statement violates a foreign key constraint.",
  check: "The statement violates a CHECK constraint.",
  other: "The statement violates a database constraint.",
};

const parent = (id, code, name = "n") => ({ sql: "INSERT INTO parents (id, code, name) VALUES (:id, :code, :name)", params: { id, code, name } });
const child = (id, parentId) => ({ sql: "INSERT INTO children (id, parent_id) VALUES (:id, :parent)", params: { id, parent: parentId } });
/** One statement for each kind of refusal, with the kind it is reported as. */
const VIOLATIONS = {
  unique: { statement: parent("p1", "seed-code"), constraint: "unique" },
  primary_key: { statement: parent("seed", "other-code"), constraint: "unique" },
  not_null: { statement: { sql: "INSERT INTO parents (id, code) VALUES (:id, :code)", params: { id: "p2", code: "c2" } }, constraint: "not_null" },
  check: { statement: parent("p3", "c3", "bad"), constraint: "check" },
  foreign_key_insert: { statement: child("k2", "nope"), constraint: "foreign_key" },
  foreign_key_delete: { statement: { sql: "DELETE FROM parents WHERE id = :id", params: { id: "seed" } }, constraint: "foreign_key" },
  trigger_abort: { statement: parent("p4", "c4", "raise"), constraint: "other" },
};
const FRAGMENTS = ["constraint failed", "SQLite error", "parents", "children", "tenant_id", "secret_check", "private trigger text", "__policysql", "SQLITE_CONSTRAINT"];

const events = (lines, name) => lines.flatMap((line) => { try { const record = JSON.parse(line); return record.event === name ? [record] : []; } catch { return []; } });
/** Whether any statement the database ran carried the id as its `id` argument. */
const ran = (h, id) => h.events.some((event) => (event.args ?? []).some((arg) => arg.name === "id" && arg.value.value === id));
const parentIds = (h) => h.databases.get("a").database.prepare("SELECT id FROM parents WHERE tenant_id = 'tenant_a' ORDER BY id").all().map((row) => row.id);
const idempotencyRows = (h) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n;
const withoutRequestId = (body) => JSON.parse(JSON.stringify(body, (key, value) => (key === "requestId" ? undefined : value)));

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = async (t, hooks, extra = {}) => {
    const logs = [];
    t.mock.method(console, "log", (line) => { logs.push(String(line)); });
    const h = await harness(t, { ownerAdapter, hooks, fixture, ...extra });
    return Object.assign(h, { logs });
  };
  const execute = (h, statements, key = null, tenant = "a") => h.request(tenant, EXECUTE, { statements }, key);
  const ownLog = (h, response) => h.logs.filter((line) => line.includes(response.body.error.requestId));
  /** A response and the log lines of its request, as one text, minus the database's code the log legitimately carries. */
  const visibleText = (h, response) => `${JSON.stringify(response.body)}\n${ownLog(h, response).join("\n").replaceAll('"databaseCode":"SQLITE_CONSTRAINT"', "")}`;

  for (const [placement, hooks] of PLACEMENTS) {
    for (const keyed of [false, true]) {
      const key = keyed ? KEY : null;
      const label = `${ownerAdapter}/${placement}/${keyed ? "keyed" : "unkeyed"}`;

      // P1, P3, B3: every kind is a 409 with its detail and fixed message, in the five-key shape, and nothing the database said.
      for (const [name, { statement, constraint }] of Object.entries(VIOLATIONS)) {
        test(`${label}: ${name} is 409 POLICYSQL_CONSTRAINT_VIOLATION as ${constraint}, with nothing of the database's text`, async (t) => {
          const h = await setup(t, hooks);
          const response = await execute(h, [statement], key);
          assert.equal(response.status, 409, JSON.stringify(response.body));
          const { error } = response.body;
          assert.deepEqual(Object.keys(error), ["code", "message", "path", "detail", "requestId"]);
          assert.equal(error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
          assert.equal(error.message, MESSAGES[constraint]);
          assert.equal(error.path, "/statements/0");
          assert.deepEqual(error.detail, { constraint });
          // B3: neither the response nor the log lines of this request carry what the database said.
          const own = ownLog(h, response);
          assert.ok(own.length >= 1, "the refusal is logged");
          const text = visibleText(h, response);
          for (const fragment of FRAGMENTS) assert.equal(text.includes(fragment), false, `"${fragment}" must not appear: ${text.slice(0, 500)}`);
          await h.flush();
          assert.equal(events(h.logs, "database_error_unclassified").length, 0);
        });
      }

      // P2: the path names the failed statement; what follows it never reaches the database.
      test(`${label}: the path names the failed statement, and the statements after it never run`, async (t) => {
        const h = await setup(t, hooks);
        const single = await execute(h, [parent("s0", "seed-code")], key);
        assert.equal(single.body.error.path, "/statements/0");
        const second = await execute(h, [parent("ok1", "ok-code-1"), parent("p9", "seed-code")], key);
        assert.equal(second.status, 409, JSON.stringify(second.body));
        assert.equal(second.body.error.path, "/statements/1");
        const first = await execute(h, [parent("p8", "seed-code"), parent("after", "after-code")], key);
        assert.equal(first.status, 409, JSON.stringify(first.body));
        assert.equal(first.body.error.path, "/statements/0");
        await h.flush();
        assert.equal(ran(h, "ok1"), true, "the statement before the failure did reach the database");
        assert.equal(ran(h, "after"), false, "the statement after the failure never reached the database");
        // P4: nothing is kept.
        assert.deepEqual(parentIds(h), ["seed"]);
        assert.equal(idempotencyRows(h), 0);
      });

      // P4: the key is not consumed: the same key then runs and commits a request that does not violate.
      test(`${label}: nothing is committed or recorded, and the key stays free`, async (t) => {
        const h = await setup(t, hooks);
        const refused = await execute(h, [parent("keep", "keep-code"), parent("p5", "seed-code")], key);
        assert.equal(refused.status, 409);
        await h.flush();
        assert.deepEqual(parentIds(h), ["seed"]);
        assert.equal(idempotencyRows(h), 0);
        const accepted = await execute(h, [parent("fresh", "fresh-code")], key);
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        await h.flush();
        assert.deepEqual(parentIds(h), ["fresh", "seed"]);
        assert.equal(idempotencyRows(h), keyed ? 1 : 0);
      });

      // P8: one log event, the keys of the contract, and no `database_error_unclassified`.
      test(`${label}: one database_constraint_violation is logged with the fixed keys`, async (t) => {
        const h = await setup(t, hooks);
        const response = await execute(h, [parent("ok1", "ok-code-1"), parent("p9", "seed-code")], key);
        assert.equal(response.status, 409);
        await h.flush();
        const [record, ...rest] = events(h.logs, "database_constraint_violation");
        assert.equal(rest.length, 0);
        assert.deepEqual(Object.keys(record).sort(), ["constraint", "databaseCode", "event", "policyVersion", "requestId", "schemaVersion", "statementIndex"]);
        assert.equal(record.requestId, response.body.error.requestId);
        assert.equal(record.statementIndex, 1);
        assert.equal(record.constraint, "unique");
        assert.equal(record.databaseCode, "SQLITE_CONSTRAINT");
        assert.equal(events(h.logs, "database_error_unclassified").length, 0);
      });
    }

    // B4: a duplicate of a row the caller sees and one of a row it does not see answer and log alike.
    test(`${ownerAdapter}/${placement}: a duplicate of a visible row and of a hidden row are indistinguishable`, async (t) => {
      const h = await setup(t, hooks);
      const visible = await execute(h, [parent("p6", "seed-code")]);
      const hidden = await execute(h, [parent("p7", "hidden-code")]);
      assert.equal(visible.status, 409);
      assert.deepEqual({ status: hidden.status, body: withoutRequestId(hidden.body) }, { status: visible.status, body: withoutRequestId(visible.body) });
      const record = (response) => {
        const [one] = events(ownLog(h, response), "database_constraint_violation");
        return { ...one, requestId: undefined };
      };
      assert.deepEqual(record(hidden), record(visible));
      // The same for a primary key.
      const visibleKey = await execute(h, [parent("seed", "x1")]);
      const hiddenKey = await execute(h, [parent("hidden", "x2")]);
      assert.deepEqual(withoutRequestId(hiddenKey.body), withoutRequestId(visibleKey.body));
    });

    // P5: an interactive statement closes the transaction as failed, and nothing is kept.
    test(`${ownerAdapter}/${placement}: an interactive statement that violates a constraint closes the transaction as failed`, async (t) => {
      const h = await setup(t, hooks);
      const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const base = `/v1/transactions/${started.body.transactionId}`;
      assert.equal((await h.request("a", `${base}/statements`, { sequence: 1, ...parent("early", "early-code") }, null)).status, 200);
      const failed = await h.request("a", `${base}/statements`, { sequence: 2, ...parent("p1", "seed-code") }, null);
      assert.equal(failed.status, 409, JSON.stringify(failed.body));
      assert.deepEqual(Object.keys(failed.body.error), ["code", "message", "path", "detail", "requestId"]);
      assert.equal(failed.body.error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
      assert.equal(failed.body.error.path, "/statements/0");
      assert.deepEqual(failed.body.error.detail, { constraint: "unique" });
      const next = await h.request("a", `${base}/statements`, { sequence: 3, ...parent("after", "after-code") }, null);
      assert.equal(next.status, 409);
      assert.equal(next.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      const commit = await h.request("a", `${base}/commit`, { sequence: 3 }, null);
      assert.equal(commit.status, 409);
      assert.equal(commit.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      await h.flush();
      assert.deepEqual(parentIds(h), ["seed"], "the statement that succeeded first is rolled back too");
      assert.equal(ran(h, "after"), false);
      assert.equal((await h.ownerRecord(started.body.transactionId)).status, "failed");
      assert.equal(events(h.logs, "database_constraint_violation").length, 1);
    });

    // P6, B6: the official client reports a definite rejection, with the detail.
    test(`${ownerAdapter}/${placement}: the client reports a PolicySqlError with detail, never an unknown outcome`, async (t) => {
      const h = await setup(t, hooks);
      const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
      const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
      const asserted = (error) => {
        assert.ok(error instanceof PolicySqlError);
        assert.equal(error instanceof PolicySqlOutcomeUnknownError, false, "a definite rejection");
        assert.equal(error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
        assert.equal(error.status, 409);
        assert.deepEqual({ ...error.detail }, { constraint: "unique" });
        assert.equal(Object.isFrozen(error.detail), true);
        return true;
      };
      await assert.rejects(client.execute("INSERT INTO parents (id, code, name) VALUES (:id, :code, :name)", { id: "c1", code: "seed-code", name: "n" }), asserted);
      const tx = await client.beginTransaction({ mode: "write" });
      await assert.rejects(tx.execute("INSERT INTO parents (id, code, name) VALUES (:id, :code, :name)", { id: "c2", code: "seed-code", name: "n" }), asserted);
      assert.equal(tx.status, "failed");
      await h.flush();
      assert.deepEqual(parentIds(h), ["seed"]);
    });

    // N3: a deferred foreign key fails at COMMIT, which is never classified.
    test(`${ownerAdapter}/${placement}: a deferred foreign key that fails at COMMIT is not a constraint violation`, async (t) => {
      const h = await setup(t, hooks);
      const deferred = { sql: "INSERT INTO deferred_children (id, parent_id) VALUES (:id, :parent)", params: { id: "d1", parent: "nope" } };
      const atomic = await execute(h, [deferred]);
      assert.ok(atomic.status >= 500, JSON.stringify(atomic.body));
      assert.notEqual(atomic.body.error.code, "POLICYSQL_CONSTRAINT_VIOLATION");
      assert.equal(atomic.body.error.detail, undefined);
      const started = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      const base = `/v1/transactions/${started.body.transactionId}`;
      const statement = await h.request("a", `${base}/statements`, { sequence: 1, ...deferred, params: { id: "d2", parent: "nope" } }, null);
      assert.equal(statement.status, 200, JSON.stringify(statement.body));
      const commit = await h.request("a", `${base}/commit`, { sequence: 2 }, null);
      assert.notEqual(commit.body.error?.code, "POLICYSQL_CONSTRAINT_VIOLATION");
      assert.ok(commit.status >= 500, JSON.stringify(commit.body));
      await h.flush();
      assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM deferred_children").get().n, 0);
      // The official client takes the atomic failure as an unknown outcome.
      const fetchImpl = (url, init) => h.app.fetch(new Request(url, init), { database: h.binding("a"), session: h.session("a") }, h.background);
      const client = new PolicySqlClient({ transport: createHttpTransport({ endpoint: "https://worker.test", fetchImpl }) });
      await assert.rejects(client.execute("INSERT INTO deferred_children (id, parent_id) VALUES (:id, :parent)", { id: "d3", parent: "nope" }), PolicySqlOutcomeUnknownError);
    });
  }

  // B2: the database's text is only ever matched against fixed prefixes; whatever it says, the response and the log say none of it.
  for (const [placement, hooks] of PLACEMENTS) test(`${ownerAdapter}/${placement}: text injected into the database's message changes nothing but the kind, and appears nowhere`, async (t) => {
    const h = await setup(t, hooks);
    const injected = [
      ["SQLite error: CHECK constraint failed: x UNIQUE constraint failed", "check", "CHECK constraint failed: x"],
      ['SQLite error: {"constraint":"unique"}', "other", '{"constraint":"unique"}'],
      ["<script>alert(1)</script>", "other", "<script>"],
      [`SQLite error: ${"x".repeat(65_536)}`, "other", "x".repeat(200)],
      ["SQLite error: line one\nline two\u0000\u001b[31mred", "other", "line one"],
      ["SQLite error: __policysql_session_tenant_id", "other", "__policysql_session_tenant_id"],
    ];
    for (const [message, constraint, fragment] of injected) {
      h.logs.length = 0;
      h.replaceDatabaseResponse(({ results }) => {
        for (const entry of results) {
          const errors = entry.response?.result?.step_errors;
          if (Array.isArray(errors)) errors.forEach((error, index) => { if (error !== null) errors[index] = { code: "SQLITE_CONSTRAINT", message }; });
        }
      });
      const response = await execute(h, [parent("p1", "seed-code")]);
      assert.equal(response.status, 409, JSON.stringify(response.body).slice(0, 300));
      assert.deepEqual(response.body.error.detail, { constraint });
      assert.equal(response.body.error.message, MESSAGES[constraint]);
      const text = `${JSON.stringify(response.body)}\n${h.logs.join("\n")}`;
      assert.equal(text.includes(fragment), false, `"${fragment.slice(0, 40)}" must not appear`);
    }
    // The code must match exactly: an extended code with a UNIQUE message stays a 503.
    h.replaceDatabaseResponse(({ results }) => {
      for (const entry of results) {
        const errors = entry.response?.result?.step_errors;
        if (Array.isArray(errors)) errors.forEach((error, index) => { if (error !== null) errors[index] = { code: "SQLITE_CONSTRAINT_UNIQUE", message: "SQLite error: UNIQUE constraint failed: parents.code" }; });
      }
    });
    h.logs.length = 0;
    const extended = await execute(h, [parent("p1", "seed-code")]);
    assert.equal(extended.status, 503);
    assert.equal(extended.body.error.code, "POLICYSQL_DATABASE_UNAVAILABLE");
    assert.deepEqual(events(h.logs, "database_error_unclassified").map((record) => record.code), ["SQLITE_CONSTRAINT_UNIQUE"]);
    assert.equal(events(h.logs, "database_constraint_violation").length, 0);
  });

  // #145 review: a constraint violation of the idempotency lookup or insert is a 500 (the keyed
  // request's outcome is unknown), and the log names the database's code so an operator can trace
  // it (a mismatched idempotency table), with nothing of the message.
  for (const [placement, hooks] of PLACEMENTS) test(`${ownerAdapter}/${placement}: a constraint violation of the idempotency insert is a traceable 500`, async (t) => {
    const h = await setup(t, hooks);
    h.replaceDatabaseResponse(({ sqls, results }) => {
      if (!sqls.some((sql) => /INSERT INTO policysql_idempotency/u.test(sql))) return;
      for (const entry of results) {
        const batch = entry.response?.result;
        if (Array.isArray(batch?.step_errors)) {
          batch.step_errors[0] = { code: "SQLITE_CONSTRAINT", message: "SQLite error: NOT NULL constraint failed: policysql_idempotency.secret_column" };
          batch.step_results[0] = null;
        }
      }
    });
    const response = await execute(h, [parent("fresh", "fresh-code")], KEY);
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "POLICYSQL_INTERNAL");
    assert.equal(response.body.error.detail, undefined);
    await h.flush();
    const [record, ...rest] = events(h.logs, "database_error_unclassified");
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(record).sort(), ["code", "event", "requestId"]);
    assert.equal(record.code, "SQLITE_CONSTRAINT");
    assert.equal(events(h.logs, "database_constraint_violation").length, 0);
    const text = `${JSON.stringify(response.body)}\n${h.logs.join("\n").replaceAll('"code":"SQLITE_CONSTRAINT"', "")}`;
    for (const fragment of ["NOT NULL", "constraint failed", "secret_column", "policysql_idempotency", "SQLite error"]) {
      assert.equal(text.includes(fragment), false, `"${fragment}" must not appear`);
    }
    assert.deepEqual(parentIds(h), ["seed"], "nothing is committed");
  });

  // F1: both owner placements, on either adapter, answer alike and keep the same rows.
  test(`${ownerAdapter}: both placements answer alike for every kind and keep the same rows`, async (t) => {
    const seen = new Map();
    for (const [placement, hooks] of PLACEMENTS) {
      for (const [name, { statement }] of Object.entries(VIOLATIONS)) {
        const h = await setup(t, hooks);
        const response = await execute(h, [parent("ok1", "ok-code-1"), statement]);
        await h.flush();
        const result = JSON.stringify({ status: response.status, body: withoutRequestId(response.body), rows: parentIds(h) });
        if (seen.has(name)) assert.equal(result, seen.get(name), `${name}: ${placement} differs`);
        else seen.set(name, result);
      }
    }
    assert.equal(seen.size, Object.keys(VIOLATIONS).length);
  });
}
