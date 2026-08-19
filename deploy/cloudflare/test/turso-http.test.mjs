import test from "node:test";
import assert from "node:assert/strict";
import { TursoHttpTransport } from "../src/turso-http.ts";

const result = (columns, rows, usage = {}) => ({
  type: "ok",
  response: {
    type: "execute",
    result: {
      cols: columns.map((name) => ({ name, decltype: "TEXT" })),
      rows: rows.map((row) => row.map((value) => ({ type: "text", value }))),
      affected_row_count: 0,
      rows_read: usage.rowsRead ?? rows.length,
      rows_written: usage.rowsWritten ?? 0,
      query_duration_ms: usage.queryDurationMs ?? 1,
    },
  },
});

test("decodes exact usage metrics while preserving transaction ownership", async () => {
  const requests = [];
  const fetchImpl = async function (_url, init) {
    assert.equal(this, undefined, "host fetch must not be invoked as a transport method");
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.requests[0].stmt?.sql.startsWith("BEGIN")) {
      return new Response(JSON.stringify({ baton: "baton_1", results: [result([], [])] }));
    }
    if (body.requests[0].stmt?.sql === "COMMIT") {
      return new Response(JSON.stringify({
        baton: null,
        results: [result([], []), { type: "ok", response: { type: "close" } }],
      }));
    }
    return new Response(JSON.stringify({
      baton: "baton_2",
      results: [result(["id"], [["p1"]], { rowsRead: 12, queryDurationMs: 2.5 })],
    }));
  };
  const transport = new TursoHttpTransport(
    { TURSO_DATABASE_URL: "https://db.test", TURSO_AUTH_TOKEN: "secret" },
    "req_1",
    fetchImpl,
  );
  const transaction = await transport.begin("read", 1000);
  const output = await transaction.execute([{ sql: "SELECT id FROM projects", args: {} }]);
  await transaction.commit();
  assert.equal(output[0].usage.rowsRead, 12);
  assert.equal(requests[1].baton, "baton_1");
  assert.equal(requests[2].baton, "baton_2");
});

test("rejects missing per-query billing metrics", async () => {
  const transport = new TursoHttpTransport(
    { TURSO_DATABASE_URL: "https://db.test", TURSO_AUTH_TOKEN: "secret" },
    "req_1",
    async () => new Response(JSON.stringify({
      baton: "baton",
      results: [{
        type: "ok",
        response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 0 } },
      }],
    })),
  );
  await assert.rejects(transport.begin("read", 1000), (error) => error.code === "POLICYSQL_DATABASE_UNAVAILABLE");
});
