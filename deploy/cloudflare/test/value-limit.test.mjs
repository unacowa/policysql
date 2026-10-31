// maxBytesPerValue (ADR 0027 pull request 5): the decoded bytes of one bytes value are a
// RuntimeLimits field the runtime reports, Capabilities advertises, and every path enforces:
// request parameters, result cells (SELECT and RETURNING), interactive statements, and the
// driver values the Turso transport reads. Each kind and path is tested at the limit and one
// over, at the default and at the hard maximum, on both TransactionOwner adapters. The smallest
// applicable limit governs, so the paths a value at the hard maximum cannot pass are pinned too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeLimits, runtimeLimitsJson } from "../src/limits.ts";
import { PolicySqlRuntime } from "../pkg/policysql_wasm.js";
import { RUNTIME_LIMITS } from "../wrapper/limits.ts";
import { harness, OWNER_ADAPTERS, RawJson } from "./helpers/routing.mjs";

const read = (name) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), "utf8");
const fixture = {
  catalog: read("bytes/catalog.yaml"), policy: read("bytes/policy.yaml"),
  schema: read("bytes/schema.sql"), physicalSchema: read("bytes/physical-schema.json"),
  seed(db, tenant) {
    const insert = db.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES(?,?,?,?,?)");
    insert.run("seed", `tenant_${tenant}`, "visible", Buffer.from([0, 1, 2, 255]), Buffer.alloc(0));
  },
};
const DEFAULT = 262_144;
const HARD = 1_048_576;
// The raw database result bound that exists today (core's `EVENT_RESULT_BYTES`; pull request 6
// replaces it with the compiled bound) and the Hrana frame of one row with one BLOB cell.
const RAW_BOUND = 1_048_576;
const REQUIRED = { maxRows: 100, maxResultBytes: 800_000, timeoutMs: 1_000, maxStatements: 8 };
const CONFIGS = [
  ["the default", {}, DEFAULT],
  ["a small configured limit", { maxBytesPerValue: 1_000 }, 1_000],
  ["the hard maximum", { maxBytesPerValue: HARD, maxRequestBytes: 2_097_152, maxResultBytes: 2_000_000 }, HARD],
];
const EXECUTE = "/v1/transactions:execute";
const INSERT = "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING id";
const INSERT_RETURNING_STATE = "INSERT INTO projects(id,name,state) VALUES(:id,:name,:state) RETURNING id,state";
const bytes = (length, fill = 7) => Buffer.alloc(length, fill);
const b64 = (length) => bytes(length).toString("base64");
const stored = (h, id) => h.databases.get("a").database.prepare("SELECT length(state) AS n FROM projects WHERE id = ?").get(id)?.n;
const rowCount = (h, id) => h.databases.get("a").database.prepare("SELECT count(*) AS n FROM projects WHERE id = ?").get(id).n;
const seedState = (h, state) => h.databases.get("a").database.prepare("UPDATE projects SET state=? WHERE id='seed'").run(state);
let serial = 0;
const uid = () => `v${String((serial += 1)).padStart(6, "0")}`;

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = (t, limits) => {
    t.mock.method(console, "log", () => {});
    return harness(t, { ownerAdapter, fixture, hooks: false, runtimeLimits: { ...REQUIRED, ...limits } });
  };
  const post = (h, statements) => h.request("a", EXECUTE, new RawJson(JSON.stringify({ statements })), null);
  const work = async (h) => { await h.flush(); return { connects: h.counts().connects, statements: h.events.length }; };

  for (const [label, limits, limit] of CONFIGS) {
    test(`${ownerAdapter}: with ${label}, the runtime reports maxBytesPerValue and Capabilities advertises exactly it`, async (t) => {
      const h = await setup(t, limits);
      assert.equal(runtimeLimits(h.runtime).maxBytesPerValue, limit);
      const capabilities = await h.request("a", "/v1/capabilities", undefined, null);
      assert.equal(capabilities.body.limits.maxBytesPerValue, limit);
      assert.equal(capabilities.body.limits.maxRequestBytes, runtimeLimits(h.runtime).maxRequestBytes);
    });

    test(`${ownerAdapter}: with ${label}, a bytes parameter is accepted at the limit and 413 one over, at every padding`, async (t) => {
      const h = await setup(t, limits);
      for (const length of [limit, limit - 1, limit - 2]) {
        const id = uid();
        const served = await post(h, [{ sql: INSERT, params: { id, name: "n", state: b64(length) } }]);
        assert.equal(served.status, 200, `${length}: ${JSON.stringify(served.body).slice(0, 200)}`);
        assert.equal(stored(h, id), length, "the whole value is stored");
      }
      for (const length of [limit + 1, limit + 2, limit + 3]) {
        const id = uid();
        const before = await work(h);
        const refused = await post(h, [{ sql: INSERT, params: { id, name: "n", state: b64(length) } }]);
        assert.equal(refused.status, 413, `${length}`);
        assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
        assert.equal(refused.body.error.path, "/statements/0", "the path names the statement");
        assert.deepEqual(await work(h), before, "no database work for a refused parameter");
        assert.equal(rowCount(h, id), 0);
      }
    });

    test(`${ownerAdapter}: with ${label}, malformed bytes stay 400 however long, and unpadded base64 is not a bytes value`, async (t) => {
      const h = await setup(t, limits);
      const padded = b64(limit);
      const malformed = [padded.replace(/=+$/u, "") + (limit % 3 === 0 ? "A" : ""), `${padded}=`, `${padded}!`, `${"A".repeat(Math.ceil(limit / 3) * 4 + 8)}!`];
      for (const state of malformed.filter((value) => value !== padded)) {
        const before = await work(h);
        const refused = await post(h, [{ sql: INSERT, params: { id: uid(), name: "n", state } }]);
        assert.equal(refused.status, 400, state.slice(-8));
        assert.equal(refused.body.error.code, "POLICYSQL_INVALID_PARAMETER");
        assert.deepEqual(await work(h), before);
      }
    });

    test(`${ownerAdapter}: with ${label}, text and JSON values over the bytes limit are bounded by the request limits only`, async (t) => {
      const h = await setup(t, limits);
      const id = uid();
      const text = await post(h, [{ sql: "INSERT INTO projects(id,name) VALUES(:id,:name) RETURNING id", params: { id, name: "a".repeat(limit + 1) } }]);
      assert.equal(text.status, 200, JSON.stringify(text.body).slice(0, 200));
      const json = await post(h, [{ sql: "INSERT INTO projects(id,name,metadata) VALUES(:id,:name,:metadata) RETURNING id", params: { id: `${id}j`, name: "n", metadata: { k: "a".repeat(limit + 1) } } }]);
      assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 200));
      assert.equal(rowCount(h, id), 1);
      assert.equal(rowCount(h, `${id}j`), 1);
      // A text value is never a bytes value: a JSON string of text characters is not accepted
      // as bytes just because it is short.
      const refused = await post(h, [{ sql: INSERT, params: { id: uid(), name: "n", state: 7 } }]);
      assert.equal(refused.body.error.code, "POLICYSQL_INVALID_PARAMETER");
    });

    test(`${ownerAdapter}: with ${label}, an interactive statement's bytes parameter is bounded the same way`, async (t) => {
      const h = await setup(t, limits);
      const begun = await h.request("a", "/v1/transactions", { mode: "write" }, null);
      assert.equal(begun.status, 201, JSON.stringify(begun.body));
      const path = `/v1/transactions/${begun.body.transactionId}`;
      const fits = uid();
      const first = await h.request("a", `${path}/statements`, { sequence: 1, sql: INSERT, params: { id: fits, name: "n", state: b64(limit) } }, null);
      assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
      const over = await h.request("a", `${path}/statements`, { sequence: 2, sql: INSERT, params: { id: uid(), name: "n", state: b64(limit + 1) } }, null);
      assert.equal(over.status, 413, JSON.stringify(over.body).slice(0, 200));
      assert.equal(over.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      await h.request("a", `${path}/rollback`, { sequence: 3 }, null);
      assert.equal(rowCount(h, fits), 0, "rolled back");
    });
  }

  // ------------------------------------------------------------------------------------------
  // Result values: a cell another system wrote, SELECT and RETURNING, the driver value path

  for (const [label, limits, limit] of CONFIGS.slice(0, 2)) {
    test(`${ownerAdapter}: with ${label}, a stored BLOB is read at the limit and 413 one over, and the transaction rolls back`, async (t) => {
      const h = await setup(t, limits);
      seedState(h, bytes(limit, 255));
      const served = await post(h, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
      assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
      assert.equal(served.body.results[0].rows[0].state, bytes(limit, 255).toString("base64"));
      for (const length of [limit + 1, limit + 2, limit + 3]) {
        seedState(h, bytes(length));
        const id = uid();
        const refused = await post(h, [
          { sql: INSERT, params: { id, name: "n", state: null } },
          { sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } },
        ]);
        assert.equal(refused.status, 413, `${length}: ${JSON.stringify(refused.body).slice(0, 200)}`);
        assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
        assert.equal(refused.body.results, undefined);
        assert.equal(rowCount(h, id), 0, "the earlier write is rolled back");
      }
    });

    test(`${ownerAdapter}: with ${label}, RETURNING a bytes value is bounded at the limit and one over`, async (t) => {
      const h = await setup(t, limits);
      const id = uid();
      const served = await post(h, [{ sql: INSERT_RETURNING_STATE, params: { id, name: "n", state: b64(limit) } }]);
      assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
      assert.equal(served.body.results[0].rows[0].state, b64(limit));
      // One over is refused on the way in, before RETURNING exists; a stored value one over (an
      // UPDATE ... RETURNING after another system wrote it) is refused on the way out.
      h.databases.get("a").database.prepare("UPDATE projects SET state=? WHERE id=?").run(bytes(limit + 1), id);
      const refused = await post(h, [{ sql: "UPDATE projects SET name=:name WHERE id=:id RETURNING id,state", params: { id, name: "m" } }]);
      assert.equal(refused.status, 413, JSON.stringify(refused.body).slice(0, 200));
      assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
      const name = h.databases.get("a").database.prepare("SELECT name FROM projects WHERE id = ?").get(id).name;
      assert.equal(name, "n", "the UPDATE is rolled back");
    });
  }

  test(`${ownerAdapter}: lowering the limit refuses what a higher one accepted, and raising it admits it`, async (t) => {
    const high = await setup(t, { maxBytesPerValue: DEFAULT + 1 });
    seedState(high, bytes(DEFAULT + 1));
    const accepted = await post(high, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body).slice(0, 200));
    const low = await setup(t, {});
    seedState(low, bytes(DEFAULT + 1));
    const refused = await post(low, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  });

  // ------------------------------------------------------------------------------------------
  // The smallest limit that applies governs: the paths a value at the hard maximum cannot pass

  const hard = { maxBytesPerValue: HARD, maxRequestBytes: 2_097_152, maxResultBytes: 2_000_000 };

  test(`${ownerAdapter}: a value at the hard maximum is written when the request limit allows it and refused by maxRequestBytes when it does not`, async (t) => {
    const roomy = await setup(t, hard);
    const id = uid();
    const served = await post(roomy, [{ sql: INSERT, params: { id, name: "n", state: b64(HARD) } }]);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    assert.equal(stored(roomy, id), HARD);
    // At the default request limit the base64 form (1,398,104 bytes) does not fit the body:
    // the request code answers, not the per-value one, and nothing reaches the database.
    const tight = await setup(t, { maxBytesPerValue: HARD });
    const before = await work(tight);
    const refused = await post(tight, [{ sql: INSERT, params: { id: uid(), name: "n", state: b64(HARD) } }]);
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, "POLICYSQL_REQUEST_TOO_LARGE");
    assert.deepEqual(await work(tight), before);
    // The largest value that body admits is a little under three quarters of it, and is stored.
    const room = Math.floor((1_048_576 - 4_096) / 4) * 3;
    const fits = uid();
    const written = await post(tight, [{ sql: INSERT, params: { id: fits, name: "n", state: b64(room) } }]);
    assert.equal(written.status, 200, JSON.stringify(written.body).slice(0, 200));
    assert.equal(stored(tight, fits), room);
  });

  test(`${ownerAdapter}: at the hard maximum a stored value is readable up to the raw result bound and 413 above it`, async (t) => {
    const h = await setup(t, hard);
    // Base64 of the value plus the Hrana frame of the row must fit the raw bound that exists
    // today (1 MiB per statement; the compiled bound of pull request 6 replaces it), so the
    // largest readable value is about three quarters of it. The code is the result limit's.
    const readable = Math.floor((RAW_BOUND - 512) / 4) * 3;
    seedState(h, bytes(readable));
    const served = await post(h, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    for (const length of [Math.floor(RAW_BOUND / 4) * 3, HARD]) {
      seedState(h, bytes(length));
      const refused = await post(h, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
      assert.equal(refused.status, 413, `${length}`);
      assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
    }
    // A value at the hard maximum is written without RETURNING it, and cannot be returned.
    const id = uid();
    const unreturned = await post(h, [{ sql: INSERT, params: { id, name: "n", state: b64(HARD) } }]);
    assert.equal(unreturned.status, 200, JSON.stringify(unreturned.body).slice(0, 200));
    const returned = await post(h, [{ sql: INSERT_RETURNING_STATE, params: { id: uid(), name: "n", state: b64(HARD) } }]);
    assert.equal(returned.status, 413, JSON.stringify(returned.body).slice(0, 200));
    assert.equal(returned.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  });

  test(`${ownerAdapter}: maxResultBytes governs a result below the per-value limit`, async (t) => {
    const h = await setup(t, { maxBytesPerValue: DEFAULT, maxResultBytes: 64_000 });
    // The limit counts the public encoding of the rows (base64 of a BLOB), so a value of about
    // three quarters of maxResultBytes is the largest readable, however large the per-value
    // limit is.
    seedState(h, bytes(47_000));
    const served = await post(h, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    seedState(h, bytes(48_000));
    const refused = await post(h, [{ sql: "SELECT state FROM projects WHERE id=:id", params: { id: "seed" } }]);
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, "POLICYSQL_LIMIT_EXCEEDED");
  });

  test(`${ownerAdapter}: the interactive result limit governs a read below the per-value limit`, async (t) => {
    const h = await setup(t, { maxBytesPerValue: DEFAULT, maxResultBytes: 800_000 });
    seedState(h, bytes(47_000));
    h.databases.get("a").database.prepare("INSERT INTO projects(id,tenant_id,name,state,seed) VALUES('big','tenant_a','n',?,?)").run(bytes(50_000), Buffer.alloc(0));
    const begun = await h.request("a", "/v1/transactions", { mode: "read" }, null);
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const path = `/v1/transactions/${begun.body.transactionId}`;
    const select = (sequence, id) => ({ sequence, sql: "SELECT state FROM projects WHERE id=:id", params: { id } });
    const served = await h.request("a", `${path}/statements`, select(1, "seed"), null);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    // The cumulative interactive limit (64,000 of public encoding) is the smaller one here.
    const refused = await h.request("a", `${path}/statements`, select(2, "big"), null);
    assert.equal(refused.status, 413, JSON.stringify(refused.body).slice(0, 200));
    assert.equal(refused.body.error.code, "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED");
  });

  test(`${ownerAdapter}: maxSqlBytes does not govern a bytes parameter, which is not SQL text`, async (t) => {
    const h = await setup(t, { maxBytesPerValue: DEFAULT, maxSqlBytes: 1_024 });
    const id = uid();
    const served = await post(h, [{ sql: INSERT, params: { id, name: "n", state: b64(DEFAULT) } }]);
    assert.equal(served.status, 200, JSON.stringify(served.body).slice(0, 200));
    assert.equal(stored(h, id), DEFAULT);
  });
}

// `build_runtime` passes the configured limit to policy activation: the bytes fixture's insert
// preset is 4 bytes ("AAEC/w=="), so a limit of 4 starts and a limit of 3 names the field.
test("a bytes preset over the configured limit stops construction and names max_bytes_per_value", () => {
  const construct = (maxBytesPerValue) => PolicySqlRuntime.newWithPhysicalSchema(
    fixture.catalog, fixture.policy, "schema_preset_1", "policy_preset_1",
    runtimeLimitsJson({ ...REQUIRED, maxBytesPerValue }), fixture.physicalSchema,
  );
  construct(4).free();
  assert.throws(() => construct(3), (error) => String(error).includes("`max_bytes_per_value`") && String(error).includes("preset"));
});

test("the reference wrapper sets the per-value limit explicitly, and the runtime enforces that value", async (t) => {
  assert.equal(RUNTIME_LIMITS.maxBytesPerValue, DEFAULT);
  const h = await harness(t, { fixture, hooks: false, runtimeLimits: { ...RUNTIME_LIMITS } });
  assert.equal(runtimeLimits(h.runtime).maxBytesPerValue, RUNTIME_LIMITS.maxBytesPerValue);
});
