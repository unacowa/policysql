import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Kysely } from "kysely";
import { PolicySqlClient } from "./index.js";
import { PolicySqlDialect } from "../kysely/index.js";

const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/bytes-contract.json", import.meta.url), "utf8"));
const descriptor = { name: "state", type: "bytes", representation: "string", format: "base64", nullable: true };

// This is a protocol fixture: no gateway runtime, WASM, hosting API or DB driver.
for (const value of [...fixture.valid.map(c => c.base64), null]) test(`Client and Kysely preserve public bytes through a function Transport: ${JSON.stringify(value)}`, async t => {
  const requests = [];
  const client = new PolicySqlClient({ transport: async request => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert.equal(request.kind, "execute");
    assert.equal(Object.values(body.statements[0].params)[0], value);
    return { status: 200, body: { status: "committed", results: [{
      columns: ["state"], rows: [{ state: value }], rowCount: 1, affectedRows: 1,
      meta: { result: { columns: [descriptor], redactions: [] } },
    }], meta: {} } };
  } });
  const result = await client.execute("INSERT INTO chunks(state) VALUES(:state) RETURNING state", { state: value });
  assert.equal(result.rows[0].state, value);
  assert.deepEqual(result.meta.result.columns, [descriptor]);
  const db = new Kysely({ dialect: new PolicySqlDialect({ client }) });
  t.after(() => db.destroy());
  assert.deepEqual(await db.insertInto("chunks").values({ state: value }).returning("state").execute(), [{ state: value }]);
  assert.equal(requests.length, 2);
  await assert.rejects(client.execute("INSERT INTO chunks(state) VALUES(:state)", { state: new Uint8Array([0, 255]) }), TypeError);
  assert.equal(requests.length, 2, "binary conveniences must explicitly encode the common JSON contract");
});
